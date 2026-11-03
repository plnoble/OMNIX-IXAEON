import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * 迁移 42（CF3）：runtime_runs 的 engine 允许 direct；旧行、索引原样保留，别的值照旧拒绝。
 */

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m42-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insert = (id: string, engine: string) =>
  db
    .prepare(
      `INSERT INTO runtime_runs (id, goal, project_id, engine, status, events_json, notice, created_at)
       VALUES (?, '合成问题', NULL, ?, 'succeeded', '[{"tool":"text"}]', '合成说明', '2026-11-03T00:00:00.000Z')`,
    )
    .run(id, engine);

describe('迁移 42：runtime_runs 加 direct', () => {
  it('41 上的旧行升级后逐字段不变，direct 能写，别的值照旧拒绝', () => {
    migrate(db, 41);
    expect(currentMigrationVersion(db)).toBe(41);
    insert('run-h', 'hermes');
    insert('run-c', 'core-bounded');
    expect(() => insert('run-d0', 'direct')).toThrow();
    const before = db.prepare('SELECT * FROM runtime_runs ORDER BY id').all();

    migrate(db);
    expect(currentMigrationVersion(db)).toBeGreaterThanOrEqual(42);
    expect(db.prepare('SELECT * FROM runtime_runs ORDER BY id').all()).toEqual(before);
    insert('run-d', 'direct');
    expect(db.prepare(`SELECT engine FROM runtime_runs WHERE id = 'run-d'`).get()).toEqual({
      engine: 'direct',
    });
    expect(() => insert('run-x', 'something-else')).toThrow();
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runtime_runs'`)
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_runtime_runs_created');
  });
});
