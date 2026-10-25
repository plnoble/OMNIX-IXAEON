import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  SearchService,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * M5 性能测试（计划 11）：
 * - 50,000 条消息导入：流式（不复制多份）且秒级完成（不调模型）
 * - 全文搜索前 20 条结果 < 500 ms
 */

let dir: string;
let db: CoreDatabase;
let search: SearchService;
let projectId: string;
let sources: SourceStore;

const MESSAGE_COUNT = 50_000;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-perf-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const projects = new ProjectService(db);
  projectId = projects.create({ name: '性能测试', rootPath: null, description: null }).id;
  search = new SearchService(db);
  sources = new SourceStore(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M5 性能（50,000 条消息）', () => {
  it('批量导入 50k 条消息（流式 + 事务）', () => {
    // 生成 50k 消息的 ChatGPT 导出（mapping 树：root → m0 → m1 → …）
    const mapping: Record<
      string,
      { id: string; message: Record<string, unknown> | null; parent: string | null; children: string[] }
    > = {
      root: { id: 'root', message: null, parent: null, children: [] },
    };
    let prev = 'root';
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      const id = `m${i}`;
      mapping[id] = {
        id,
        message: {
          id,
          author: { role: i % 2 === 0 ? 'user' : 'assistant' },
          create_time: 1_700_000_000 + i,
          content: {
            content_type: 'text',
            parts: [
              i % 2 === 0
                ? `用户消息 ${i}：IXAEON 性能测试样本，涉及架构设计与本地存储。`
                : `助手回答 ${i}：本地优先的知识管理工具按项目组织原始资料。`,
            ],
          },
        },
        parent: prev,
        children: [],
      };
      mapping[prev]!.children.push(id);
      prev = id;
    }
    const exportJson = [
      {
        title: '性能测试对话',
        create_time: 1_700_000_000,
        conversation_id: 'perf-conv-001',
        current_node: prev,
        mapping,
      },
    ];
    const file = join(dir, 'conversations.json');
    writeFileSync(file, JSON.stringify(exportJson));

    const vault = new Vault(join(dir, 'vault'));
    const perms = new PermissionService(db);
    const imports = new ImportService(db, vault, perms, sources);
    const started = Date.now();
    const result = imports.importFile(file, {
      projectId,
      permissionId: perms.grantFile(file).id,
    });
    const seconds = (Date.now() - started) / 1000;
    console.log(`import 50k messages: ${seconds.toFixed(2)}s`);
    expect(result.created.length).toBe(1);
    expect(seconds).toBeLessThan(30); // 50k 条：宽裕上限（SQLite 批量事务）
  });

  it('导入后消息数 = 50,000', () => {
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }
    ).n;
    console.log(`segments count: ${n}`);
    expect(n).toBe(MESSAGE_COUNT);
  });

  it('全文搜索前 20 条结果 < 500 ms', () => {
    // 冷查询一次（预热 SQLite 页缓存，量测目标：稳态查询）
    search.searchSegments('架构设计', { limit: 20 });
    const started = performance.now();
    const hits = search.searchSegments('架构设计', { limit: 20 });
    const ms = performance.now() - started;
    console.log(`search '架构设计' top20: ${ms.toFixed(1)}ms, hits=${hits.length}`);
    expect(hits.length).toBeGreaterThanOrEqual(20); // 50k 中的偶数消息都含该词
    expect(ms).toBeLessThan(500);
  });

  it('罕见词搜索同样 < 500 ms', () => {
    const started = performance.now();
    const hits = search.searchSegments('知识管理工具', { limit: 20 });
    const ms = performance.now() - started;
    console.log(`search '知识管理工具' top20: ${ms.toFixed(1)}ms, hits=${hits.length}`);
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});
