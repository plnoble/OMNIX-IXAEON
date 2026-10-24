/** 飞书汇报（L3）：只发 formatEvent 拼出来的那段文字。不加依赖包。 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relayDir } from '../datadir.js';

export type RelayEvent =
  | { kind: 'stopped'; reason: string; taskId?: string; task?: string }
  | { kind: 'needs-user'; taskId: string; task: string; status: string }
  | { kind: 'paused'; role: 'integrator' | 'developer'; until: string }
  | { kind: 'idle'; why: 'queue-empty' | 'all-blocked' }
  /** L9 契约第 7 条：规划棒加了几行（按主表里的先后）。 */
  | { kind: 'planned'; rows: Array<{ no: string; task: string; status: string }> }
  /** L16 契约第 6 条：整合方办完了用户在飞书里说的那几条。 */
  | { kind: 'inbox-done'; summary: string }
  | { kind: 'daily'; date: string; turns: number; done: string[]; costUsd?: number };
export interface FeishuTarget {
  webhookUrl: string;
  secret: string;
}
export interface NotifyStore {
  sent: Record<string, string>;
}

const HEAD = '【IXAEON 接力】';
const WAITS = [2_000, 5_000];
const WINDOW = 30 * 60_000;
const IDLE = {
  'queue-empty': '队列空了，等你排新活。',
  'all-blocked': '剩下的都被依赖或暂停挡着，等你看一眼。',
};

/** ISO → 北京时间 `10月21日 04:00`。 */
const beijing = (iso: string): string => {
  const t = new Date(Date.parse(iso) + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCMonth() + 1}月${t.getUTCDate()}日 ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
};

/** 第一行固定「【IXAEON 接力】」，只用事件自己的字段。 */
export function formatEvent(e: RelayEvent): string {
  const lines = [HEAD];
  if (e.kind === 'stopped') {
    lines.push(`停下来了：${e.reason}。`);
    if (e.taskId) lines.push(`第 ${e.taskId} 行：${e.task ?? ''}`);
  } else if (e.kind === 'needs-user') {
    lines.push(`要你拍板：第 ${e.taskId} 行「${e.task}」现在是「${e.status}」。`);
  } else if (e.kind === 'paused') {
    const who = e.role === 'integrator' ? '统筹' : '开发';
    lines.push(`${who}撞上额度，歇到 ${beijing(e.until)}。`);
  } else if (e.kind === 'idle') lines.push(IDLE[e.why]);
  else if (e.kind === 'planned') {
    lines.push(`整合方排了 ${e.rows.length} 件新活：`);
    for (const r of e.rows) lines.push(`- 第 ${r.no} 行 ${r.task}（${r.status}）`);
  } else if (e.kind === 'inbox-done') {
    lines.push(`整合方处理了你的回复：${e.summary}`);
  } else {
    const done = e.done.length ? e.done.join('、') : '无';
    lines.push(`${e.date} 日报：跑了 ${e.turns} 棒，完成 ${done}。`);
    if (typeof e.costUsd === 'number') lines.push(`Claude 用量折合约 ${e.costUsd.toFixed(2)} 美元`);
  }
  return lines.join('\n');
}

/** `timestamp\\nsecret` 当密钥，对空内容做 HMAC-SHA256，再 Base64。 */
const signOf = (ts: string, secret: string) =>
  createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');

/** 遮掉地址、密钥和路径：网络错误原文常带着它们。 */
function hide(err: unknown, target: FeishuTarget): string {
  const raw = err instanceof Error ? err.message : String(err);
  let path = '';
  try {
    path = new URL(target.webhookUrl).pathname;
  } catch {
    /* 地址不合法，只遮地址和密钥 */
  }
  return [target.webhookUrl, target.secret, path]
    .filter((s) => s.length > 1)
    .reduce((text, s) => text.split(s).join('***'), raw);
}

/** HTTP 2xx 且 code 0 才算成。失败隔 2 秒、再隔 5 秒重试，不抛错。 */
export async function sendFeishu(
  text: string,
  target: FeishuTarget,
  opts?: { fetch?: typeof fetch; now?: () => Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const post = opts?.fetch ?? fetch;
  const clock = opts?.now ?? (() => new Date());
  let last = '飞书没发成';
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, WAITS[i - 1]));
    const ts = String(Math.floor(clock().getTime() / 1000));
    const body = {
      timestamp: ts,
      sign: signOf(ts, target.secret),
      msg_type: 'text',
      content: { text },
    };
    try {
      const res = await post(target.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (res.ok && json?.code === 0) return { ok: true };
      const code = json && 'code' in json ? String(json.code) : '无';
      last = `飞书回了失败（HTTP ${res.status}，code ${code}）`;
    } catch (err) {
      last = hide(err, target);
    }
  }
  return { ok: false, error: last };
}

/** kind 加 taskId / role / why。planned、daily、inbox-done 不限频；stopped 没有 taskId 时共用一键。 */
function rateKey(e: RelayEvent): string | null {
  if (e.kind === 'daily' || e.kind === 'planned' || e.kind === 'inbox-done') return null;
  if (e.kind === 'needs-user') return `needs-user ${e.taskId}`;
  if (e.kind === 'paused') return `paused ${e.role}`;
  if (e.kind === 'idle') return `idle ${e.why}`;
  return `stopped ${e.taskId ?? ''}`;
}

/** 限频记在调用方的 store 里。没配置不发；发失败不占 30 分钟。 */
export function createNotifier(
  target: FeishuTarget | null,
  store: NotifyStore,
  opts?: { fetch?: typeof fetch; now?: () => Date },
) {
  const now = opts?.now ?? (() => new Date());
  return {
    async notify(
      event: RelayEvent,
    ): Promise<{ ok: true; sent: boolean } | { ok: false; error: string }> {
      if (!target) return { ok: true, sent: false };
      const key = rateKey(event);
      const at = now();
      const seen = key ? store.sent[key] : undefined;
      if (key && seen && at.getTime() - Date.parse(seen) < WINDOW) return { ok: true, sent: false };
      const sent = await sendFeishu(formatEvent(event), target, opts);
      if (!sent.ok) return sent;
      if (key) store.sent[key] = at.toISOString();
      return { ok: true, sent: true };
    },
  };
}

/** 不在、不是 JSON、缺字段，都当没配置，不抛错。 */
export function loadFeishuTarget(path?: string): FeishuTarget | null {
  const file = path ?? join(relayDir(), 'feishu.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<FeishuTarget>;
    const url = raw.webhookUrl;
    const secret = raw.secret;
    if (typeof url === 'string' && url && typeof secret === 'string' && secret) {
      return { webhookUrl: url, secret };
    }
    return null;
  } catch {
    return null;
  }
}
