/**
 * K4：驾驶舱的额度来源（规格 docs/委派/K4-额度与项目活动.md）。
 * QuotaHub 只在用户填了 `cockpit.quotahub_url` 时启用：只认「http + 本机主机 + 端口」，
 * 路径写死 `/api/snapshots`，超时 3 秒；带路径、查询、用户名密码、别的主机、https、
 * 没写端口的一律拒绝且不发请求。手动登记坏了当没有、记 error、不抛错。
 */
import { z } from 'zod';
import type * as C from '@ixaeon/contracts';
import { manualQuotaSchema } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { getSetting } from '../settings.js';

const QUOTA_URL = 'cockpit.quotahub_url';
const MANUAL_QUOTAS = 'cockpit.manual_quotas';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** 手动登记表单的序列化形状与设置页共用（契约里的 `manualQuotaSchema`）。 */
const manualQuotasSchema = z.array(manualQuotaSchema);

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** 只接受「协议 + 本机主机 + 端口」，且不许带路径、查询、片段、用户名密码。 */
export function checkQuotaHubUrl(raw: string): { base?: string; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'QuotaHub 地址不是合法网址' };
  }
  if (url.protocol !== 'http:') return { reason: 'QuotaHub 地址只认 http://' };
  if (!LOCAL_HOSTS.has(url.hostname)) return { reason: 'QuotaHub 地址只认本机' };
  if (!url.port) return { reason: 'QuotaHub 地址要写端口' };
  if (url.username || url.password) return { reason: 'QuotaHub 地址不能带用户名密码' };
  if (url.pathname !== '/' || url.search || url.hash)
    return { reason: 'QuotaHub 地址不能带路径、查询或片段' };
  return { base: `http://${url.hostname}:${url.port}` };
}

/** 把 `accounts[]` 映射成契约字段；cookie / token / remaining_percent 等都不取。 */
function mapAccounts(body: unknown, now: Date): C.QuotaCard[] {
  const accounts = record(body).accounts;
  if (!Array.isArray(accounts)) throw new Error('返回里没有 accounts 列表');
  return accounts.map((item) => {
    const a = record(item);
    const plan = record(a.plan);
    const windows = Array.isArray(a.quota_windows) ? a.quota_windows : [];
    return {
      source: 'quotahub' as const,
      provider: text(a.provider) ?? '',
      account: text(a.account_name) ?? text(a.account) ?? '',
      status: text(a.status) ?? 'unknown',
      plan: text(plan.name),
      expiresAt: text(plan.expires_at),
      windows: windows.map((w) => {
        const win = record(w);
        return {
          name: text(win.name) ?? '',
          usedPercent: num(win.used),
          resetAt: text(win.reset_at),
        };
      }),
      collectedAt: text(a.collected_at) ?? now.toISOString(),
    };
  });
}

async function readQuotaHub(
  base: string,
  now: Date,
): Promise<{ cards: C.QuotaCard[]; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  timer.unref?.();
  try {
    const res = await fetch(`${base}/api/snapshots`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { cards: [], error: `QuotaHub 返回 HTTP ${res.status}` };
    try {
      return { cards: mapAccounts(await res.json(), now), error: null };
    } catch {
      return { cards: [], error: 'QuotaHub 返回的不是 JSON' };
    }
  } catch (err) {
    return {
      cards: [],
      error: `读不到 QuotaHub：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function readManual(raw: string): { cards: C.QuotaCard[]; error: string | null } {
  if (!raw.trim()) return { cards: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { cards: [], error: '手动额度设置不是有效 JSON' };
  }
  const checked = manualQuotasSchema.safeParse(parsed);
  if (!checked.success) {
    return {
      cards: [],
      error: `手动额度设置格式不对：${checked.error.issues[0]?.message ?? '校验失败'}`,
    };
  }
  return {
    cards: checked.data.map((e) => ({
      source: 'manual' as const,
      provider: 'manual',
      account: e.account,
      status: 'manual',
      plan: null,
      expiresAt: e.expiresAt ?? null,
      windows: [{ name: e.window, usedPercent: null, resetAt: e.resetAt ?? null }],
      collectedAt: e.registeredAt,
    })),
    error: null,
  };
}

export async function readQuotas(
  db: CoreDatabase,
  now: Date,
): Promise<{ health: C.SourceHealth; cards: C.QuotaCard[] }> {
  const readAt = now.toISOString();
  const rawUrl = (getSetting(db, QUOTA_URL)?.value ?? '').trim();
  const manual = readManual(getSetting(db, MANUAL_QUOTAS)?.value ?? '');
  const health = (status: C.SourceHealth['status'], note: string | null): C.SourceHealth => ({
    status,
    readAt,
    lastEventAt: null,
    note,
  });

  if (!rawUrl) {
    return {
      health: health(manual.error ? 'error' : 'missing', manual.error ?? '未连接 QuotaHub'),
      cards: manual.cards,
    };
  }
  const checked = checkQuotaHubUrl(rawUrl);
  if (!checked.base) {
    return {
      health: health('error', manual.error ?? checked.reason ?? 'QuotaHub 地址被拒绝'),
      cards: manual.cards,
    };
  }
  const hub = await readQuotaHub(checked.base, now);
  const notes = [manual.error, hub.error].filter(Boolean).join('；');
  return {
    health: health(notes ? 'error' : 'ok', notes || null),
    cards: [...hub.cards, ...manual.cards],
  };
}
