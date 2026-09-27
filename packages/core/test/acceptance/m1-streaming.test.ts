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
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls.push(sentBody(init));
    // 三次读取、两段非空 delta：created 在第 1 块，第一段 delta 也在第 1 块，
    // 第二段跨第 2、3 块，completed 在第 3 块
    return streamOf([
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tr',
      'ue}"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n',
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
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
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
    const input = body['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    bodies.push(body);
    if (body['stream'] === true) {
      return new Response('{"error":"unknown parameter stream"}', { status: 400 });
    }
    if ('stream' in body) {
      throw new Error('回退请求不该再带 stream 字段');
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

it('条件 3：返回普通 JSON 之后，同一个实例不再尝试流式', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = sentBody(init);
    const input = body['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    bodies.push(body);
    return new Response(JSON.stringify({ output: [{ content: [{ text: '普通回答' }] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const p = provider(fetchImpl);
  expect(await p.chatText({ system: 's', user: 'u' })).toBe('普通回答');
  expect(await p.chatText({ system: 's', user: 'u' })).toBe('普通回答');
  const real = bodies.filter(
    (b) => Array.isArray(b['input']) && (b['input'] as unknown[]).length > 0,
  );
  expect(real.map((b) => b['stream'] === true)).toEqual([true, false]);
});

it('条件 3：/chat/completions 对 stream 报 400，去掉字段重发并记住', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/responses')) {
      return new Response('{"error":"not found"}', { status: 404 });
    }
    const body = sentBody(init);
    bodies.push(body);
    if (body['stream'] === true) {
      return new Response('{"error":"unknown parameter stream"}', { status: 400 });
    }
    if ('stream' in body) throw new Error('回退请求不该再带 stream 字段');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '兼容端点重发成功' } }] }),
      {
        status: 200,
      },
    );
  }) as typeof fetch;
  const p = provider(fetchImpl);
  expect(await p.chatText({ system: 's', user: 'u' })).toBe('兼容端点重发成功');
  expect(await p.chatText({ system: 's', user: 'u' })).toBe('兼容端点重发成功');
  expect(bodies.map((b) => b['stream'] === true)).toEqual([true, false, false]);
});

it('模型或输入的 400 不算不支持流式，不重发', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls += 1;
    return new Response('{"error":"invalid schema"}', { status: 400 });
  }) as typeof fetch;
  await expect(provider(fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: false,
  });
  expect(calls).toBe(1);
});

it('400 正文提 upstream 不算拒绝 stream，不回退', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls += 1;
    return new Response('{"error":"unsupported upstream model"}', { status: 400 });
  }) as typeof fetch;
  await expect(provider(fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: false,
  });
  expect(calls).toBe(1);
});

it('schema 字段名里的 stream 不算拒绝流式，不回退', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls += 1;
    return new Response('{"error":"invalid schema property \'stream\'"}', { status: 400 });
  }) as typeof fetch;
  await expect(provider(fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: false,
  });
  expect(calls).toBe(1);
});

it('错误码是 JSON 数字也能认：429 可重试、400 不可重试', async () => {
  function failing(code: number): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const input = sentBody(init)['input'] as unknown[] | undefined;
      if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      return streamOf([
        `event: error\ndata: {"type":"error","code":${code},"message":"数字码"}\n\n`,
      ]);
    }) as typeof fetch;
  }
  await expect(provider(failing(429)).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: true,
  });
  await expect(provider(failing(503)).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: true,
  });
  await expect(provider(failing(400)).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: false,
  });
});

it('error.type=server_error 没有 code 也可重试', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    return streamOf([
      'event: error\ndata: {"type":"error","error":{"type":"server_error","message":"上游炸了"}}\n\n',
    ]);
  }) as typeof fetch;
  await expect(provider(fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: true,
  });
});

it('拒绝对象不是 stream 的 400 不回退；stream 被明确禁用时回退', async () => {
  function with400(error: string): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const input = sentBody(init)['input'] as unknown[] | undefined;
      if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      calls += 1;
      if (JSON.parse(String(init?.body ?? '{}'))['stream'] === true) {
        return new Response(`{"error":"${error}"}`, { status: 400 });
      }
      return new Response(JSON.stringify({ output: [{ content: [{ text: '普通成功' }] }] }), {
        status: 200,
      });
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }
  // 「unsupported schema property 'stream'」：拒绝的是 schema 属性，不是流式参数
  const schemaProp = with400("unsupported schema property 'stream'");
  await expect(
    provider(schemaProp.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  expect(schemaProp.calls()).toBe(1);
  // 「stream must be false」：网关明确要求不带 stream，回退重发
  const mustFalse = with400('stream must be false');
  const p2 = provider(mustFalse.fetchImpl);
  expect(await p2.chatText({ system: 's', user: 'u' })).toBe('普通成功');
  expect(mustFalse.calls()).toBe(2);
  // 「stream parameter is not supported」：拒绝词与 stream 隔着 parameter，仍要回退
  const paramNotSupported = with400('stream parameter is not supported');
  const p3 = provider(paramNotSupported.fetchImpl);
  expect(await p3.chatText({ system: 's', user: 'u' })).toBe('普通成功');
  expect(paramNotSupported.calls()).toBe(2);
});

it('响应头到手后读取断了，按网络错误重试一次', async () => {
  let streams = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    streams += 1;
    if (streams === 1) {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('连接中断'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return streamOf([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"重试后的回答"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('重试后的回答');
  expect(streams).toBe(2);
});

it('条件 4：流中 response.failed 抛 ModelError，服务端类可重试', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
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
  function failing(code: string, message = '出错了'): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const input = sentBody(init)['input'] as unknown[] | undefined;
      if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      // code 与 message 在事件顶层，不套在 error 里
      return streamOf([
        `event: error\ndata: {"type":"error","code":"${code}","message":"${message}"}\n\n`,
      ]);
    }) as typeof fetch;
  }
  const rateLimited = provider(failing('rate_limit_exceeded')).chatText({ system: 's', user: 'u' });
  await expect(rateLimited).rejects.toBeInstanceOf(ModelError);
  await expect(rateLimited).rejects.toMatchObject({ retriable: true });
  await expect(rateLimited).rejects.toThrow(/API 错误 429/);
  // 数字限流码也认，只看 code，不在消息正文里找数字
  const numeric = provider(failing('429')).chatText({ system: 's', user: 'u' });
  await expect(numeric).rejects.toMatchObject({ retriable: true });
  // code=500 认作服务端错误
  await expect(
    provider(failing('500', '上游错误')).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: true });
  // 消息里带数字的普通错误不算服务端错误
  await expect(
    provider(failing('invalid_prompt', '超过 512 tokens')).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  const bad = provider(failing('invalid_prompt')).chatText({ system: 's', user: 'u' });
  await expect(bad).rejects.toMatchObject({ retriable: false });
});

it('CRLF 分隔的流也能读完（跨读取边界）', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    return streamOf([
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"回车换行"}\r\n\r\n',
      'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n',
    ]);
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('回车换行');
});

it('没等到完成标记就断流，按网络错误重试，不把截断当成功', async () => {
  let streams = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    streams += 1;
    if (streams === 1) {
      // 有文字但没有 completed 就断：截断，必须重试
      return streamOf([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"半截"}\n\n',
      ]);
    }
    return streamOf([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"完整回答"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ]);
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('完整回答');
  expect(streams).toBe(2);
});
