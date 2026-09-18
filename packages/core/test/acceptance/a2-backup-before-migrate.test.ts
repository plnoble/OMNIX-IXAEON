/**
 * A2 验收（整合方写死，执行方不改）：迁移前自动备份。
 * 委派单：docs/委派/A2-迁移前自动备份.md
 *
 * 2026-09-18：迁移 30 会删数据（清聊天存档的回声），上线前靠整合方手动备份。
 * 以后有待执行的迁移时，应用启动先把数据库和配置复制一份，再迁移。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  backupBeforeMigrate,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.id;
const NOW = new Date(2026, 8, 18, 20, 1, 57); // 本地时间 2026-09-18 20:01:57

let dir: string;
let backups: string;
const opened: CoreDatabase[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a2-'));
  backups = join(dir, 'backups');
});

afterEach(() => {
  for (const d of opened.splice(0)) if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(path: string): CoreDatabase {
  const d = openDatabase(path);
  opened.push(d);
  return d;
}

/** 停在某个版本、带一条合成数据的库。 */
function databaseAt(version: number): CoreDatabase {
  const d = open(join(dir, 'ixaeon.db'));
  migrate(d, version);
  d.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', '合成项目', ?, ?)`,
  ).run('2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z');
  return d;
}

describe('有待执行的迁移：先备份', () => {
  it('备份目录按「迁移前版本-目标版本-时间」命名，库和配置都在，库是迁移前的样子', () => {
    const d = databaseAt(29);
    const config = join(dir, 'config.json');
    writeFileSync(config, '{"synthetic":true}', 'utf8');

    const target = backupBeforeMigrate(d, { backupsDir: backups, configPath: config, now: NOW });

    expect(target).toBe(join(backups, `pre-migration-29-${LATEST}-20260918-200157`));
    expect(existsSync(join(target!, 'config.json'))).toBe(true);
    const copy = open(join(target!, 'ixaeon.db'));
    expect(copy.prepare('SELECT MAX(id) AS v FROM schema_migrations').get()).toEqual({ v: 29 });
    expect(copy.prepare('SELECT name FROM projects').all()).toEqual([{ name: '合成项目' }]);
  });

  it('没有配置文件也照样备份库', () => {
    const d = databaseAt(29);
    const target = backupBeforeMigrate(d, { backupsDir: backups, now: NOW });
    expect(existsSync(join(target!, 'ixaeon.db'))).toBe(true);
    expect(existsSync(join(target!, 'config.json'))).toBe(false);
  });
});

describe('不需要备份的时候不备份', () => {
  it('已经是最新版本：返回 null，什么也不建', () => {
    const d = databaseAt(LATEST);
    expect(backupBeforeMigrate(d, { backupsDir: backups, now: NOW })).toBeNull();
    expect(existsSync(backups)).toBe(false);
  });

  it('全新的空库（还没有迁移记录）：返回 null', () => {
    const d = open(join(dir, 'fresh.db'));
    expect(backupBeforeMigrate(d, { backupsDir: backups, now: NOW })).toBeNull();
    expect(existsSync(backups)).toBe(false);
  });
});

describe('只留最近几份', () => {
  it('默认留最近 5 份「pre-migration-」备份（按名字末尾的时间），别的目录不动', () => {
    mkdirSync(backups, { recursive: true });
    for (let day = 1; day <= 6; day++) {
      mkdirSync(join(backups, `pre-migration-${9 + day}-${10 + day}-2026010${day}-000000`));
    }
    mkdirSync(join(backups, 'manual-keep'));
    const d = databaseAt(29);

    backupBeforeMigrate(d, { backupsDir: backups, now: NOW });

    // 6 份旧的 + 1 份新的 → 留最近 5 份：删掉 1 月 1 日、2 日那两份
    expect(readdirSync(backups).sort()).toEqual([
      'manual-keep',
      'pre-migration-12-13-20260103-000000',
      'pre-migration-13-14-20260104-000000',
      'pre-migration-14-15-20260105-000000',
      'pre-migration-15-16-20260106-000000',
      `pre-migration-29-${LATEST}-20260918-200157`,
    ]);
  });
});
