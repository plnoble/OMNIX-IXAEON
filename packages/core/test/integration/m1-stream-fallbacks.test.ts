/**
 * M1 整合方抽查补（2026-09-28）：兼容网关的流式各有各的写法。用户的网关是哪一种看不到，
 * 只认一种的话，碰上另一种就每次都失败（重试也一样），分析、判定、翻译全停。
 * - /responses：只发 created 和 completed、全文放在 completed 的 response.output 里；
 * - /chat/completions：发完带 finish_reason 的一块就断开、不发 [DONE]；最后一块用 message.content。
 * 截断（既没有结束事件也没有结束标记）照旧算失败。
 */
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ModelError, OpenAIResponsesProvider } from '../../src/index.js';

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function provider(fetchImpl: typeof fetch): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    apiKey: 'sk-test',
    modelName: 'some-model',
    baseUrl: 'https://api.example.com/v1',
    fetchImpl,
  });
}

/** 走 /responses：探测请求（input 为空）照常回 400，真正的请求回 sse。 */
function responsesGateway(sse: string[]): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
    if (Array.isArray(body.input) && body.input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    return streamOf(sse);
  }) as typeof fetch;
}

/** 走 /chat/completions：/responses 回 404。 */
function chatGateway(sse: string[]): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/responses')) return new Response('not found', { status: 404 });
    return streamOf(sse);
  }) as typeof fetch;
}

const schema = z.object({ ok: z.boolean() });

it('/responses：只发 created 和 completed、全文在 completed 里，照样拿到结果', async () => {
  const completed = {
    type: 'response.completed',
    response: { output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] },
  };
  const result = await provider(
    responsesGateway([
      'data: {"type":"response.created"}\n\n',
      `data: ${JSON.stringify(completed)}\n\n`,
    ]),
  ).chatStructured({ system: 's', user: 'u', schema });
  expect(result).toEqual({ ok: true });
});

it('/chat/completions：发完 finish_reason 就断开、没有 [DONE]，照样拿到结果', async () => {
  const result = await provider(
    chatGateway([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\n',
    ]),
  ).chatStructured({ system: 's', user: 'u', schema });
  expect(result).toEqual({ ok: true });
});

it('/chat/completions：最后一块用 message.content 也收下', async () => {
  const result = await provider(
    chatGateway([
      'data: {"choices":[{"message":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  ).chatStructured({ system: 's', user: 'u', schema });
  expect(result).toEqual({ ok: true });
});

it('截断照旧算失败：既没有 [DONE] 也没有 finish_reason 就断开', async () => {
  const err = await provider(
    chatGateway(['data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n']),
  )
    .chatText({ system: 's', user: 'u' })
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(ModelError);
  expect((err as ModelError).message).toContain('流在完成前结束');
});
