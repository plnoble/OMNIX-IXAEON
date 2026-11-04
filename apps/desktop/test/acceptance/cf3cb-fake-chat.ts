/**
 * CF3cb：共用假模型客户端（测试专用，不是 .test.ts）。
 *
 * CF3c 起聊天只走直连，模型通道从 `AppRuntime.chatStreamClient(launch)` 拿。旧的锁定验收测试
 * 大多借「往 askSessions 塞一个 { run: async () => ({ answer }) } 替身」当假模型通道；这里把那种替身
 * 原样转接到直连接缝上，测试主体与断言不用改：
 *
 * - 调用后给 runtime 挂一个测试专用 `askSessions`（普通 Map，不是 AppRuntime 的字段），测试里
 *   `runtime.askSessions.set(convId, 替身)` / `.get` / `.size` 照旧能用；
 * - `runtime.chatStreamClient()` 返回一个假客户端：每次 `stream()` 取「最近放进去的那个替身」，
 *   调它的 `run()` 拿 `{ answer, ... }`，把 answer 作为正文吐出去（替身自己调过 onDelta 就不重复吐）；
 * - 顺带把 `config.model` 补成三样齐（模型 / 地址 / Key），否则直连会如实拒绝。
 *
 * 只在 CF3c 撞红的旧验收测试里用，整合方会和改写的测试一起锁定。
 */
import { Buffer } from 'node:buffer';

type SessionLike = {
  run?: (input: {
    goal?: string;
    question?: string;
    onDelta?: (t: string) => void;
    onProgress?: (p: string) => void;
    [k: string]: unknown;
  }) => Promise<unknown> | unknown;
  cancel?: (runId?: string) => void;
  invalidateContext?: (ctx?: string) => void;
  getEngineSessionId?: () => string;
  [k: string]: unknown;
};

type RuntimeLike = Record<string, unknown>;

const CHAT_KEY_B64 = Buffer.from('enc:sk-synthetic').toString('base64');

function lastUserText(messages: Array<{ role?: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content ?? '');
  }
  return '';
}

/**
 * 给一个用 Object.create(AppRuntime.prototype) 造的 runtime 挂上假聊天通道。
 * 返回它内部那个 Map，方便个别测试直接拿到。
 */
export function installFakeChat(runtime: RuntimeLike): Map<string, SessionLike> {
  const sessions = new Map<string, SessionLike>();
  runtime['askSessions'] = sessions;

  const used = new Set<SessionLike>();
  const client = {
    modelName: 'demo-a',
    stream: async (input: {
      messages: Array<{ role?: string; content?: string }>;
      onDelta?: (t: string) => void;
      [k: string]: unknown;
    }) => {
      const list = [...sessions.values()];
      // 多个对话时按「插入顺序、每个只用一次」取，轮流对应各自的会话
      let session = list.find((s) => !used.has(s));
      if (!session) session = list[list.length - 1];
      if (session) used.add(session);
      const question = lastUserText(input.messages ?? []);
      let emitted = false;
      const onDelta = (t: string): void => {
        emitted = true;
        input.onDelta?.(t);
      };
      let result: Record<string, unknown> = { answer: '' };
      if (session?.run) {
        const out = await session.run({
          goal: question,
          question,
          onDelta,
          onProgress: () => undefined,
        });
        if (out && typeof out === 'object') result = out as Record<string, unknown>;
      }
      const content = String(result['answer'] ?? '');
      if (!emitted && content.length > 0) input.onDelta?.(content);
      return { content, toolCalls: [], finishReason: 'stop', toolsUnsupported: false };
    },
  };
  runtime['chatStreamClient'] = () => client;

  // 三样齐：模型 / 地址 / Key（保留测试自己设的其它字段）
  const cfg = (runtime['config'] as Record<string, unknown> | undefined) ?? {};
  const model = (cfg['model'] as Record<string, unknown> | undefined) ?? {};
  runtime['config'] = {
    ...cfg,
    model: {
      modelName: 'demo-a',
      chatModelName: '',
      apiBaseUrl: 'http://127.0.0.1:18081/v1',
      apiKeyEncrypted: CHAT_KEY_B64,
      apiKeyPresent: true,
      savedModels: ['demo-a'],
      ...model,
    },
  };
  return sessions;
}
