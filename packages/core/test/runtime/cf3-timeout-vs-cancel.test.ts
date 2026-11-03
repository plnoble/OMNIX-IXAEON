/**
 * CF3 复审后的自有回归（不是锁定验收，放 test/runtime/）：
 *
 * 1. **超时不是取消**：timeoutMs 设很小、假流一直不结束 → `runDirectChat` 返回
 *    `status: 'failed'`（failure 里写着超时），**不是** `cancelled`。
 *    这一条钉住 chatStream 的 request()：只有 input.signal 被 abort 才算取消。
 * 2. **不按报错文字猜取消**：网关 500、正文里写着 cancelled → 返回 `failed`。
 *    这一条钉住 runDirectChat 的 isAbort：只认 `error.name === 'AbortError'`。
 *
 * 不联网：假 fetch 返回内存里的流。合成数据。
 */
import { describe, expect, it } from 'vitest';
import {
  OpenAIChatStreamClient,
  runDirectChat,
  type ChatToolDef,
  type DirectChatTools,
} from '../../src/index.js';

const KEY = 'sk-synthetic';
const MODEL = 'demo-a';
const TOOL_DEFS: ChatToolDef[] = [
  { name: 'search_memory', description: '查用户的记忆', parameters: { type: 'object' } },
];

function tools(): DirectChatTools {
  return { defs: TOOL_DEFS, call: async () => ({ ok: true, content: '' }) };
}

function client(fetchImpl: typeof fetch, timeoutMs: number): OpenAIChatStreamClient {
  return new OpenAIChatStreamClient({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: KEY,
    model: MODEL,
    fetchImpl,
    timeoutMs,
  });
}

describe('CF3 复审回归：超时与取消必须分开', () => {
  it('超时 → failed（failure 含超时），不是 cancelled', async () => {
    const enc = new TextEncoder();
    // 先吐一段正文，然后一直不结束：只有超时能让它停
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'));
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* 已关闭就忽略 */
            }
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const result = await runDirectChat({
      client: client(fetchImpl, 30),
      question: '合成问题',
      priorTurns: [],
      contextBlock: '',
      preMemoryUsed: [],
      tools: tools(),
    });

    expect(result.status).toBe('failed');
    expect(result.failure ?? '').toContain('超时');
    expect(result.failure ?? '').not.toContain('取消');
  });

  it('网关 500、正文写着 cancelled → failed，不算取消', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'upstream request cancelled' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const result = await runDirectChat({
      client: client(fetchImpl, 5_000),
      question: '合成问题',
      priorTurns: [],
      contextBlock: '',
      preMemoryUsed: [],
      tools: tools(),
    });

    expect(result.status).toBe('failed');
    expect(result.failure ?? '').toContain('500');
  });
});
