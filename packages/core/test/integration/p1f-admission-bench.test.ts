import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  SearchService,
  createRetrievalAdapter,
  type CoreDatabase,
} from '../../src/index.js';

/** 从测试文件目录向上找到仓库根（含 package.json 与 pnpm-lock.yaml 的目录）。 */
function resolveRepoRoot(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'package.json')) && existsSync(join(cur, 'pnpm-lock.yaml'))) {
      return cur;
    }
    const parent = join(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error('未找到仓库根目录（package.json + pnpm-lock.yaml）');
}

/**
 * P1-F V0.3 准入基准（长期开发总计划 2026-09-16 第 P1-F 节）：
 * 1. ≥10,000 条合成混合消息（双平台导出混合）批量导入计时；
 * 2. 索引查询 P50/P95 延迟（多查询类型各 20 轮）；
 * 3. 索引重建计时（FTS 表删除重建）；
 * 4. 磁盘占用与进程内存记录（真实数字，不美化）；
 * 5. LanceDB/关键词适配对比：未获准嵌入模型时诚实降级并明示，
 *    不冒充语义检索已验收；
 * 6. 非空旧库副本升级/幂等/恢复演练（当前迁移链）；
 * 7. 发布清单绑定：版本/迁移号/依赖锁哈希写入 manifest 并校验。
 * 模型耗时另算（本套件不调用任何模型）。用户小范围试用不属于自动化范畴，
 * 如实标注「待用户试用」。
 */

let dir: string;
let db: CoreDatabase;
let search: SearchService;
let projectId: string;
let sources: SourceStore;

const CHATGPT_MSG_COUNT = 8_000;
const CLAUDE_MSG_COUNT = 4_000;
const TOTAL = CHATGPT_MSG_COUNT + CLAUDE_MSG_COUNT;

function buildChatgptExport(): string {
  const mapping: Record<
    string,
    {
      id: string;
      message: Record<string, unknown> | null;
      parent: string | null;
      children: string[];
    }
  > = { root: { id: 'root', message: null, parent: null, children: [] } };
  let prev = 'root';
  for (let i = 0; i < CHATGPT_MSG_COUNT; i++) {
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
              ? `准入基准用户消息 ${i}：架构设计与检索质量采样。`
              : `准入基准助手消息 ${i}：跨项目记忆与预算约束采样。`,
          ],
        },
      },
      parent: prev,
      children: [],
    };
    mapping[prev]!.children.push(id);
    prev = id;
  }
  return JSON.stringify([
    {
      title: 'P1F 准入基准 ChatGPT 对话',
      create_time: 1_700_000_000,
      conversation_id: 'p1f-chatgpt-001',
      current_node: prev,
      mapping,
    },
  ]);
}

