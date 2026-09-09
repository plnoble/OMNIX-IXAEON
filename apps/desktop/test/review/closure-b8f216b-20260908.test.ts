/** Bounded independent acceptance of N01/N02. All rows are synthetic. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ItemService, MIGRATIONS, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';

const databases: CoreDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function open(path: string) {
  const db = openDatabase(path);
  databases.push(db);
  return db;
}

function fixture(version?: number) {
  const path = join(mkdtempSync(join(tmpdir(), 'ixaeon-closure-b8f216b-')), 'synthetic.db');
  const db = open(path);
  if (version === undefined) {
    migrate(db);
  } else {
    db.exec(
      'CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.id <= version)) {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
          migration.id,
          migration.name,
          '2026-09-08T00:00:00Z',
        );
      })();
    }
  }
  db.exec(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','Synthetic project','2026-09-08','2026-09-08')",
  );
  return { db, path, items: new ItemService(db) };
}

function seed(
  db: CoreDatabase,
  id: string,
  state: 'current' | 'disputed' | 'superseded',
  reasons: string,
  projectId: string | null = 'p',
) {
  db.prepare(
    `INSERT INTO items(id,project_id,type,statement,state,origin,created_at,updated_at,needs_review,needs_reasons)
     VALUES(?, ?, 'decision', ?, ?, 'ai', '2026-09-08', '2026-09-08', ?, ?)`,
  ).run(id, projectId, `SYNTHETIC ${id}`, state, reasons ? 1 : 0, reasons);
}

function row(db: CoreDatabase, id: string) {
  return db.prepare('SELECT * FROM items WHERE id=?').get(id) as Record<string, unknown>;
}

it('C01: migration 10 retires only historical pending rows, retaining history and other rows', () => {
  const f = fixture(9);
  seed(f.db, 'old', 'superseded', 'conflict,manual');
  seed(f.db, 'new', 'current', 'unconfirmed,manual');
  seed(f.db, 'other-conflict', 'disputed', 'conflict,manual');
  seed(f.db, 'already-retired', 'superseded', '');
  seed(f.db, 'unassigned-history', 'superseded', 'no_project,manual', null);
  f.db.prepare('UPDATE items SET supersedes_item_id=? WHERE id=?').run('old', 'new');
  f.db.exec("INSERT INTO corrections VALUES('c','old','SYNTHETIC correction','new','2026-09-08')");
  const before = f.db.prepare('SELECT * FROM items ORDER BY id').all() as Array<
    Record<string, unknown>
  >;
  const historyBefore = f.db.prepare('SELECT * FROM corrections').all();
  migrate(f.db);
  for (const previous of before) {
    const expected =
      previous.state === 'superseded' && previous.needs_review === 1
        ? { ...previous, needs_review: 0, needs_reasons: '' }
        : previous;
    // 迁移 11 追加 scope：有项目 → project，空归属 → unassigned；不改纠正链。
    expect(row(f.db, previous.id as string)).toEqual({
      ...expected,
      scope: previous.project_id ? 'project' : 'unassigned',
    });
  }
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: before.length });
  expect(f.db.prepare('SELECT * FROM corrections').all()).toEqual(historyBefore);
  const once = f.db.prepare('SELECT * FROM items ORDER BY id').all();
  migrate(f.db);
  expect(f.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(once);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id=10').get()).toEqual({
    n: 1,
  });
});

it('C02: a failed correction rolls back both predecessor state and reason clearing', () => {
  const f = fixture();
  seed(f.db, 'old', 'current', 'unconfirmed,conflict,manual');
  const before = row(f.db, 'old');
  expect(() =>
    f.items.correct({ itemId: 'old', userText: 'Synthetic correction', projectId: 'missing' }),
  ).toThrow();
  expect(row(f.db, 'old')).toEqual(before);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
  expect(f.items.listCorrections(null)).toEqual([]);
});

it('C03: correction retires all old reasons and preserves unrelated conflict through reopen', () => {
  const f = fixture();
  seed(f.db, 'old', 'current', 'no_project,unconfirmed,conflict,manual', null);
  seed(f.db, 'other', 'disputed', 'conflict,manual');
  const other = row(f.db, 'other');
  f.items.shelve('old', true);
  const correction = f.items.correct({
    itemId: 'old',
    userText: 'Synthetic correction',
    projectId: 'p',
  });
  expect(row(f.db, 'old').needs_reasons).toBe('');
  expect(row(f.db, 'other')).toEqual(other);
  expect(correction.newItem.statement).toBe('Synthetic correction');
  f.items.assignToProject('old', 'p');
  f.db.close();
  const reopened = open(f.path);
  migrate(reopened);
  const items = new ItemService(reopened);
  expect(items.get('old').state).toBe('superseded');
  expect(items.get('old').needs_review).toBe(false);
  expect(row(reopened, 'old').needs_reasons).toBe('');
  expect(items.listCorrections(null)[0]!.oldItem.id).toBe('old');
  expect(items.listCorrections(null)[0]!.newItem.id).toBe(correction.newItem.id);
  expect(items.list({ projectId: null, needsReview: true, shelved: true })).toEqual([]);
  expect(row(reopened, 'other')).toEqual(other);
});

it('C04: shelve, reopen and resume preserve every reason, without confirming or rejecting', () => {
  const f = fixture();
  seed(f.db, 'pending', 'current', 'no_project,unconfirmed,conflict,manual', null);
  const before = row(f.db, 'pending');
  f.items.shelve('pending', true);
  const shelved = row(f.db, 'pending');
  expect(shelved.shelved_at).toEqual(expect.any(String));
  expect(shelved).toEqual({
    ...before,
    shelved_at: shelved.shelved_at,
    updated_at: shelved.updated_at,
  });
  f.db.close();
  const reopened = open(f.path);
  migrate(reopened);
  const items = new ItemService(reopened);
  expect(row(reopened, 'pending')).toEqual(shelved);
  expect(items.list({ projectId: null, needsReview: true, shelved: true })[0]!.id).toBe('pending');
  items.shelve('pending', false);
  const resumed = row(reopened, 'pending');
  expect(resumed).toEqual({ ...before, updated_at: resumed.updated_at });
  expect(items.list({ projectId: null, needsReview: true, shelved: false })[0]!.id).toBe('pending');
});

it('C05: Inbox exclusion is opt-in and does not globally erase historical query results', () => {
  const f = fixture();
  seed(f.db, 'history', 'superseded', 'manual');
  seed(f.db, 'pending', 'current', 'unconfirmed');
  expect(
    f.items.list({ projectId: null, needsReview: true, excludeSuperseded: true }).map((i) => i.id),
  ).toEqual(['pending']);
  expect(f.items.list({ projectId: null }).map((i) => i.id)).toContain('history');
  expect(f.items.list({ projectId: null, state: 'superseded' })[0]!.id).toBe('history');
});
