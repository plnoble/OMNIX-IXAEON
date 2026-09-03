import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type CoreDatabase = Database.Database;

/**
 * 打开（必要时创建）数据库并应用安全 PRAGMA：
 * WAL、外键、忙等待。schema 变更只允许通过 migrate() 的编号迁移完成。
 */
export function openDatabase(dbPath: string): CoreDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
