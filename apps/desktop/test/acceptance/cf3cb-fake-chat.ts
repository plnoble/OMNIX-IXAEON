/**
 * CF3cb：共用的假模型客户端（测试专用，不是 .test.ts）。
 *
 * 只模拟「模型怎么回答」——不替生产补回 CF3c 删掉的任何东西，也不替用户建任务。
 */
import { Buffer } from 'node:buffer';
import type { ChatStreamResult, StreamChatClient } from '@ixaeon/core';

export type FakeStreamImpl = (input: {
  messages: Array<{ role: string; content: string }>;
  lastUser: string;
  call: number;
  onDelta?: (t: string) => void;
  signal?: AbortSignal;
}) => Partial<ChatStreamResult> | Promise<Partial<ChatStreamResult>>;

const CHAT_KEY_B64 = Buffer.from('enc:sk-synthetic').toString('base64');

export function fakeChatClient(impl: FakeStreamImpl): StreamChatClient {
  let call = 0;
  return {
    modelName: 'demo-a',
    async stream(input) {
      const messages = (input.messages ?? []).map((m) => ({
        role: String(m.role ?? ''),
        content: String(m.content ?? ''),
      }));
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const r = await impl({
        messages,
        lastUser: last?.content ?? '',
        call: call++,
        onDelta: input.onDelta,
        signal: input.signal,
      });
      const content = r.content ?? '';
      if (input.onDelta && content && !(r.toolCalls && r.toolCalls.length)) input.onDelta(content);
      return {
        content,
        toolCalls: r.toolCalls ?? [],
        finishReason: r.finishReason ?? 'stop',
        toolsUnsupported: r.toolsUnsupported ?? false,
      };
    },
  };
}

export function fakeChatModel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelName: 'demo-a',
    chatModelName: '',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKeyEncrypted: CHAT_KEY_B64,
    apiKeyPresent: true,
    savedModels: ['demo-a'],
    ...over,
  };
}

export function installFakeChat(
  runtime: Record<string, unknown>,
  impl: FakeStreamImpl,
): StreamChatClient {
  const client = fakeChatClient(impl);
  runtime['chatStreamClient'] = () => client;
  const cfg = (runtime['config'] as Record<string, unknown> | undefined) ?? {};
  runtime['config'] = {
    ...cfg,
    model: fakeChatModel((cfg['model'] as Record<string, unknown> | undefined) ?? {}),
  };
  return client;
}
