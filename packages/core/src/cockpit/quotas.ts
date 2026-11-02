/**
 * SUB1b：驾驶舱额度从本机 magpie 的 `GET /v1/magpie/quotas/cards` 读（默认
 * http://127.0.0.1:3425，设置项 `cockpit.magpie_url` 可改）：只认 http + 本机主机 + 端口，
 * 路径写死，超时 3 秒；别的主机、https、带路径 / 查询 / 用户名密码、没写端口的一律拒绝且不发请求。
 * 连不上记 missing（note「没连上 magpie」），其它错误记 error；手动登记照留、坏了不抛错。
 */
import { z } from 'zod';
import type * as C from '@ixaeon/contracts';
import { ErrorCodes, IxaError, manualQuotaSchema } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { getSetting } from '../settings.js';

const MAGPIE_URL = 'cockpit.magpie_url';
const MANUAL_QUOTAS = 'cockpit.manual_quotas';
const DEFAULT_MAGPIE = 'http://127.0.0.1:3425';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const READ_TIMEOUT_MS = 3_000;
const REFRESH_TIMEOUT_MS = 10_000;
const REFRESH_MIN_GAP_MS = 30_000;

/** 手动登记表单的序列化形状与设置页共用（契约里的 `manualQuotaSchema`）。 */
const manualQuotasSchema = z.array(manualQuotaSchema);

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** 只接受「协议 + 本机主机 + 端口」，且不许带路径、查询、片段、用户名密码。空 = 默认地址。 */
export function checkMagpieUrl(raw: string): { base?: string; reason?: string } {
  if (!raw.trim()) return { base: DEFAULT_MAGPIE };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { reason: 'magpie 地址不是合法网址' };
  }
  if (url.protocol !== 'http:') return { reason: 'magpie 地址只认 http://' };
  if (!LOCAL_HOSTS.has(url.hostname)) return { reason: 'magpie 地址只认本机' };
  if (!url.port) return { reason: 'magpie 地址要写端口' };
  if (url.username || url.password) return { reason: 'magpie 地址不能带用户名密码' };
  if (url.pathname !== '/' || url.search || url.hash)
    return { reason: 'magpie 地址不能带路径、查询或片段' };
  return { base: `http://${url.hostname}:${url.port}` };
}

/**
 * 窗口用量百分比：magpie 的 `used` 本身就是百分比（本机实测 `used: 10.13, limit: 6900,
 * display: "699.25 / 6900"`，699.25 / 6900 = 10.13%），不拿 `limit` 去除；不是数 = null。
 */
function usedPercentOf(win: Record<string, unknown>): number | null {
  return num(win.used);
}

/**
 * 映射到 K4 的 `QuotaCard`（只含规格列出的字段）。`user`、`icon`、`daily` 不进快照：
 * `user` 多半是邮箱，快照还会经 K5 发到手机。
 */
function mapCards(body: unknown, now: Date): C.QuotaCard[] {
  const cards = record(body).data;
  if (!Array.isArray(cards)) throw new Error('返回里没有卡片列表');
  return cards.map((item) => {
    const card = record(item);
    const windows = Array.isArray(card.windows) ? card.windows : [];
    return {
      source: 'magpie' as const,
      provider: text(card.provider) ?? '',
      account: text(card.name) ?? '',
      status: 'ok',
      plan: text(card.plan),
      expiresAt: null,
      windows: windows.map((w) => {
        const win = record(w);
        return {
          name: text(win.name) ?? '',
          usedPercent: usedPercentOf(win),
          resetAt: text(win.resetsAt),
          display: text(win.display),
        };
      }),
      collectedAt: text(card.readAt) ?? now.toISOString(),
    };
  });
}

interface MagpieRead {
  cards: C.QuotaCard[];
  error: string | null;
  /** 请求发出去了、但 magpie 没回好（HTTP / JSON 错误）——false 表示没连上。 */
  reachable: boolean;
}

async function readMagpie(base: string, now: Date): Promise<MagpieRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${base}/v1/magpie/quotas/cards`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Bearer magpie' },
      // 不跟跳转：本机服务回一个 30x 指到外网，跟过去就是一次外发。
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return { cards: [], error: `magpie 返回 HTTP ${res.status}`, reachable: true };
    try {
      return { cards: mapCards(await res.json(), now), error: null, reachable: true };
    } catch {
      return { cards: [], error: 'magpie 返回的不是 JSON 或格式不对', reachable: true };
    }
  } catch (err) {
    // 只有「连不上」（端口上没人听、主机不可达）才算 magpie 没开 = missing；
    // 超时、被跳转（redirect: 'error'）、对面中途断开都是「连上了但不对劲」= error。
    return refused(err)
      ? { cards: [], error: '没连上 magpie', reachable: false }
      : { cards: [], error: 'magpie 没有正常回答（超时、被跳转或中途断开）', reachable: true };
  } finally {
    clearTimeout(timer);
  }
}

const NOT_LISTENING = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

function refused(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && NOT_LISTENING.has(code);
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
      windows: [{ name: e.window, usedPercent: null, resetAt: e.resetAt ?? null, display: null }],
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
  const rawUrl = (getSetting(db, MAGPIE_URL)?.value ?? '').trim();
  const manual = readManual(getSetting(db, MANUAL_QUOTAS)?.value ?? '');
  const health = (status: C.SourceHealth['status'], note: string | null): C.SourceHealth => ({
    status,
    readAt,
    lastEventAt: null,
    note,
  });

  const checked = checkMagpieUrl(rawUrl);
  if (!checked.base) {
    return {
      health: health('error', checked.reason ?? 'magpie 地址被拒绝'),
      cards: manual.cards,
    };
  }
  const magpie = await readMagpie(checked.base, now);
  const notes = [manual.error, magpie.error].filter(Boolean).join('；');
  // 手动登记坏了是配置错误，不能被「magpie 没开」的 missing 盖住。
  const status: C.SourceHealth['status'] =
    manual.error || (magpie.error && magpie.reachable) ? 'error' : magpie.error ? 'missing' : 'ok';
  return {
    health: health(status, notes || null),
    cards: [...magpie.cards, ...manual.cards],
  };
}

/** 上一次真的发出刷新请求的时刻（模块级，30 秒内连点只发一次）。 */
let lastRefreshAt = 0;

export async function refreshMagpieQuotas(
  db: CoreDatabase,
  now: Date = new Date(),
): Promise<{ ok: true }> {
  const rawUrl = (getSetting(db, MAGPIE_URL)?.value ?? '').trim();
  const checked = checkMagpieUrl(rawUrl);
  if (!checked.base) throw new IxaError(ErrorCodes.VALIDATION_FAILED, checked.reason!);
  if (now.getTime() - lastRefreshAt < REFRESH_MIN_GAP_MS) return { ok: true };
  lastRefreshAt = now.getTime();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${checked.base}/v1/magpie/quotas/refresh`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: 'Bearer magpie',
      },
      body: '{}',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok)
      throw new IxaError(ErrorCodes.SERVER_UNAVAILABLE, `magpie 返回 HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof IxaError) throw err;
    throw new IxaError(ErrorCodes.SERVER_UNAVAILABLE, '没连上 magpie');
  } finally {
    clearTimeout(timer);
  }
}
