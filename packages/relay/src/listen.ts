/**
 * L16 契约第 4 条：`relay listen [--bind] [--under <pid>]`。
 *
 * - 连上后打一行 `收听中`；认的消息 → 记进 `inbox.jsonl`（同一个 id 只记一次）→
 *   往群里发 `收到：<text 前 50 个字>。下一棒交给整合方。`；不认 → 打 `没理：<why>`，不发。
 * - `--bind`：不看 `chatId` / `ownerOpenId`，第一条群里 @ 机器人的文字消息 → 把群号、人写进
 *   `feishu-app.json`（别的字段原样保留），打 `绑好了`、发 `绑好了：…`，退出码 0。
 * - 没带 `--bind`、`chatId` 或 `ownerOpenId` 没有 → 打 `还没绑定：先跑 relay listen --bind`，退出码 2。
 * - `--under <pid>`：看门人起的收听。看门人没了就自己退（不留孤儿）。
 *
 * 收发都可能走过真 HTTPS：结尾一律用 `process.exitCode` 自然退出，不调 `process.exit`
 * （这台机器上 jiti + 真 TLS 之后强退会崩，见 L5 的教训）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeishuTarget, sendFeishu } from './notify/feishu.js';
import {
  acceptMessage,
  appendInbox,
  chatAndSender,
  loadFeishuApp,
  redact,
  underAlive,
} from './notify/inbox.js';
import type { EventSource } from './notify/lark-source.js';
import { pathToFileURL } from 'node:url';

type SourceModule = {
  startEventSource(
    onEvent: (event: unknown) => Promise<void> | void,
    opts: { appId: string; appSecret: string },
  ): Promise<EventSource>;
};

const BIND_REPLY = '绑好了：以后只听你在这个群里 @ 我说的话。';
// 按字（不是 UTF-16 码元）取前 50 个；截断了用「……」接下文，免得回执像话没说完（用户 2026-10-31 定）。
const replyText = (text: string): string => {
  const chars = [...text];
  const head = chars.slice(0, 50).join('');
  return chars.length > 50
    ? `收到：${head}……下一棒交给整合方。`
    : `收到：${head}。下一棒交给整合方。`;
};

export async function listenCommand(opts: {
  dataDir: string;
  bind: boolean;
  under: number | null;
}): Promise<void> {
  const app = loadFeishuApp(join(opts.dataDir, 'feishu-app.json'));
  if (!app) {
    console.log('没配：feishu-app.json 里要有 appId 和 appSecret');
    process.exitCode = 2;
    return;
  }
  if (!opts.bind && (!app.chatId || !app.ownerOpenId)) {
    console.log('还没绑定：先跑 relay listen --bind');
    process.exitCode = 2;
    return;
  }
  if (opts.under !== null && !underAlive(opts.under)) return; // 看门人已经没了，不用起

  const target = loadFeishuTarget();
  const send = async (text: string): Promise<void> => {
    if (!target) return;
    const r = await sendFeishu(text, target);
    if (!r.ok) console.log(`没发成：${redact(r.error, [app.appSecret])}`);
  };

  // 测试用：IXAEON_RELAY_EVENT_SRC 指向一个导出 startEventSource 的模块（假的事件源）
  const src = process.env.IXAEON_RELAY_EVENT_SRC?.trim();
  const mod: SourceModule = src
    ? ((await import(pathToFileURL(src).href)) as SourceModule)
    : await import('./notify/lark-source.js');

  let bound = false;
  let stopper: EventSource | null = null;
  const onEvent = async (event: unknown): Promise<void> => {
    // --bind：拿「事件自己的群/人」当绑定字段喂给 acceptMessage——群聊、@ 机器人、文字这几道照过，
    // 是哪个群、哪个人就绑哪个（别的群、别人、没 @ 的到这儿都会被拒，跳过不算）。
    const verdict = opts.bind
      ? (() => {
          const who = chatAndSender(event);
          return acceptMessage(event, { chatId: who.chatId, ownerOpenId: who.openId });
        })()
      : acceptMessage(event, app);
    if (!verdict.ok) {
      console.log(`没理：${verdict.why}`);
      return;
    }
    if (opts.bind) {
      const who = chatAndSender(event);
      const file = join(opts.dataDir, 'feishu-app.json');
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      raw.chatId = who.chatId;
      raw.ownerOpenId = who.openId;
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      console.log('绑好了');
      await send(BIND_REPLY);
      bound = true;
      process.exitCode = 0;
      stopper?.stop();
      return;
    }
    // 同一个 id 已经有了：不多记、不再回
    if (!appendInbox(opts.dataDir, { id: verdict.id, text: verdict.text })) return;
    await send(replyText(verdict.text));
  };

  // 起源（不 await：连上之后它自己挂着）；连接层的报错（SDK 的报错可能带凭据）遮掉再打
  mod
    .startEventSource(onEvent, { appId: app.appId, appSecret: app.appSecret })
    .then((s) => {
      stopper = s;
      if (bound) stopper?.stop();
    })
    .catch((e: unknown) => {
      console.error(
        `收听起不来：${redact(e instanceof Error ? e.message : String(e), [app.appSecret])}`,
      );
      process.exitCode = 1;
    });
  console.log('收听中');
  if (opts.under !== null) {
    // 看门人没了就该退：每半分钟查一次，用 exitCode 自然退出
    const timer = setInterval(() => {
      if (opts.under !== null && !underAlive(opts.under)) {
        clearInterval(timer);
        stopper?.stop();
        process.exitCode = 0;
      }
    }, 30_000);
    timer.unref?.();
  }
}
