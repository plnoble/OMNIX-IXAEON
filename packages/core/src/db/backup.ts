import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreDatabase } from './database.js';
import { MIGRATIONS } from './migrations.js';

const STAMP = /(\d{8}-\d{6})$/;
const PRE_MIGRATION = /^pre-migration-.+-\d{8}-\d{6}$/;

/**
 * 有待执行的迁移时，先把当前库（和配置）复制一份。
 * 全新库或已经是最新版本：返回 null，不建任何目录。
 */
export function backupBeforeMigrate(
  db: CoreDatabase,
  opts: { backupsDir: string; configPath?: string; keep?: number; now?: Date },
): string | null {
  const current = currentMigration(db);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]!.id;
  if (current === null || current >= latest) return null;

  const now = opts.now ?? new Date();
  const stamp = formatStamp(now);
  const dirName = `pre-migration-${current}-${latest}-${stamp}`;
  const target = join(opts.backupsDir, dirName);
  mkdirSync(target, { recursive: true });
  vacuumInto(db, join(target, 'ixaeon.db'));
  if (opts.configPath && existsSync(opts.configPath)) {
    copyFileSync(opts.configPath, join(target, 'config.json'));
  }
  pruneOldBackups(opts.backupsDir, opts.keep ?? 5);
  return target;
}

function currentMigration(db: CoreDatabase): number | null {
  const table = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as { ok: number } | undefined;
  if (!table) return null;
  const row = db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? null;
}

function formatStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function vacuumInto(db: CoreDatabase, dest: string): void {
  const escaped = dest.replaceAll('\\', '/').replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

function pruneOldBackups(backupsDir: string, keep: number): void {
  if (!existsSync(backupsDir)) return;
  const names = readdirSync(backupsDir).filter((n) => PRE_MIGRATION.test(n));
  names.sort((a, b) => {
    const sa = STAMP.exec(a)?.[1] ?? '';
    const sb = STAMP.exec(b)?.[1] ?? '';
    return sa.localeCompare(sb);
  });
  const extra = names.length - keep;
  if (extra <= 0) return;
  for (const name of names.slice(0, extra)) {
    rmSync(join(backupsDir, name), { recursive: true, force: true });
  }
}
