import { describe, it, expect } from 'vitest';
import { openDatabase, migrate, CoreToolBroker, createWebSearchExecutor } from '../../src/index.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ItemService,
  ProjectService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
} from '../../src/index.js';

/**
 * B3 受控网页搜索：双 provider 解析、诚实失败、broker 接线（不联网）。
 * 真机探针在 b3-real-search.test.ts（环境门控）。
 */

function makeBroker(webSearch?: ReturnType<typeof createWebSearchExecutor>) {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-b3-unit-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const projects = new ProjectService(db);
  const items = new ItemService(db);
  const search = new SearchService(db);
  const coding = new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'vault'));
  return {
    dir,
    db,
    broker: new CoreToolBroker(db, items, search, coding, projects, {}, webSearch),
  };
}

describe('B3 网页搜索执行器（mock fetch，不联机）', () => {
  it('brave：解析 web.results，鉴权头带 X-Subscription-Token', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: 'Rust 官网', url: 'https://rust-lang.org', description: '一门系统语言' },
              { title: '第二条', url: 'https://example.com/b', description: 'desc-b' },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const exec = createWebSearchExecutor('brave', 'test-key', { fetchFn });
    const out = await exec.search('rust language', 5);
    expect(out.provider).toBe('brave');
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0]).toEqual({
      title: 'Rust 官网',
      url: 'https://rust-lang.org',
      snippet: '一门系统语言',
    });
    expect(calls[0]?.url).toContain('api.search.brave.com/res/v1/web/search?q=');
    expect(calls[0]?.headers['X-Subscription-Token']).toBe('test-key');
  });

  it('tavily：POST Bearer 鉴权，解析 results', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          results: [{ title: 'Tavily 结果', url: 'https://example.com/t', content: '内容摘要' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const exec = createWebSearchExecutor('tavily', 'tvly-key', { fetchFn });
    const out = await exec.search('ai search', 3);
    expect(out.provider).toBe('tavily');
    expect(out.hits[0]?.url).toBe('https://example.com/t');
    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    const body = JSON.parse(String(calls[0]?.init?.body)) as { query: string; max_results: number };
    expect(body.query).toBe('ai search');
    expect(body.max_results).toBe(3);
  });

  it('401/429/网络失败都诚实抛错，不造结果', async () => {
    const fetch401 = (async () =>
      new Response('{"error":"denied"}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      createWebSearchExecutor('brave', 'bad', { fetchFn: fetch401 }).search('q'),
    ).rejects.toThrow(/拒绝认证/);

    const fetch429 = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(
      createWebSearchExecutor('tavily', 'k', { fetchFn: fetch429 }).search('q'),
    ).rejects.toThrow(/限流/);

    const fetchDead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      createWebSearchExecutor('tavily', 'k', { fetchFn: fetchDead }).search('q'),
    ).rejects.toThrow(/搜索服务不可达/);
  });

  it('broker：未配置执行器时 search_web 诚实失败（不因接线改变旧契约）', async () => {
    const { dir, db, broker } = makeBroker();
    try {
      await expect(
        broker.invoke('search_web', { query: 'rust' }, { audience: 'model', runId: 'r' }),
      ).rejects.toThrow(/真实搜索入口未配置/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('broker：配置后走执行器并回传脱敏标记与结果', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          web: { results: [{ title: 't', url: 'https://e.com/a', description: 'd' }] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const { dir, db, broker } = makeBroker(createWebSearchExecutor('brave', 'k', { fetchFn }));
    try {
      const result = (await broker.invoke(
        'search_web',
        { query: '我的邮箱 a@b.com 怎么配置 rust' },
        { audience: 'model', runId: 'r' },
      )) as { provider: string; redacted: boolean; hits: unknown[] };
      expect(result.provider).toBe('brave');
      expect(result.redacted).toBe(true); // 邮箱被脱敏
      expect(result.hits).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
