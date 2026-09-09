/**
 * OpenAI 兼容提供者：/chat/completions 自动探测与模型列表拉取（2026-09-08 设置向导改造）。
 * 全部用内存 fetch stub，不发真实网络请求。
 */
import { describe, expect, it } from 'vitest';
import { OpenAIResponsesProvider, listUpstreamModels } from '../../src/extraction/model/openai.js';

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string | URL, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

describe('OpenAIResponsesProvider 端点探测', () => {
  it('上游无 /responses（404）时自动切换到 /chat/completions 并正确解析', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch((url, init) => {
      calls.push(url);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (url.endsWith('/responses')) {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      if (url.endsWith('/chat/completions')) {
        expect(body['messages']).toBeDefined();
        if (body['response_format']) {
          expect(body['response_format']).toEqual({ type: 'json_object' });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: 'sk-test',
      modelName: 'deepseek-test',
      baseUrl: 'https://api.example.com/v1',
      fetchImpl,
    });
    const result = await provider.chatStructured<{ ok: boolean }>({
      system: 's',
      user: 'u',
      schema: (await import('zod')).z.object({ ok: (await import('zod')).z.boolean() }),
    });
    expect(result).toEqual({ ok: true });
    // 首次探测 1 次 + 实际请求 1 次，第二次复用探测结果
    expect(calls.filter((c) => c.endsWith('/responses'))).toHaveLength(1);
    await provider.chatText({ system: 's', user: 'u' });
    expect(calls.filter((c) => c.endsWith('/responses'))).toHaveLength(1); // 未重复探测
  });

  it('上游支持 /responses 时保持原路径（探测请求不破坏正常流程）', async () => {
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/responses')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
        // 探测请求（input 空）→ 返回 400 model 相关错误（非 url 类）→ 继续用 /responses
        if (!body.input || body.input.length === 0) {
          return new Response('{"error":"model not specified"}', { status: 400 });
        }
        return new Response(JSON.stringify({ output: [{ content: [{ text: 'plain answer' }] }] }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 404 });
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: 'sk-test',
      modelName: 'gpt-test',
      baseUrl: 'https://api.example.com/v1',
      fetchImpl,
    });
    const text = await provider.chatText({ system: 's', user: 'u' });
    expect(text).toBe('plain answer');
  });

  it('chatStructured 把 JSON Schema 附加到 system（chat-completions 端点的结构说明）', async () => {
    let seenSystem = '';
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/responses')) {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content: string }>;
      };
      seenSystem = body.messages?.[0]?.content ?? '';
      // 模拟遵循提示结构的模型：system 含 items 结构说明 → 正确输出
      if (seenSystem.includes('"items"')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"items":[{"type":"decision","statement":"甲","rationale":null,"confidence":0.9,"segment_ref":"S2","project_hint":null,"excerpt":"甲"}]}',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      // 无结构说明 → 模型自创结构（v1 旧行为，导致用户实测的校验失败）
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": {"type": "decision"}}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: 'sk-test',
      modelName: 'deepseek-test',
      baseUrl: 'https://api.example.com/v1',
      fetchImpl,
    });
    const { z } = await import('zod');
    const result = await provider.chatStructured({
      system: '你是提取引擎',
      user: '资料……',
      schema: z.object({
        items: z.array(
          z.object({
            type: z.enum([
              'project_summary',
              'decision',
              'rejected_option',
              'open_loop',
              'goal',
              'constraint',
              'preference',
            ]),
            statement: z.string(),
            rationale: z.string().nullable(),
            confidence: z.number(),
            segment_ref: z.string(),
            project_hint: z.string().nullable(),
            excerpt: z.string(),
          }),
        ),
      }),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.statement).toBe('甲');
    expect(seenSystem).toContain('输出格式');
    expect(seenSystem).toContain('只输出一个 JSON 对象');
  });

  it('上游 400 且错误信息含 unknown url 时切换（OpenAI 兼容网关常见行为）', async () => {
    const fetchImpl = stubFetch((url) => {
      if (url.endsWith('/responses')) {
        return new Response('{"error":"Unknown url /v1/responses"}', { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    });
    const provider = new OpenAIResponsesProvider({
      apiKey: 'sk-test',
      modelName: 'm',
      baseUrl: 'https://gw.example.com/v1',
      fetchImpl,
    });
    expect(await provider.chatText({ system: 's', user: 'u' })).toBe('ok');
  });
});

describe('listUpstreamModels', () => {
  it('GET {base}/models 解析并排序返回模型 id', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://api.example.com/v1/models');
      return new Response(
        JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: '' }, {}] }),
        { status: 200 },
      );
    });
    const models = await listUpstreamModels({
      apiBaseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      fetchImpl,
    });
    expect(models).toEqual([{ id: 'model-a' }, { id: 'model-b' }]);
  });

  it('空地址回退官方默认端点', async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toBe('https://api.openai.com/v1/models');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const models = await listUpstreamModels({ apiBaseUrl: '  ', apiKey: 'sk', fetchImpl });
    expect(models).toEqual([]);
  });

  it('上游非 2xx 时抛带状态码的错误', async () => {
    const fetchImpl = stubFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(
      listUpstreamModels({ apiBaseUrl: 'https://api.example.com/v1', apiKey: 'sk-bad', fetchImpl }),
    ).rejects.toThrow('401');
  });
});
