/** Independent review of 1dad8d4. Synthetic data; no real model or production edits. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  MIGRATIONS,
  currentMigrationVersion,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';

function getNeedsReasons(db: CoreDatabase, itemId: string): Set<string> {
  const row = db.prepare('SELECT needs_reasons FROM items WHERE id = ?').get(itemId) as
    { needs_reasons: string } | undefined;
  return new Set((row?.needs_reasons ?? '').split(',').filter(Boolean));
}

const databases: CoreDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-needs-lifecycle-'));
  const db = openDatabase(join(dir, 'test.db'));
  databases.push(db);
  migrate(db);
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, sources);
  const items = new ItemService(db);
  const project = new ProjectService(db).create({
    name: 'Lifecycle',
    rootPath: null,
    description: null,
  });
  const path = join(dir, 'evidence.md');
  writeFileSync(path, '# Lifecycle\n\nSYNTHETIC_LIFECYCLE_EVIDENCE\n');
  const source = imports.importFile(path, {
    projectId: project.id,
    permissionId: permissions.grantFile(path).id,
  }).created[0]!;
  const extract = (statement: string, type: 'constraint' | 'decision' = 'decision') =>
    new Extractor(
      db,
      new FakeProvider().enqueueStructured({
        items: [
          {
            type,
            statement,
            excerpt: 'SYNTHETIC_LIFECYCLE_EVIDENCE',
            segment_ref: 'S2',
            confidence: 0.95,
            rationale: null,
            project_hint: null,
          },
        ],
      }),
    ).extractSource(source.id);
  return { db, source, sources, items, project, extract };
}

it('L01: correction must retire the predecessor from pending work while retaining its history', async () => {
  const f = fixture();
  await f.extract('先采用方案甲');
  const old = f.items.list({ projectId: f.project.id })[0]!;
  expect(getNeedsReasons(f.db, old.id).has('unconfirmed')).toBe(true);
  const correction = f.items.correct({ itemId: old.id, userText: '改用方案乙' });
  expect(f.items.get(old.id).state).toBe('superseded');
  expect(f.items.get(correction.newItem.id).statement).toBe('改用方案乙');
  expect.soft(f.items.get(old.id).needs_review).toBe(false);
  expect.soft([...getNeedsReasons(f.db, old.id)]).toEqual([]);
  const inbox = f.items.list({ projectId: null, needsReview: true, shelved: false });
  expect(inbox.map((i) => i.id)).not.toContain(old.id);
});

it('L02: correction must retire persistent conflict/manual reasons on the superseded predecessor', async () => {
  const f = fixture();
  await f.extract('日志保留期限为三十天', 'constraint');
  const first = f.items.list({ projectId: f.project.id })[0]!;
  f.items.correct({ itemId: first.id, userText: '项目日志可以发送到远程服务器保存和分析' });
  await f.extract('项目日志不可以发送到远程服务器保存和分析', 'constraint');
  const opposite = f.items
    .list({ projectId: f.project.id })
    .find((i) => i.statement.includes('不可以'))!;
  f.items.setPendingReview(opposite.id, true);
  expect(getNeedsReasons(f.db, opposite.id).has('conflict')).toBe(true);
  f.items.correct({ itemId: opposite.id, userText: '纠正：只发送经人工审核的脱敏日志' });
  expect(f.items.get(opposite.id).state).toBe('superseded');
  expect.soft(f.items.get(opposite.id).needs_review).toBe(false);
  expect([...getNeedsReasons(f.db, opposite.id)]).toEqual([]);
});

for (const action of ['confirm', 'reject'] as const) {
  it(`L03-${action}: control - resolved reasons stay cleared after ordinary project rebinding`, async () => {
    const f = fixture();
    await f.extract('采用当前打包方案');
    const old = f.items.list({ projectId: f.project.id })[0]!;
    f.items.setPendingReview(old.id, true);
    f.items[action](old.id);
    expect([...getNeedsReasons(f.db, old.id)]).toEqual([]);
    f.sources.bindProject(f.source.id, f.project.id);
    f.items.assignToProject(old.id, f.project.id);
    expect(f.items.get(old.id).needs_review).toBe(false);
  });
}

it('L04: control - real migration runner upgrades a populated v8 fixture and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-needs-migration-'));
  const db = openDatabase(join(dir, 'v8.db'));
  databases.push(db);
  db.exec(
    'CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)',
  );
  for (const migration of MIGRATIONS.filter((m) => m.id <= 8)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        '2026-09-01T00:00:00Z',
      );
    })();
  }
  db.exec(
    "INSERT INTO projects(id,name,status,created_at,updated_at) VALUES('p','Old project','active','2026-09-01','2026-09-01')",
  );
  const insert = db.prepare(
    "INSERT INTO items(id,project_id,type,statement,state,confidence,origin,created_at,updated_at,needs_review) VALUES(?, 'p', 'constraint', ?, ?, 0.9, 'ai', '2026-09-01', '2026-09-01', ?)",
  );
  insert.run('pending', 'PENDING_HISTORICAL', 'current', 1);
  insert.run('conflict', 'CONFLICT_HISTORICAL', 'disputed', 1);
  insert.run('resolved', 'RESOLVED_HISTORICAL', 'current', 0);
  expect(currentMigrationVersion(db)).toBe(8);
  migrate(db);
  // N01 修复新增迁移 10（superseded 旧条目退出待处理）——最终版本随
  // 迁移账本演进，断言「升到最新且只执行一次」而非固定数字。
  const latest = Math.max(...MIGRATIONS.map((m) => m.id));
  expect(currentMigrationVersion(db)).toBe(latest);
  // v8 历史行：待处理/冲突保守保留；非待处理保持为空（迁移 9 语义）
  expect(getNeedsReasons(db, 'pending').has('manual')).toBe(true);
  expect(getNeedsReasons(db, 'conflict').has('conflict')).toBe(true);
  expect([...getNeedsReasons(db, 'resolved')]).toEqual([]);
  // 三行都不是 superseded —— 迁移 10 不应触碰它们
  const states = db
    .prepare('SELECT id, state, needs_review FROM items ORDER BY id')
    .all() as Array<{ id: string; state: string; needs_review: number }>;
  expect(states.find((r) => r.id === 'pending')!.needs_review).toBe(1);
  expect(states.find((r) => r.id === 'conflict')!.needs_review).toBe(1);
  expect(states.find((r) => r.id === 'resolved')!.needs_review).toBe(0);
  const snapshot = db.prepare('SELECT * FROM items ORDER BY id').all();
  migrate(db);
  expect(db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(snapshot);
  expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?').get(latest)).toEqual({
    n: 1,
  });
});
