import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  CoreToolBroker,
  createWebSearchExecutor,
  ItemService,
  ProjectService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
} from '../../src/index.js';

/**
 * B3 真机搜索探针：IXAEON_REAL_SEARCH=1 + IXAEON_SEARCH_PROVIDER + IXAEON_SEARCH_API_KEY。
 * 真服务真 Key 真查询；断言拿到带 URL 的真实命中。默认跳过。
 * 失败也算证据（Key 无效/额度尽会如实报错）。
 */
const run =
  process.env.IXAEON_REAL_SEARCH === '1' &&
  (process.env.IXAEON_SEARCH_PROVIDER === 'brave' ||
    process.env.IXAEON_SEARCH_PROVIDER === 'tavily') &&
  Boolean(process.env.IXAEON_SEARCH_API_KEY);

describe.skipIf(!run)('B3 真机网页搜索（真实服务）', () => {
  it('search_web 经真服务返回真实 URL 命中', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-b3-real-'));
    mkdirSync(join(dir, 'vault'), { recursive: true });
    const db = openDatabase(join(dir, 'ixaeon.db'));
    try {
      migrate(db);
      const projects = new ProjectService(db);
      const items = new ItemService(db);
      const search = new SearchService(db);
      const coding = new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'vault'));
      const broker = new CoreToolBroker(
        db,
        items,
        search,
        coding,
        projects,
        {},
        createWebSearchExecutor(
          process.env.IXAEON_SEARCH_PROVIDER as 'brave' | 'tavily',
          process.env.IXAEON_SEARCH_API_KEY as string,
        ),
      );
      const result = (await broker.invoke(
        'search_web',
        { query: 'Rust programming language official site', limit: 3 },
        { audience: 'model', runId: 'b3-real' },
      )) as {
        provider: string;
        redacted: boolean;
        hits: Array<{ title: string; url: string; snippet: string }>;
      };
      expect(result.provider).toBe(process.env.IXAEON_SEARCH_PROVIDER);
      expect(result.hits.length).toBeGreaterThan(0);
      // 真实命中必须是 http(s) URL（模拟页面过不了这关）
      for (const hit of result.hits) {
        expect(hit.url).toMatch(/^https?:\/\//);
        expect(hit.title.length).toBeGreaterThan(0);
      }
      console.log(
        `B3 真机搜索（${result.provider}）命中 ${result.hits.length} 条，首条：${result.hits[0]?.title}`,
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
