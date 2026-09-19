import type { CoreDatabase } from './db/database.js';
import { recordAudit } from './audit.js';

/**
 * 核心层要读的少量全局设置（迁移 32 app_settings）。
 * 放数据库而不是 config.json：权限判断（access.ts）在核心层，所有读记忆的入口
 *（聊天注入、记忆桥、Core 兜底）都要看到同一个值。
 */

/**
 * E6（用户 2026-09-18：不想导入一份资料就逐句审核）：个人记忆给 IXAEON 自己的聊天用。
 * 关着时，没归到项目下的记忆（个人、未整理）要逐条「分享给模型」才进聊天——
 * 而界面上没有逐条分享的入口，导入的个人聊天提炼得再好，聊天也用不上。
 * 打开后这些记忆可以进 IXAEON 自己的聊天（经用户自己的模型网关发给云端模型）；
 * 编码客户端（Codex、Claude 等经 MCP）照旧拿不到，受众边界不变。默认关闭，由用户决定。
 */
export const PERSONAL_MEMORY_TO_CHAT = 'memory.personal_to_chat';

/** W1b：概览「最近的新发现」上次点过「都看过了」的时间（ISO）。没这行 = 从没看过。 */
export const OVERVIEW_FINDINGS_SEEN_AT = 'overview.findings_seen_at';

export function getSetting(
  db: CoreDatabase,
  key: string,
): { value: string; updatedAt: string } | null {
  const row = beforeMigration32(
    () =>
      db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?').get(key) as
        { value: string; updated_at: string } | undefined,
    undefined,
  );
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}

/** 设置最后一次变动的时间（权限纪元用：开关一变，旧会话失效）。 */
export function settingsEpoch(db: CoreDatabase): string {
  return beforeMigration32(
    () =>
      (
        db.prepare("SELECT COALESCE(MAX(updated_at), '') AS t FROM app_settings").get() as {
          t: string;
        }
      ).t,
    '',
  );
}

/** 迁移 32 之前的库（诊断旧库、只迁到一半的测试库）没有这张表：当作全部默认值。 */
function beforeMigration32<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof Error && /no such table: app_settings/.test(err.message)) return fallback;
    throw err;
  }
}

export function setSetting(db: CoreDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function personalMemoryToChat(db: CoreDatabase): boolean {
  return getSetting(db, PERSONAL_MEMORY_TO_CHAT)?.value === 'on';
}

export function setPersonalMemoryToChat(db: CoreDatabase, enabled: boolean): void {
  setSetting(db, PERSONAL_MEMORY_TO_CHAT, enabled ? 'on' : 'off');
  recordAudit(db, 'setting.personal_memory_to_chat', { enabled });
}
