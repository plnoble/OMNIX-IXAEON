/**
 * MP3 验收条件 10：`ModelError.status`。
 *
 * - 聊天客户端和后台分析的客户端收到 HTTP 错误时，`status` 等于那个状态码；
 * - 连不上、超时时没有 `status`；
 * - 测试用的 FakeStreamChatClient 剧本一步可以多写一个 `status`，抛出的 ModelError 带上它。
 *
 * 现在 `ModelError` 还没有 `status`，本文件应当红（`status` 是 undefined）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  FakeStreamChatClient,
  ModelError,
  OpenAIChatStreamClient,
  OpenAIResponsesProvider,
} from '@ixaeon/core';

afterEach(() => vi.unstubAllGlobals());

function statusOf(err: unknown): unknown {
  return (err as { status?: unknown }).status;
}

describe('MP3 条件 10：ModelError.status', () => {
  it('ModelError 带 status', () => {
    const Ctor = ModelError as unknown as new (m: string, r: boolean, s?: number) => Error;
    expect(statusOf(new Ctor('boom', true, 429))).toBe(429);
    expect(statusOf(new Ctor('连不上', true))).toBeUndefined();
  });

  it('FakeStreamChatClient 剧本的 status 会带到抛出的错误上', async () => {
    const client = new FakeStreamChatClient([{ error: '额度用完', status: 429 }], 'demo-a');
    let err: unknown = null;
    try {
      await client.stream({ messages: [], lastUser: '问', onDelta: () => undefined });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(statusOf(err)).toBe(429);
  });

  it('聊天客户端收到 HTTP 429 → status=429；连不上没有 status', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ error: { message: '额度用完' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    const client = new OpenAIChatStreamClient({
      baseUrl: 'http://127.0.0.1:18081/v1',
      apiKey: 'sk-synthetic-a1b2c3d4',
      model: 'demo-a',
    });
    let err: unknown = null;
    try {
      await client.stream({ messages: [], lastUser: '问', onDelta: () => undefined });
    } catch (e) {
      err = e;
    }
    expect(statusOf(err)).toBe(429);

    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as typeof fetch);
    const client2 = new OpenAIChatStreamClient({
      baseUrl: 'http://127.0.0.1:18081/v1',
      apiKey: 'sk-synthetic-a1b2c3d4',
      model: 'demo-a',
    });
    let err2: unknown = null;
    try {
      await client2.stream({ messages: [], lastUser: '问', onDelta: () => undefined });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeTruthy();
    expect(statusOf(err2)).toBeUndefined();
  });

  it('后台分析的客户端收到 HTTP 429 → status=429；连不上没有 status', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ error: { message: '额度用完' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    const provider = new OpenAIResponsesProvider({
      apiKey: 'sk-synthetic-a1b2c3d4',
      modelName: 'demo-a',
      baseUrl: 'http://127.0.0.1:18081/v1',
    });
    let err: unknown = null;
    try {
      await provider.chatText({ system: 's', user: 'u' });
    } catch (e) {
      err = e;
    }
    expect(statusOf(err)).toBe(429);

    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as typeof fetch);
    const provider2 = new OpenAIResponsesProvider({
      apiKey: 'sk-synthetic-a1b2c3d4',
      modelName: 'demo-a',
      baseUrl: 'http://127.0.0.1:18081/v1',
    });
    let err2: unknown = null;
    try {
      await provider2.chatText({ system: 's', user: 'u' });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeTruthy();
    expect(statusOf(err2)).toBeUndefined();
  });
});
