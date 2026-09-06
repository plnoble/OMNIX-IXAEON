import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  MIGRATIONS,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  JobQueue,
  IxaError,
  ErrorCodes,
} from '../../src/index.js';

/**
 * v0.1.1 M0 收尾（core 层）：
 * - 迁移 2：sources 版本三元组 + jobs.not_before + session_aliases；
 *   旧库（仅迁移 1）升级不丢数据，旧行回填 content=analyzed=1；
 * - contentRevision 语义：导入=1，追加影响理解的内容递增，重复提交不递增；
 * - analyzed_revision 只前进不回退；
 * - JobQueue 暂时性失败有限退避重试（默认 3 次），非暂时性失败不重试。
 */

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m0-core-'));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 下 WAL 文件可能被短暂占用：清理失败不影响测试结果
  }
});

describe('迁移 2：版本三元组与调度列', () => {
  it('旧库（仅迁移 1）升级：列补齐、数据完整、旧行回填 content=analyzed=1', () => {
    const dbPath = join(dir, 'upgrade.db');
    const old = openDatabase(dbPath);
    // 构造「旧版本数据库」：只应用迁移 1，并登记迁移记录（模拟真实旧库）
    old.exec(MIGRATIONS[0]!.sql);
    old.exec(
      `CREATE TABLE schema_migrations (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         applied_at TEXT NOT NULL
       );
       INSERT INTO schema_migrations (id, name, applied_at) VALUES (1, 'init-core-schema', '2026-01-01T00:00:00Z');`,
    );
    old
      .prepare(
        `INSERT INTO projects (id, name, root_path, description, status, created_at, updated_at)
       VALUES ('p-old', '旧库项目', NULL, NULL, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
       VALUES ('perm-old', 'file', 'C:/old/seed.md', 'once', 'active', '2026-01-01T00:00:00Z', NULL)`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
        captured_at, imported_at, permission_id, project_id, metadata_json)
       VALUES ('src-old', 'document', 'local_file', 'C:/old/seed.md', '旧来源',
        '${'a'.repeat(64)}', 'sha256/aa/${'a'.repeat(64)}', NULL,
        '2026-01-01T00:00:00Z', 'perm-old', 'p-old', '{}')`,
      )
      .run();
    old.close();

    // 升级（完整 migrate）
    const upgraded = openDatabase(dbPath);
    migrate(upgraded);
    const row = upgraded
      .prepare(
        'SELECT content_revision AS c, analyzed_revision AS a, title FROM sources WHERE id = ?',
      )
      .get('src-old') as { c: number; a: number; title: string };
    expect(row.c).toBe(1);
    // G3c（迁移 7）：该旧来源从未分析过（无 items、无 succeeded 任务）——
    // 迁移 2 的统一回填被修正为待分析 0；是否补分析由启动扫描按开关控制
    expect(row.a).toBe(0);
    expect(row.title).toBe('旧来源');
    // 新列可用
    upgraded.prepare('SELECT not_before FROM jobs LIMIT 1').all();
    upgraded.prepare('SELECT external_id FROM session_aliases LIMIT 1').all();
    upgraded.close();
  });

  it('contentRevision 语义：导入=1，追加影响理解的内容递增，完全重复不递增', () => {
    const d = mkdtempSync(join(tmpdir(), 'ixaeon-m0-rev-'));
    const db = openDatabase(join(d, 'ixaeon.db'));
    migrate(db);
    const vault = new Vault(join(d, 'vault'));
    const perms = new PermissionService(db);
    const sources = new SourceStore(db);
    new ProjectService(db);
    const file = join(d, 'rev.md');
    writeFileSync(file, '# 版本语义\n\nREV_MARK 初版。', 'utf8');
    const created = new ImportService(db, vault, perms, sources).importFile(file, {
      projectId: null,
      permissionId: perms.grantFile(file).id,
    }).created[0]!;
    expect(sources.getRevisions(created.id)).toEqual({ content: 1, analyzed: 0 });

    // 追加新内容 → 递增
    sources.appendCapturedTurns(created.id, [
      { order: 10, role: 'user', text: '追加的新回答 REV_APPEND' },
    ]);
    expect(sources.getRevisions(created.id).content).toBe(2);

    // 完全重复提交 → 不递增
    sources.appendCapturedTurns(created.id, [
      { order: 10, role: 'user', text: '追加的新回答 REV_APPEND' },
    ]);
    expect(sources.getRevisions(created.id).content).toBe(2);

    // analyzed 只前进：推进到 2 后，旧 target 1 不能回退
    expect(sources.advanceAnalyzedRevision(created.id, 2)).toBe(2);
    expect(sources.advanceAnalyzedRevision(created.id, 1)).toBe(2);
    db.close();
    rmSync(d, { recursive: true, force: true });
  });
});

describe('JobQueue 暂时性失败有限退避重试（M0.2 第 7 条）', () => {
  it('暂时性失败：退避重试至多 3 次后 failed；not_before 期间不执行', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ixaeon-m0-retry-'));
    const db = openDatabase(join(d, 'ixaeon.db'));
    migrate(db);
    const queue = new JobQueue(db, undefined, { retryBackoffMs: [30, 30, 30] });
    let calls = 0;
    queue.register('flaky', async () => {
      calls += 1;
      throw new IxaError(ErrorCodes.MODEL_CALL_FAILED, '模拟暂时性模型失败');
    });
    const job = queue.enqueue('flaky', {});
    await (queue as unknown as { tick(): Promise<void> }).tick();
    // 第一次失败 → 重新排队（retry_count 1，not_before 在未来）
    const after1 = queue.get(job.id)!;
    expect(after1.status).toBe('queued');
    expect(after1.retry_count).toBe(1);
    expect(after1.not_before).toBeTruthy();
    expect(new Date(after1.not_before!).getTime()).toBeGreaterThan(Date.now() - 1000);
    // not_before 未到：不执行
    await (queue as unknown as { tick(): Promise<void> }).tick();
    expect(calls).toBe(1);
    // 等退避窗口过后继续；共重试 3 次后 failed
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 40));
      await (queue as unknown as { tick(): Promise<void> }).tick();
    }
    expect(calls).toBe(4); // 首次 + 3 次重试
    const done = queue.get(job.id)!;
    expect(done.status).toBe('failed');
    expect(done.retry_count).toBe(3);
    queue.stop();
    db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it('非暂时性失败（校验/权限/取消类）不自动重试', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ixaeon-m0-noretry-'));
    const db = openDatabase(join(d, 'ixaeon.db'));
    migrate(db);
    const queue = new JobQueue(db, undefined, { retryBackoffMs: [10] });
    let calls = 0;
    queue.register('bad', async () => {
      calls += 1;
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '无效引用，非暂时性');
    });
    const job = queue.enqueue('bad', {});
    await (queue as unknown as { tick(): Promise<void> }).tick();
    expect(queue.get(job.id)!.status).toBe('failed');
    expect(queue.get(job.id)!.retry_count).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    await (queue as unknown as { tick(): Promise<void> }).tick();
    expect(calls).toBe(1);
    queue.stop();
    db.close();
    rmSync(d, { recursive: true, force: true });
  });
});