function buildClaudeExport(): string {
  const chat_messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < CLAUDE_MSG_COUNT; i++) {
    chat_messages.push({
      uuid: `c${i}`,
      text:
        i % 2 === 0
          ? `Claude 导出用户回合 ${i}：本地优先知识管理与权限传播。`
          : `Claude 导出助手回合 ${i}：受控执行器与独立验证采样。`,
      sender: i % 2 === 0 ? 'human' : 'assistant',
      created_at: new Date(1_700_100_000 + i * 1000).toISOString(),
    });
  }
  return JSON.stringify([
    {
      name: 'P1F 准入基准 Claude 对话',
      created_at: new Date(1_700_100_000).toISOString(),
      chat_messages,
    },
  ]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p1f-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const projects = new ProjectService(db);
  projectId = projects.create({ name: 'P1F 准入', rootPath: null, description: null }).id;
  search = new SearchService(db);
  sources = new SourceStore(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P1-F 准入基准（≥10k 混合消息）', () => {
  it(`导入 ${TOTAL.toLocaleString()} 条混合消息（ChatGPT ${CHATGPT_MSG_COUNT} + Claude ${CLAUDE_MSG_COUNT}）`, () => {
    const chatgptFile = join(dir, 'chatgpt.json');
    const claudeFile = join(dir, 'claude.json');
    writeFileSync(chatgptFile, buildChatgptExport());
    writeFileSync(claudeFile, buildClaudeExport());

    const vault = new Vault(join(dir, 'vault'));
    const perms = new PermissionService(db);
    const imports = new ImportService(db, vault, perms, sources);

    const started = Date.now();
    const r1 = imports.importFile(chatgptFile, {
      projectId,
      permissionId: perms.grantFile(chatgptFile).id,
    });
    const r2 = imports.importFile(claudeFile, {
      projectId,
      permissionId: perms.grantFile(claudeFile).id,
    });
    const seconds = (Date.now() - started) / 1000;
    console.log(`[P1F] import ${TOTAL} mixed messages: ${seconds.toFixed(2)}s`);
    expect(r1.created.length).toBe(1);
    expect(r2.created.length).toBe(1);

    const n = (db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n;
    console.log(`[P1F] segments count: ${n}`);
    expect(n).toBe(TOTAL);
    expect(seconds).toBeLessThan(60);
  }, 120_000);

  it('索引查询 P50/P95 延迟（3 类查询 × 20 轮）', () => {
    const queries = [
      '架构设计', // 常见中文词（FTS trigram）
      '权限传播', // 次常见词
      '准入基准助手消息 3999', // 精确定位（数字）
    ];
    const stats: Array<{ query: string; p50: number; p95: number }> = [];
    // 预热页缓存
    for (const q of queries) search.searchSegments(q, { limit: 20 });

    for (const q of queries) {
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        const hits = search.searchSegments(q, { limit: 20 });
        samples.push(performance.now() - t0);
        expect(hits.length).toBeGreaterThan(0);
      }
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length * 0.5)]!;
      const p95 = samples[Math.floor(samples.length * 0.95) - (samples.length > 1 ? 1 : 0)]!;
      stats.push({ query: q, p50, p95 });
      console.log(`[P1F] query '${q}' P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms`);
      expect(p95).toBeLessThan(500);
    }
    // 全部三类的 P95 都必须 < 500ms（已在循环内断言）；P50 记录进报告
    expect(stats.length).toBe(3);
  });

  it('索引重建（FTS 表删除重建）计时与一致性', () => {
    const dropStart = Date.now();
    db.exec('DROP TABLE IF EXISTS segments_fts');
    db.exec(`
      CREATE VIRTUAL TABLE segments_fts USING fts5(
        text, content='segments', content_rowid='rowid', tokenize='trigram'
      )
    `);
    db.exec('INSERT INTO segments_fts(rowid, text) SELECT rowid, text FROM segments');
    const rebuildMs = Date.now() - dropStart;
    console.log(`[P1F] FTS rebuild over ${TOTAL} rows: ${rebuildMs}ms`);

    // 重建后检索仍正确
    const hits = search.searchSegments('架构设计', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(rebuildMs).toBeLessThan(60_000);
  });

  it('磁盘占用与进程内存（真实数字记录）', () => {
    const dbBytes = statSync(join(dir, 'ixaeon.db')).size;
    const rss = process.memoryUsage().rss;
    console.log(
      `[P1F] db size: ${(dbBytes / 1024 / 1024).toFixed(1)} MB, RSS: ${(rss / 1024 / 1024).toFixed(0)} MB`,
    );
    expect(dbBytes).toBeGreaterThan(1_000_000); // 至少有真实数据量
  });

  it('LanceDB/关键词适配对比：未获准嵌入时诚实降级，不冒充语义验收', () => {
    const adapter = createRetrievalAdapter(db);
    const hit = adapter.lookup('架构设计', { projectId, limit: 10 });
    if (adapter.backend === 'keyword') {
      expect(hit.degraded).toBe(false);
      expect(hit.notice).toContain('关键词检索');
      console.log('[P1F] retrieval backend: keyword（语义索引未启用，如实标注）');
    } else {
      // LanceDB 声明但嵌入未获准：必须 degraded=true 并明示未验收
      expect(hit.degraded).toBe(true);
      expect(hit.notice).toContain('降级');
      console.log('[P1F] retrieval backend: lancedb-degraded（未获准嵌入，非语义验收）');
    }
    expect(hit.segments.length).toBeGreaterThan(0);
  });

  it('非空旧库副本升级/幂等/恢复演练（当前迁移链）', () => {
    // 当前库已含非空数据：复制副本 → 重开 → 迁移幂等 → 计数一致
    const before = {
      segments: (db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n,
      sources: (db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n,
    };
    const versionBefore = currentMigrationVersion(db);
    expect(versionBefore).toBeGreaterThanOrEqual(24);

    db.close();
    const copyPath = join(dir, 'copy.db');
    copyFileSync(join(dir, 'ixaeon.db'), copyPath);
    db = openDatabase(copyPath);
    migrate(db); // 幂等重放
    expect(currentMigrationVersion(db)).toBe(versionBefore);

    const after = {
      segments: (db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n,
      sources: (db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n,
    };
    expect(after).toEqual(before);
    console.log(
      `[P1F] copy upgrade drill: ${JSON.stringify(after)} preserved, migration v${versionBefore} idempotent`,
    );
  });

  it('发布清单绑定：版本/迁移号/依赖锁哈希写入 manifest 并校验', () => {
    const rootDir = resolveRepoRoot(import.meta.dirname);
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as {
      version: string;
    };
    const lockHash = createHash('sha256')
      .update(readFileSync(join(rootDir, 'pnpm-lock.yaml')))
      .digest('hex');
    const migrationVersion = currentMigrationVersion(db);

    const manifest = {
      admission: 'P1F',
      appVersion: pkg.version,
      migrationVersion,
      lockHash: lockHash.slice(0, 16),
      generatedAt: new Date().toISOString(),
      pending: [
        '用户小范围试用未发生（P1-F 出口要求，不属于自动化范畴）',
        'LanceDB 语义对比未获准嵌入模型，语义检索未验收',
      ],
    };
    console.log(`[P1F] release manifest: ${JSON.stringify(manifest)}`);
    expect(manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.migrationVersion).toBeGreaterThanOrEqual(24);
    expect(manifest.lockHash).toHaveLength(16);
    expect(manifest.pending.length).toBe(2);
  });
});
