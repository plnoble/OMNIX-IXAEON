/**
 * M1 验收（规格 docs/委派/M1-慢模型不再超时.md）
 *
 * 条件 1：/responses 流式，三次读取吐出 created、两段 delta（一段拆在两次读取之间）、
 *         completed，拿到完整文字，结构化结果校验通过。
 * 条件 2：/chat/completions 流式，多段 delta.content + [DONE]，拿到完整文字。
 * 条件 3：网关忽略 stream 返回普通 JSON 照旧解析；对 stream 报 400 时去掉 stream 重发一次，
 *         之后同一个实例不再带 stream。
 * 条件 4：流中 response.failed / error 事件抛 ModelError；限流与服务端类 retriable = true。
 * 条件 5：429 / 5xx 与网络错误都只立即重试一次，第二次失败就抛。
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
  // 不带引号的写法同样不回退（第七轮审查的反例）
  const schemaPropBare = with400('unsupported schema property stream');
  await expect(
    provider(schemaPropBare.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  expect(schemaPropBare.calls()).toBe(1);
  // 拒绝词写在后面也不回退：schema 里叫 stream 的属性（第八轮审查的反例）
  const schemaPropAfter = with400('schema property stream is not supported');
  await expect(
    provider(schemaPropAfter.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  expect(schemaPropAfter.calls()).toBe(1);
  // 值类型错（不是参数被拒）不回退
  const typeError = with400('stream must be a boolean');
  await expect(
    provider(typeError.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  expect(typeError.calls()).toBe(1);
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
  // 「Streaming is disabled」：is disabled 也算拒绝，回退
  const streamingDisabled = with400('Streaming is disabled for this model');
  const p5 = provider(streamingDisabled.fetchImpl);
  expect(await p5.chatText({ system: 's', user: 'u' })).toBe('普通成功');
  expect(streamingDisabled.calls()).toBe(2);
  // 「does not support streaming」：拒绝词在 stream 前面，也要回退
  const noStreaming = with400('The model does not support streaming');
  const p4 = provider(noStreaming.fetchImpl);
  expect(await p4.chatText({ system: 's', user: 'u' })).toBe('普通成功');
  expect(noStreaming.calls()).toBe(2);
});

it('结构化错误点名 param=stream 且错误码属「参数被拒」类时回退', async () => {
  function withJson400(body: string): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const input = sentBody(init)['input'] as unknown[] | undefined;
      if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      calls += 1;
      if (JSON.parse(String(init?.body ?? '{}'))['stream'] === true) {
        return new Response(body, { status: 400 });
      }
      return new Response(JSON.stringify({ output: [{ content: [{ text: '普通成功' }] }] }), {
        status: 200,
      });
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }
  // error.param=stream + unsupported_parameter：回退重发
  const unsupported = withJson400(
    '{"error":{"code":"unsupported_parameter","param":"stream","message":"Unsupported parameter"}}',
  );
  const p1 = provider(unsupported.fetchImpl);
  expect(await p1.chatText({ system: 's', user: 'u' })).toBe('普通成功');
  expect(unsupported.calls()).toBe(2);
  // 同一个实例记住：第二次直接不带 stream
  expect(await p1.chatText({ system: 's', user: 'u' })).toBe('普通成功');
  expect(unsupported.calls()).toBe(3);
  // error.param 指向别的参数：不回退
  const otherParam = withJson400(
    '{"error":{"code":"unsupported_parameter","param":"temperature"}}',
  );
  await expect(
    provider(otherParam.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  expect(otherParam.calls()).toBe(1);
});

it('条件 5：429、5xx、网络错误都只立即重试一次，第二次失败就抛', async () => {
  function alwaysFail(mode: '429' | '500' | 'network'): { f: typeof fetch; calls: () => number } {
    let calls = 0;
    const f = (async (url: string | URL, init?: RequestInit) => {
      const input = sentBody(init)['input'] as unknown[] | undefined;
      if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      calls += 1;
      if (mode === 'network') throw new Error('fetch failed');
      return new Response('synthetic', { status: mode === '429' ? 429 : 500 });
    }) as typeof fetch;
    return { f, calls: () => calls };
  }
  for (const mode of ['429', '500', 'network'] as const) {
    const { f, calls } = alwaysFail(mode);
    const err = await provider(f)
      .chatText({ system: 's', user: 'u' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).retriable).toBe(true);
    // 一次原始请求 + 一次立即重试，之后不再重试
    expect(calls()).toBe(2);
  }
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

it('条件 4：流中 response.failed 抛 ModelError，服务端类可重试且立即重试一次', async () => {
  let streams = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    streams += 1;
    return streamOf([
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error","message":"上游超时"}}}\n\n',
    ]);
  }) as typeof fetch;
  await expect(provider(fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    name: 'ModelError',
    retriable: true,
  });
  expect(streams).toBe(2);
});

it('条件 4：限流类的 error 事件 retriable 为 true，其它为 false', async () => {
  function failing(
    code: string,
    message = '出错了',
  ): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const input = sentBody(init)['input'] as unknown[] | undefined;
      if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
        return new Response('{"error":"model not specified"}', { status: 400 });
      }
      calls += 1;
      return streamOf([
        `event: error\ndata: {"type":"error","code":"${code}","message":"${message}"}\n\n`,
      ]);
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }
  const rateLimited = failing('rate_limit_exceeded');
  const rateErr = provider(rateLimited.fetchImpl).chatText({ system: 's', user: 'u' });
  await expect(rateErr).rejects.toBeInstanceOf(ModelError);
  await expect(rateErr).rejects.toMatchObject({ retriable: true });
  await expect(rateErr).rejects.toThrow(/API 错误 429/);
  expect(rateLimited.calls()).toBe(2);
  const numeric = failing('429');
  await expect(
    provider(numeric.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: true });
  expect(numeric.calls()).toBe(2);
  const server = failing('500', '上游错误');
  await expect(
    provider(server.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: true });
  expect(server.calls()).toBe(2);
  const tokens = failing('invalid_prompt', '超过 512 tokens');
  await expect(
    provider(tokens.fetchImpl).chatText({ system: 's', user: 'u' }),
  ).rejects.toMatchObject({ retriable: false });
  expect(tokens.calls()).toBe(1);
  const bad = failing('invalid_prompt');
  await expect(provider(bad.fetchImpl).chatText({ system: 's', user: 'u' })).rejects.toMatchObject({
    retriable: false,
  });
  expect(bad.calls()).toBe(1);
});

it('事件内部的 CRLF 跨块时不制造空行，仍能拼回完整 JSON', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    // 同一事件两条 data: 行，在第一条行末 CR 处拆块；第一行单独不是完整 JSON
    return streamOf([
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"{\\"ok\\":true}"\r',
      '\ndata: }\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n',
    ]);
  }) as typeof fetch;
  const result = await provider(fetchImpl).chatStructured({
    system: 's',
    user: 'u',
    schema: z.object({ ok: z.boolean() }),
  });
  expect(result).toEqual({ ok: true });
});

it('只收到 completed 没有文字，一次请求就抛空文本，不立即重试', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls += 1;
    return streamOf(['event: response.completed\ndata: {"type":"response.completed"}\n\n']);
  }) as typeof fetch;
  const err = await provider(fetchImpl)
    .chatText({ system: 's', user: 'u' })
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(ModelError);
  expect((err as ModelError).message).toMatch(/空文本/);
  expect(calls).toBe(1);
});

it('CRLF 分隔的流也能读完（事件分隔符跨在两次读取之间）', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    // 第 1 块末尾停在 `\r\n\r`，`\n` 与 completed 事件在第 2 块
    return streamOf([
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"回车换行"}\r\n\r',
      '\n\nevent: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n',
    ]);
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('回车换行');
});

it('400 正文是 JSON null 不炸：照旧报 API 错误 400，不回退', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    calls += 1;
    return new Response('null', { status: 400 });
  }) as typeof fetch;
  const err = await provider(fetchImpl)
    .chatText({ system: 's', user: 'u' })
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(ModelError);
  expect((err as ModelError).retriable).toBe(false);
  expect(calls).toBe(1);
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

it('Content-Type 大小写不敏感：Text/Event-Stream 也按流读', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"大小写"}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'Text/Event-Stream' },
    });
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('大小写');
});

it('SSE 单独用 CR 换行也能读完', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    return streamOf([
      'event: response.output_text.delta\rdata: {"type":"response.output_text.delta","delta":"回车"}\r\r',
      'event: response.completed\rdata: {"type":"response.completed"}\r\r',
    ]);
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('回车');
});

it('完成事件后连接不关也能立刻结束，不把 CR 完成事件挂住', async () => {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const input = sentBody(init)['input'] as unknown[] | undefined;
    if (String(url).endsWith('/responses') && input !== undefined && input.length === 0) {
      return new Response('{"error":"model not specified"}', { status: 400 });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: response.output_text.delta\rdata: {"type":"response.output_text.delta","delta":"不关流"}\r\r',
          ),
        );
        controller.enqueue(
          encoder.encode('event: response.completed\rdata: {"type":"response.completed"}\r\r'),
        );
        // 故意不 close，模拟服务端保持连接
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  expect(await provider(fetchImpl).chatText({ system: 's', user: 'u' })).toBe('不关流');
});
