import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, migrate, currentMigrationVersion, Vault, sha256 } from '../../src/index.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-db-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('数据库迁移', () => {
  it('全新数据库执行全部迁移并记录版本', () => {
    const db = openDatabase(join(dir, 'a.db'));
    migrate(db);
    expect(currentMigrationVersion(db)).toBeGreaterThan(0);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const expected of [
      'permissions',
      'sources',
      'segments',
      'projects',
      'items',
      'item_evidence',
      'corrections',
      'work_runs',
      'jobs',
      'audit_events',
      'schema_migrations',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('重复执行迁移是幂等的', () => {
    const db = openDatabase(join(dir, 'b.db'));
    migrate(db);
    const v1 = currentMigrationVersion(db);
    migrate(db);
    const v2 = currentMigrationVersion(db);
    expect(v1).toBe(v2);
    db.close();
  });

  it('PRAGMA 生效：WAL 与外键', () => {
    const db = openDatabase(join(dir, 'c.db'));
    migrate(db);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // 外键约束实际拦截非法插入
    expect(() =>
      db
        .prepare(
          'INSERT INTO segments (id, source_id, sequence, role, is_active_branch, text, content_hash) VALUES (?, ?, 0, ?, 1, ?, ?)',
        )
        .run('seg-x', 'nonexistent-source', 'user', 'x', sha256('x')),
    ).toThrow();
    db.close();
  });

  it('FTS 触发器保持 segments_fts 同步', () => {
    const db = openDatabase(join(dir, 'd.db'));
    migrate(db);
    db.prepare(
      'INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('p1', 'file', 'C:/tmp/x.md', 'once', 'active', new Date().toISOString());
    db.prepare(
      'INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path, imported_at, permission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      's1',
      'document',
      'local_file',
      'C:/tmp/x.md',
      '测试',
      sha256('raw'),
      'vault/x',
      new Date().toISOString(),
      'p1',
    );
    db.prepare(
      'INSERT INTO segments (id, source_id, sequence, role, is_active_branch, text, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('seg1', 's1', 0, 'document', 1, 'IXAEON 是正式系统名，中文名是析衍', sha256('seg1'));
    // trigram 分词器：查询需 >= 3 个字符
    const hits = db
      .prepare('SELECT count(*) AS c FROM segments_fts WHERE segments_fts MATCH ?')
      .get('IXAEON') as { c: number };
    expect(hits.c).toBe(1);
    const hitsCjk = db
      .prepare('SELECT count(*) AS c FROM segments_fts WHERE segments_fts MATCH ?')
      .get('中文名是析衍') as { c: number };
    expect(hitsCjk.c).toBe(1);
    db.prepare('DELETE FROM segments WHERE id = ?').run('seg1');
    const hits2 = db
      .prepare('SELECT count(*) AS c FROM segments_fts WHERE segments_fts MATCH ?')
      .get('IXAEON') as { c: number };
    expect(hits2.c).toBe(0);
    db.close();
  });
});

describe('vault 内容指纹库', () => {
  it('同一内容只保存一次，且不可覆盖', () => {
    const vault = new Vault(join(dir, 'vault'));
    const first = vault.store('hello IXAEON');
    expect(first.created).toBe(true);
    const second = vault.store('hello IXAEON');
    expect(second.created).toBe(false);
    expect(second.hash).toBe(first.hash);
    expect(vault.count()).toBe(1);
    expect(vault.read(first.hash).toString()).toBe('hello IXAEON');
    // 不同内容不同指纹
    const third = vault.store('hello IXAEON v2');
    expect(third.hash).not.toBe(first.hash);
    expect(vault.count()).toBe(2);
  });

  it('拒绝非法指纹', () => {
    const vault = new Vault(join(dir, 'vault2'));
    expect(() => vault.read('not-a-hash')).toThrow();
  });
});
