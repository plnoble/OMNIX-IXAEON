/**
 * L16：用户在飞书里回复，调度器收得到。
 *
 * 契约第 1 条：凭据文件 `<数据目录>/feishu-app.json`。契约第 3 条：`acceptMessage` 认不认这条消息。
 * 另带收听要用的两个小工具：追加 `inbox.jsonl`（同一个 id 只记一次）、算还没办的，以及把密钥从报错里遮掉。
 * `why` 一律不带消息内容。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relayDir } from '../datadir.js';

export interface FeishuApp {
  appId: string;
  appSecret: string;
  chatId?: string;
  ownerOpenId?: string;
}

export interface InboxMessage {
  id: string;
  at: string;
  text: string;
}

/** 凭据文件：不在、不是 JSON、缺 `appId` / `appSecret` → 当没配（null），不抛错。记事本存的 BOM 也认。 */
export function loadFeishuApp(path?: string): FeishuApp | null {
  const file = path ?? join(relayDir(), 'feishu-app.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Partial<FeishuApp>;
    if (typeof raw.appId !== 'string' || !raw.appId) return null;
    if (typeof raw.appSecret !== 'string' || !raw.appSecret) return null;
    const app: FeishuApp = { appId: raw.appId, appSecret: raw.appSecret };
    if (typeof raw.chatId === 'string' && raw.chatId) app.chatId = raw.chatId;
    if (typeof raw.ownerOpenId === 'string' && raw.ownerOpenId) app.ownerOpenId = raw.ownerOpenId;
    return app;
  } catch {
    return null;
  }
}

/** 事件体可能是完整信封 `{header, event}`，也可能就是事件本身——两种都接。 */
const envelopeOf = (event: unknown): Record<string, unknown> => {
  const e = event as { event?: unknown } | null;
  return e && typeof e === 'object' && 'event' in e && e.event
    ? (e as Record<string, unknown>)
    : ({ header: {}, event: event } as Record<string, unknown>);
};
const at = (body: Record<string, unknown>, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      body,
    );

/** 文本里的 @ 占位（`@_user_1` 这种）全部去掉，再掐首尾空白。 */
const stripMentions = (text: string): string => text.split(/@_\w+/).join('').trim();

export function acceptMessage(
  event: unknown,
  app: { chatId?: string; ownerOpenId?: string },
): { ok: true; id: string; text: string } | { ok: false; why: string } {
  const body = envelopeOf(event);
  const message = at(body, 'event.message') as Record<string, unknown> | undefined;
  const sender = at(body, 'event.sender') as Record<string, unknown> | undefined;
  if (!message || typeof message.message_id !== 'string' || !message.message_id) {
    return { ok: false, why: '不是一条带编号的消息' };
  }
  if (message.chat_type !== 'group') return { ok: false, why: '不是群聊消息' };
  // 绑定字段缺一个就不认（锁定测试定的语义）；--bind 的路走的是「事件自己的群/人当 app」。
  if (typeof app.chatId !== 'string' || !app.chatId) {
    return { ok: false, why: '还没绑定：不知道听哪个群' };
  }
  if (message.chat_id !== app.chatId) {
    return { ok: false, why: '不是绑定的那个群' };
  }
  if (typeof app.ownerOpenId !== 'string' || !app.ownerOpenId) {
    return { ok: false, why: '还没绑定：不知道听谁说的' };
  }
  const openId = at(sender ?? {}, 'sender_id.open_id');
  if (openId !== app.ownerOpenId) {
    return { ok: false, why: '不是用户本人发的' };
  }
  if (!Array.isArray(message.mentions) || message.mentions.length === 0) {
    return { ok: false, why: '没有 @ 机器人' };
  }
  if (message.message_type !== 'text') return { ok: false, why: '不是文字消息' };
  let text = '';
  try {
    const content = JSON.parse(String(message.content ?? '{}')) as { text?: unknown };
    if (typeof content.text === 'string') text = stripMentions(content.text);
  } catch {
    /* content 不是 JSON → 当空 */
  }
  if (!text) return { ok: false, why: '@ 了机器人但没说话' };
  return { ok: true, id: message.message_id, text };
}

/** 追加一条；同一个 `id` 已经有了就不记，回 false。 */
export function appendInbox(dataDir: string, message: { id: string; text: string }): boolean {
  const file = join(dataDir, 'inbox.jsonl');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as { id?: string }).id === message.id) return false;
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  appendFileSync(
    file,
    `${JSON.stringify({ id: message.id, at: new Date().toISOString(), text: message.text })}\n`,
    'utf8',
  );
  return true;
}

/** 还没办过的（`id` 不在 done 里），按文件里的先后（就是时间先后）。只看最后 200 行：太老的不再翻旧账。 */
export function pendingInbox(dataDir: string, done: string[]): InboxMessage[] {
  const file = join(dataDir, 'inbox.jsonl');
  if (!existsSync(file)) return [];
  const had = new Set(done);
  const out: InboxMessage[] = [];
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(-200);
  for (const line of lines) {
    try {
      const m = JSON.parse(line) as Partial<InboxMessage>;
      if (m.id && !had.has(m.id) && typeof m.text === 'string') {
        out.push({ id: m.id, at: m.at ?? new Date().toISOString(), text: m.text });
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/** 把密钥从报错里换掉（`<已隐藏>`）；找不到就不动。 */
export const redact = (text: string, secrets: Array<string | undefined>): string =>
  secrets
    .filter((s): s is string => !!s && s.length > 0)
    .reduce((acc, s) => acc.split(s).join('<已隐藏>'), text);

/** `--under` 的进程还在吗（收听进程用：看门人没了就该退，不留孤儿）。 */
export function underAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 绑定用：从事件里拿群号和发消息人的 open_id（拿不到就是 undefined）。 */
export function chatAndSender(event: unknown): { chatId?: string; openId?: string } {
  const body = envelopeOf(event);
  const chatId = at(body, 'event.message.chat_id');
  const openId = at(body, 'event.sender.sender_id.open_id');
  return {
    chatId: typeof chatId === 'string' && chatId ? chatId : undefined,
    openId: typeof openId === 'string' && openId ? openId : undefined,
  };
}
