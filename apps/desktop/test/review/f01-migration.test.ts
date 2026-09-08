/** F01 附验：模拟旧库（迁移 8 时有 needs_review=1 数据）升级到迁移 9 的回填。 */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '@ixaeon/core';

it('F01-c: old database with needs_review=1 rows migrates conservatively (reasons backfilled, state kept)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-f01-mig-'));
  const db = new Database(join(dir, 'old.db'));
  // 应用迁移 1-8（模拟旧库）
  for (const m of MIGRATIONS.filter((x) => x.id <= 8)) {
    db.exec('BEGIN');
    db.exec(m.sql);
    db.exec('COMMIT');
  }
  // 造一条旧数据：未确认的重要 AI 决定（无项目）→ needs_review=1
  db.prepare(
    `INSERT INTO items (id, project_id, type, statement, rationale, state, confidence,
       origin, observed_at, created_at, updated_at, needs_review)
     VALUES ('old-1', NULL, 'decision', '旧库重要决定', NULL, 'current', 0.9,
       'ai', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1)`,
  ).run();
  // 一条 needs_review=0 的普通条目（有项目，先建项目行满足外键）
  db.prepare(
    `INSERT INTO projects (id, name, status, created_at, updated_at)
     VALUES ('p1', '旧项目', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO items (id, project_id, type, statement, rationale, state, confidence,
       origin, observed_at, created_at, updated_at, needs_review)
     VALUES ('old-2', 'p1', 'preference', '旧库普通偏好', NULL, 'current', 0.9,
       'ai', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)`,
  ).run();
  // 应用迁移 9
  const m9 = MIGRATIONS.find((x) => x.id === 9)!;
  db.exec('BEGIN');
  db.exec(m9.sql);
  db.exec('COMMIT');

  const row1 = db
    .prepare('SELECT needs_reasons, needs_review FROM items WHERE id = ?')
    .get('old-1') as { needs_reasons: string; needs_review: number };
  // 保守回填：no_project + unconfirmed + manual（宁可多留，不静默清历史待处理）
  expect(row1.needs_review).toBe(1);
  expect(row1.needs_reasons).toContain('no_project');
  expect(row1.needs_reasons).toContain('unconfirmed');
  expect(row1.needs_reasons).toContain('manual');

  const row2 = db
    .prepare('SELECT needs_reasons, needs_review FROM items WHERE id = ?')
    .get('old-2') as { needs_reasons: string; needs_review: number };
  expect(row2.needs_review).toBe(0);
  expect(row2.needs_reasons).toBe('');
  db.close();
});
