/**
 * CF3 验收（core，规格 docs/委派/CF3-直连模型做聊天主引擎.md）——条件 1–4。
 *
 * 逐条对应规格「验收条件」：
 * - 条件 1：假 SSE 服务正文分 3 段 → onDelta 按顺序收到 3 段、content 为三段拼接；
 *   请求体含 stream:true、model、messages、tools；请求头带 Authorization: Bearer <合成 Key>。
 * - 条件 2：工具调用参数分 2 段发 → toolCalls 只有 1 个，arguments 是拼完整的 JSON。
 * - 条件 3：带 tools 的请求被 400 拒绝（错误提到 tools）→ 同一轮去掉 tools 重发一次并标
 *   toolsUnsupported:true；400 但错误说的是别的（模型不存在）→ 不重发、照常报错。
 * - 条件 4：signal 中途 abort → stream() 很快结束（≤1 秒），抛出的错误能被认成取消。
 *
 * 一律不联网：假 fetch 返回内存里的 SSE 流（照 m1-streaming 的既有写法）。
 * 合成数据：模型名 demo-a、Key sk-synthetic、问题与记忆内容都是编的。
 */
import { describe, expect, it } from 'vitest';
import { OpenAIChatStreamClient, type ChatMessage, type ChatToolDef } from '../../src/index.js';

const SYNTHETIC_KEY = 'sk-synthetic';

function encoder(): TextEncoder {
  return new TextEncoder();
}

/** 把若干块按顺序交给读取方，模拟服务端推送被拆开（含被拆在两次读取之间的情况）。 */
function streamOf(chunks: string[]): Response {
  const enc = encoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function client(fetchImpl: typeof fetch): OpenAIChatStreamClient {
  return new OpenAIChatStreamClient({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: SYNTHETIC_KEY,
    model: 'demo-a',
    fetchImpl,
  });
}

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: '合成系统提示' },
  { role: 'user', content: '合成问题' },
];
const TOOLS: ChatToolDef[] = [
  {
    name: 'search_memory',
    description: '查用户的记忆',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

interface SentCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function sentCalls(fetchImplCalls: Array<[unknown, RequestInit | undefined]>): SentCall[] {
  return fetchImplCalls.map(([url, init]) => ({
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  }));
}

describe('CF3 条件 1–4：OpenAIChatStreamClient 对假 SSE 服务', () => {
  it('条件 1：正文分 3 段 → onDelta 依次收到 3 段，content 为拼接；请求体与鉴权头正确', async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return streamOf([
        'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"第三段"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ]);
    }) as typeof fetch;

    const deltas: string[] = [];
    const result = await client(fetchImpl).stream({
      messages: MESSAGES,
      tools: TOOLS,
      onDelta: (text: string) => deltas.push(text),
    });

    expect(deltas).toEqual(['第一段', '第二段', '第三段']);
    expect(result.content).toBe('第一段第二段第三段');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.toolsUnsupported).toBe(false);

    const sent = sentCalls(calls)[0]!;
    expect(sent.url).toContain('/chat/completions');
    expect(sent.headers['Authorization']).toBe(`Bearer ${SYNTHETIC_KEY}`);
    expect(sent.body['stream']).toBe(true);
    expect(sent.body['model']).toBe('demo-a');
    expect(Array.isArray(sent.body['messages'])).toBe(true);
    expect(Array.isArray(sent.body['tools'])).toBe(true);
    expect((sent.body['messages'] as ChatMessage[]).length).toBe(2);
  });

  it('条件 2：工具调用参数分 2 段发 → 只有 1 个 toolCall，arguments 拼成完整 JSON', async () => {
    const fetchImpl = (async () =>
      streamOf([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_memory","arguments":"{\\"query\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"合成问题\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      ])) as typeof fetch;

    const result = await client(fetchImpl).stream({ messages: MESSAGES, tools: TOOLS });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.id).toBe('call_1');
    expect(result.toolCalls[0]!.name).toBe('search_memory');
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ query: '合成问题' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('条件 3：400 提到 tools → 去掉 tools 重发一次并标 toolsUnsupported', async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push([url, init]);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (Array.isArray(body['tools']) && body['tools'].length > 0) {
        return new Response(
          JSON.stringify({ error: { message: 'tools is not supported by this gateway' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return streamOf([
        'data: {"choices":[{"delta":{"content":"去掉工具后的正文"}}]}\n\ndata: [DONE]\n\n',
      ]);
    }) as typeof fetch;

    const result = await client(fetchImpl).stream({ messages: MESSAGES, tools: TOOLS });

    const sent = sentCalls(calls);
    expect(sent).toHaveLength(2);
    expect(Array.isArray(sent[0]!.body['tools'])).toBe(true);
    expect(sent[1]!.body['tools']).toBeUndefined();
    expect(result.content).toBe('去掉工具后的正文');
    expect(result.toolsUnsupported).toBe(true);
  });

  it('条件 3（反向）：400 但错误说的是别的（模型不存在）→ 不重发，照常报错', async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ error: { message: 'model demo-a not found' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(client(fetchImpl).stream({ messages: MESSAGES, tools: TOOLS })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('条件 4：signal 中途 abort → stream() 很快结束（≤1 秒），错误能被认成取消', async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const enc = encoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'));
          // 之后一直不结束：只有 abort 能让它停
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* 已经关了就忽略 */
            }
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const controller = new AbortController();
    const started = Date.now();
    const pending = client(fetchImpl).stream({
      messages: MESSAGES,
      tools: TOOLS,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeDefined();
    expect(elapsed).toBeLessThanOrEqual(1000);
    const text = `${(caught as { name?: string }).name ?? ''} ${String(
      (caught as { message?: string }).message ?? '',
    )}`;
    expect(text).toMatch(/abort|cancel|取消|终止/i);
  });
});
