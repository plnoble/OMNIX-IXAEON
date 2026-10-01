#!/usr/bin/env node
/**
 * 真机诊断：最近几条消息的「形状」——角色、状态、引擎、字数、时间。
 * 只输出状态与数字，不输出任何消息内容（AGENTS.md「隐私优先」）。
 * 在库的副本上只读查询，跑完删掉副本；不碰原库。
 *
 *   node scripts/real/last-ask-status.mjs [数据目录] [条数]
 *   （数据目录默认取 IXAEON_DATA_DIR；条数默认 8）
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const Database = desktopRequire('better-sqlite3');

const dataDir = process.argv[2] ?? process.env.IXAEON_DATA_DIR;
const limit = Number(process.argv[3] ?? 8);
if (!dataDir || !existsSync(join(dataDir, 'ixaeon.db'))) {
  console.error(
    '用法：node scripts/real/last-ask-status.mjs <数据目录> [条数]（找不到 ixaeon.db）',
  );
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'ixa-ask-status-'));
try {
  // 连同 WAL 一起复制，副本里才有最新写入；原库一个字节不动
  for (const suffix of ['', '-wal', '-shm']) {
    const src = join(dataDir, `ixaeon.db${suffix}`);
    if (existsSync(src)) copyFileSync(src, join(tmp, `ixaeon.db${suffix}`));
  }
  const db = new Database(join(tmp, 'ixaeon.db'));
  const rows = db
    .prepare(
      `SELECT m.role, m.status, m.engine, length(m.content) AS chars,
              m.error_message IS NOT NULL AND m.error_message != '' AS has_error,
              m.created_at, m.updated_at,
              c.project_id IS NOT NULL AS project_conv,
              p.root_path IS NOT NULL AS project_bound
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN projects p ON p.id = c.project_id
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(limit);
  const streaming = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'streaming'`)
    .get();
  console.log(`最近 ${rows.length} 条消息（新的在前；只有状态与数字）：`);
  for (const r of rows) {
    console.log(
      `${r.created_at} → ${r.updated_at} | ${r.role} | ${r.status} | ${r.engine ?? '-'} | ${r.chars} 字 | 有错误信息:${r.has_error ? '是' : '否'} | 项目对话:${r.project_conv ? '是' : '否'} | 项目已绑文件夹:${r.project_bound ? '是' : '否'}`,
    );
  }
  console.log(`还停在「正在回答」状态的消息：${streaming.n} 条`);
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
