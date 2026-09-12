import { describe, it, expect } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, type CoreDatabase } from '../../src/index.js';

/**
 * R15 日用旧库副本升级探针：源库全程只读（字节哈希前后一致），
 * 在临时副本上跑迁移并验证幂等与数据保全。默认跳过；
 * IXAEON_REAL_DAILY_DB=1 且 IXAEON_DAILY_DB_PATH 指向源库时才跑。
 * 快照口径（2026-09-11）：sources 38 / segments 863 / items 57 / projects 1，
 * 迁移版本 17（发布版）；本工作树的 18 号迁移为新增追加。
 */
const run = process.env.IXAEON_REAL_DAILY_DB === '1';
const src = process.env.IXAEON_DAILY_DB_PATH?.trim() ?? '';

function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function version(db: CoreDatabase): number {
  return (db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number }).v;
}

function counts(db: CoreDatabase) {
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return {
    sources: c('sources'),
    segments: c('segments'),
    items: c('items'),
    projects: c('projects'),
  };
}

describe.skipIf(!run || !src)('R15 日用库副本迁移（源库只读）', () => {
  it('副本 17→18 幂等且数据保全；源文件字节不变', () => {
    expect(existsSync(src)).toBe(true);
    const before = sha256(src);

    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-r15-'));
    try {
      const copyPath = join(dir, 'ixaeon.db');
      copyFileSync(src, copyPath);
      // WAL 模式下未合并的提交需要伴生文件一起拷
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(src + suffix)) copyFileSync(src + suffix, copyPath + suffix);
      }
      const db = openDatabase(copyPath);
      try {
        const v0 = version(db);
        expect(v0).toBeLessThanOrEqual(17); // 日用库在发布版 17 或更早
        const before_ = counts(db);
        // 快照口径（2026-09-11）为下限；真实数量如实记录（当日研究导入后 sources 已到 40）。
        expect(before_.sources).toBeGreaterThanOrEqual(38);
        expect(before_.segments).toBeGreaterThanOrEqual(863);
        expect(before_.items).toBeGreaterThanOrEqual(57);
        expect(before_.projects).toBeGreaterThanOrEqual(1);
        console.log('R15 日用库副本实际数量:', JSON.stringify(before_), '迁移前版本:', v0);

        migrate(db);
        expect(version(db)).toBe(18);
        migrate(db); // 幂等
        expect(version(db)).toBe(18);
        expect(counts(db)).toEqual(before_); // 迁移不丢不改既有数据
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 源库零写入
    expect(sha256(src)).toBe(before);
  });
});
