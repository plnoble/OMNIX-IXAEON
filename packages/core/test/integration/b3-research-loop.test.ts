import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ResearchChecker,
  systemClock,
  type CoreDatabase,
  type WebSearchExecutor,
  type WebSearchOutcome,
} from '../../src/index.js';

/**
 * B3 研究检查循环接受控搜索（合成验证）。
 *
 * 口径（docs/v03-acceptance-map.md B3）：
 * - 搜索结果只是候选 URL，不是发现——用户批准后才成为来源（搜索→批准→抓取）
 * - 只有写了「出门说法」的主题才会外发；查询先过本地脱敏
 * - 手动检查才搜；定时轮次（tick）不偷偷消耗额度
 * - 搜索失败不毁掉批准来源轮次；零来源+搜索失败=如实记失败
 */

interface MockCall {
  query: string;
  limit: number;
}

function mockExecutor(opts: {
  hits?: Array<{ title: string; url: string; snippet: string }>;
  error?: Error;
}): { executor: WebSearchExecutor; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const executor: WebSearchExecutor = {
    provider: 'tavily',
    async search(query: string, limit = 5): Promise<WebSearchOutcome> {
      calls.push({ query, limit });
      if (opts.error) throw opts.error;
      return {
        provider: 'tavily',
        query,
        hits: (opts.hits ?? []).slice(0, limit),
      };
    },
  };
  return { executor, calls };
}

const FIXTURE_PAGE = `<!doctype html><html><head><title>Example Release Notes</title></head>
<body><h1>v2.1 released</h1><p>Fixes and improvements.</p></body></html>`;

