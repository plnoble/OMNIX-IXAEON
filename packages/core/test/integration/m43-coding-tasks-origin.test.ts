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
 * 迁移 43（CF4）：coding_tasks 加 origin_conversation_id / origin_from_seq / origin_to_seq。
 * 旧行三列为空、其余字段不变；删对话时来源置空、seq 留着；seq 必须 >= 1。
 */

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m43-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-11-05T00:00:00.000Z';

function insertTask(id: string): void {
  db.prepare(
    `INSERT INTO coding_tasks (
       id, project_id, goal, scope_json, context_digest, allowed_commands_json, timeout_ms,
       status, version, generation, tests_modified, created_at, updated_at, acceptance_json
     ) VALUES (?, 'p1', '合成目标', '["."]', 'd', '[]', 1000, 'draft', 1, 0, 0, ?, ?, '[]')`,
  ).run(id, NOW, NOW);
}

describe('迁移 43：coding_tasks 记来源对话', () => {
  it('42 上的旧任务升级后三列为空、其余字段不变；删对话置空来源、seq 保留；seq 须 >= 1', () => {
    migrate(db, 42);
    expect(currentMigrationVersion(db)).toBe(42);
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', '合成项目甲', ?, ?)`,
    ).run(NOW, NOW);
    insertTask('t-old');
    const before = db.prepare(`SELECT * FROM coding_tasks WHERE id = 't-old'`).get() as Record<
      string,
      unknown
    >;

    migrate(db);
    expect(currentMigrationVersion(db)).toBeGreaterThanOrEqual(43);
    const after = db.prepare(`SELECT * FROM coding_tasks WHERE id = 't-old'`).get() as Record<
      string,
      unknown
    >;
    expect(after).toEqual({
      ...before,
      origin_conversation_id: null,
      origin_from_seq: null,
      origin_to_seq: null,
    });

    db.prepare(
      `INSERT INTO conversations (id, title, project_id, created_at, updated_at) VALUES ('c1', '合成对话', 'p1', ?, ?)`,
    ).run(NOW, NOW);
    insertTask('t-new');
    db.prepare(
      `UPDATE coding_tasks SET origin_conversation_id = 'c1', origin_from_seq = 1, origin_to_seq = 4 WHERE id = 't-new'`,
    ).run();
    expect(() =>
      db.prepare(`UPDATE coding_tasks SET origin_from_seq = 0 WHERE id = 't-new'`).run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(`UPDATE coding_tasks SET origin_conversation_id = 'nope' WHERE id = 't-new'`)
        .run(),
    ).toThrow();

    db.prepare(`DELETE FROM conversations WHERE id = 'c1'`).run();
    expect(
      db
        .prepare(
          `SELECT origin_conversation_id, origin_from_seq, origin_to_seq FROM coding_tasks WHERE id = 't-new'`,
        )
        .get(),
    ).toEqual({ origin_conversation_id: null, origin_from_seq: 1, origin_to_seq: 4 });

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'coding_tasks'`)
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_coding_tasks_origin_conversation');
  });
});
