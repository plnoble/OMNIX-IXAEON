/**
 * M1 验收（规格 docs/委派/M1-慢模型不再超时.md）
 *
 * 条件 1：/responses 流式，三次读取吐出 created、两段 delta（一段拆在两次读取之间）、
 *         completed，拿到完整文字，结构化结果校验通过。
 * 条件 2：/chat/completions 流式，多段 delta.content + [DONE]，拿到完整文字。
 * 条件 3：网关忽略 stream 返回普通 JSON 照旧解析；对 stream 报 400 时去掉 stream 重发一次，
 *         之后同一个实例不再带 stream。
 * 条件 4：流中 response.failed / error 事件抛 ModelError；限流与服务端类 retriable = true。
 * 条件 5：429 / 5xx 与网络错误的重试次数不变（由既有测试覆盖，本文件不重复）。
 */
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ModelError, OpenAIResponsesProvider } from '../../src/index.js';

/** 把若干块按顺序交给读取方，模拟服务端推送被拆开。 */
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
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function provider(fetchImpl: typeof fetch): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    apiKey: 'sk-test',
    modelName: 'slow-model',
    baseUrl: 'https://api.example.com/v1',
    fetchImpl,
  });
}

function sentBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

it('条件 1：/responses 流式，delta 被拆开也能拼回完整文字并通过校验', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/responses') && sentBody(init)['input'] === undefined) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls.push(sentBody(init));
    return streamOf([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"ok\\":',
      'true}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  }) as typeof fetch;
  const result = await provider(fetchImpl).chatStructured({
    system: 's',
    user: 'u',
    schema: z.object({ ok: z.boolean() }),
  });
  expect(result).toEqual({ ok: true });
  const real = calls.find((b) => Array.isArray(b['input']) && b['input'].length > 0);
  expect(real!['stream']).toBe(true);
});

it('条件 2：/chat/completions 流式，多段 delta 加 [DONE]', async () => {
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).endsWith('/responses')) {
      return new Response('{"error":"not found"}', { status: 404 });
    }
    return streamOf([
      'data: {"choices":[{"delta":{"content":"前半"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"后半"}}]}\n\ndata: [DONE]\n\n',
    ]);
  }) as typeof fetch;
  const text = await provider(fetchImpl).chatText({ system: 's', user: 'u' });
  expect(text).toBe('前半后半');
});

it('条件 3：网关忽略 stream 返回普通 JSON，照旧解析', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/responses') && sentBody(init)['input'] === undefined) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    return new Response(JSON.stringify({ output: [{ content: [{ text: '普通回答' }] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('普通回答');
});

it('条件 3：对 stream 报 400 就去掉 stream 重发，之后不再带 stream', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = sentBody(init);
    if (String(url).endsWith('/responses') && body['input'] === undefined) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    bodies.push(body);
    if (body['stream'] === true) {
      return new Response('{"error":"unknown parameter stream"}', { status: 400 });
    }
    return new Response(JSON.stringify({ output: [{ content: [{ text: '重发成功' }] }] }), {
      status: 200,
    });
  }) as typeof fetch;
  const p = provider(fetchImpl);
  expect(await p.chatText({ system: 's', user: 'u' })).toBe('重发成功');
  expect(await p.chatText({ system: 's', user: 'u' })).toBe('重发成功');
  // 第一次带 stream 被拒、重发不带；第二次直接不带。探测请求（input 为空）不算。
  const real = bodies.filter((b) => Array.isArray(b['input']) && b['input'].length > 0);
  expect(real.map((b) => b['stream'] === true)).toEqual([true, false, false]);
});

it('条件 4：流中 response.failed 抛 ModelError，服务端类可重试', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/responses') && sentBody(init)['input'] === undefined) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    return streamOf([
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error","message":"上游超时"}}}\n\n',
    ]);
  }) as typeof fetch;
  await expect(provider(fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    name: 'ModelError',
    retriable: true,
  });
});

it('条件 4：限流类的 error 事件 retriable 为 true，其它为 false', async () => {
  function failing(code: string): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/responses') && sentBody(init)['input'] === undefined) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      return streamOf([
        `event: error\ndata: {"type":"error","error":{"code":"${code}","message":"出错了"}}\n\n`,
      ]);
    }) as typeof fetch;
  }
  const rateLimited = provider(failing('rate_limit_exceeded')).chatText({ system: 's', user: 'u' });
  await expect(rateLimited).rejects.toBeInstanceOf(ModelError);
  await expect(rateLimited).rejects.toMatchObject({ retriable: true });
  const bad = provider(failing('invalid_prompt')).chatText({ system: 's', user: 'u' });
  await expect(bad).rejects.toMatchObject({ retriable: false });
});