function fakeFetch(pageBody: string) {
  return async (url: string): Promise<Response> => {
    if (url.includes('example.com')) {
      return new Response(pageBody, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error('network unreachable');
  };
}

function makeDb(dir: string): CoreDatabase {
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('B3 研究检查循环×受控搜索（合成）', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'b3-research-'));
    dirs.push(d);
    return d;
  }

  afterAll(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // Windows 句柄延迟释放：尽力清理
      }
    }
  });

  it('手动检查：批准来源照旧 + 搜索候选返回（候选不是发现）', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor, calls } = mockExecutor({
      hits: [
        { title: 'Result A', url: 'https://a.example.com/x', snippet: 'snippet a' },
        { title: 'Result B', url: 'https://b.example.com/y', snippet: 'snippet b' },
      ],
    });
    const checker = new ResearchChecker(
      db,
      systemClock,
      { fetch: fakeFetch(FIXTURE_PAGE) },
      () => executor,
    );
    const topic = checker.createTopic({
      question: '盯 Example 项目的发布',
      publicDescription: 'Example project release notes',
      sources: [{ url: 'https://example.com/releases', kind: 'page' as const }],
    });
    const result = await checker.checkNow(topic.id);

    expect(result.searchUsed).toBe(true);
    expect(result.mode).toBe('approved-sources-plus-search');
    expect(result.searchCandidates.map((c) => c.url)).toEqual([
      'https://a.example.com/x',
      'https://b.example.com/y',
    ]);
    expect(result.searchError).toBeNull();
    // 批准来源仍然被抓取成发现；搜索候选不落 findings
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.run.status).toBe('succeeded');
    expect(result.run.pages_fetched).toBe(1);
    // 查询来自出门说法
    expect(calls[0]?.query).toBe('Example project release notes');
  });

  it('零来源 + 出门说法 + 搜索可用：可先搜候选（run 成功、零页面）', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor } = mockExecutor({
      hits: [{ title: 'Only hit', url: 'https://only.example.com/z', snippet: 's' }],
    });
    const checker = new ResearchChecker(db, systemClock, {}, () => executor);
    const topic = checker.createTopic({
      question: '内部方向（含私人语境，不外发）',
      publicDescription: 'public facing query about a topic',
      sources: [],
    });
    const result = await checker.checkNow(topic.id);

    expect(result.searchUsed).toBe(true);
    expect(result.searchCandidates.length).toBe(1);
    expect(result.run.status).toBe('succeeded');
    expect(result.run.pages_fetched).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('零来源 + 无出门说法：仍然诚实失败，不假装搜过', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor, calls } = mockExecutor({ hits: [] });
    const checker = new ResearchChecker(db, systemClock, {}, () => executor);
    const topic = checker.createTopic({
      question: '只给方向',
      sources: [],
    });
    // 既有行为：校验失败记为失败 run（不是拒绝），页面按 last_failure 展示
    const result = await checker.checkNow(topic.id);
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('没有批准来源');
    expect(result.searchUsed).toBe(false);
    // 没有出门说法就不外发
    expect(calls).toEqual([]);
  });

  it('出门说法含 email：外发查询已被本地脱敏', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor, calls } = mockExecutor({ hits: [] });
    const checker = new ResearchChecker(db, systemClock, {}, () => executor);
    const topic = checker.createTopic({
      question: '私人问题',
      publicDescription: '联系 me@example.com 询问的那个公开项目动态',
      sources: [],
    });
    const result = await checker.checkNow(topic.id);

    expect(result.searchUsed).toBe(true);
    expect(calls[0]?.query).not.toContain('me@example.com');
    expect(calls[0]?.query).toContain('[已省略]');
  });

  it('定时轮次（tick）不搜索：额度只在用户在场时消耗', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor, calls } = mockExecutor({ hits: [] });
    const checker = new ResearchChecker(
      db,
      systemClock,
      { fetch: fakeFetch(FIXTURE_PAGE) },
      () => executor,
    );
    const topic = checker.store.createTopic({
      question: 'tick topic',
      publicDescription: 'public query',
      now: new Date().toISOString(),
      sources: [{ url: 'https://example.com/feed', kind: 'feed' as const }],
    } as never);
    // 启用 + 到期：tick 才会跑
    db.prepare(
      'UPDATE research_topics SET enabled = 1, paused = 0, next_check_at = ? WHERE id = ?',
    ).run(new Date(Date.now() - 60_000).toISOString(), topic.id);
    const result = await checker.tick();

    expect(result).not.toBeNull();
    expect(result!.searchUsed).toBe(false);
    expect(result!.mode).toBe('approved-sources-only');
    expect(result!.searchCandidates).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('搜索失败：批准来源轮次不受毁；零来源+搜索失败=如实记失败', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor } = mockExecutor({ error: new Error('搜索服务限流') });
    const checker = new ResearchChecker(
      db,
      systemClock,
      { fetch: fakeFetch(FIXTURE_PAGE) },
      () => executor,
    );
    const topic = checker.createTopic({
      question: '既有来源也有出门说法',
      publicDescription: 'some public query',
      sources: [{ url: 'https://example.com/releases', kind: 'page' as const }],
    });
    const result = await checker.checkNow(topic.id);

    // 来源轮次继续成功，搜索失败如实带回
    expect(result.run.status).toBe('succeeded');
    expect(result.searchUsed).toBe(true);
    expect(result.searchError).toContain('搜索服务限流');
    expect(result.findings.length).toBeGreaterThan(0);

    // 零来源 + 搜索失败 → run 失败（这轮什么都没干成）
    const topic2 = checker.createTopic({
      question: '只有方向',
      publicDescription: 'another public query',
      sources: [],
    });
    const result2 = await checker.checkNow(topic2.id);
    expect(result2.run.status).toBe('failed');
    expect(result2.run.error).toContain('搜索服务限流');
  });

  it('未配置搜索（provider 缺失）：行为与旧版一致', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const checker = new ResearchChecker(db, systemClock, { fetch: fakeFetch(FIXTURE_PAGE) });
    const topic = checker.createTopic({
      question: '没有搜索服务',
      publicDescription: '不会外发的问题',
      sources: [{ url: 'https://example.com/releases', kind: 'page' as const }],
    });
    const result = await checker.checkNow(topic.id);

    expect(result.searchUsed).toBe(false);
    expect(result.mode).toBe('approved-sources-only');
    expect(result.searchCandidates).toEqual([]);
    expect(result.searchError).toBeNull();
    expect(checker.searchAvailable).toBe(false);
  });

  it('搜索命中里非 HTTPS/重复的 URL 被过滤', async () => {
    const dir = tempDir();
    const db = makeDb(dir);
    const { executor } = mockExecutor({
      hits: [
        { title: 'Http hit', url: 'http://insecure.example.com/a', snippet: 's' },
        { title: 'Local hit', url: 'http://127.0.0.1:8080/b', snippet: 's' },
        { title: 'Dup', url: 'https://dup.example.com/c', snippet: 's' },
        { title: 'Dup2', url: 'https://dup.example.com/c', snippet: 's2' },
      ],
    });
    const checker = new ResearchChecker(db, systemClock, {}, () => executor);
    const topic = checker.createTopic({
      question: '过滤候选',
      publicDescription: 'filter candidates',
      sources: [],
    });
    const result = await checker.checkNow(topic.id);

    expect(result.searchCandidates.map((c) => c.url)).toEqual(['https://dup.example.com/c']);
  });
});
