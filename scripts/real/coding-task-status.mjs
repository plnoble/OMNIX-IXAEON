#!/usr/bin/env node
/**
 * 真机诊断：最近几个编码任务与它们的待办的「形状」——状态、验证结果、落地结果、时间。
 * 只输出状态与数字，不输出任务目标、改动内容、路径（AGENTS.md「隐私优先」）。
 * 在库的副本上只读查询，跑完删掉副本；不碰原库。
 *
 *   node scripts/real/coding-task-status.mjs [数据目录] [条数]
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const Database = desktopRequire('better-sqlite3');

const dataDir = process.argv[2] ?? process.env.IXAEON_DATA_DIR;
const limit = Number(process.argv[3] ?? 5);
if (!dataDir || !existsSync(join(dataDir, 'ixaeon.db'))) {
  console.error('用法：node scripts/real/coding-task-status.mjs <数据目录> [条数]');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'ixa-task-status-'));
try {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = join(dataDir, `ixaeon.db${suffix}`);
    if (existsSync(src)) copyFileSync(src, join(tmp, `ixaeon.db${suffix}`));
  }
  const db = new Database(join(tmp, 'ixaeon.db'));
  const tasks = db
    .prepare(
      `SELECT t.id, t.status, t.verify_status, t.executor_name,
              t.error IS NOT NULL AND t.error != '' AS has_error,
              t.applied_ref IS NOT NULL AS landed,
              t.applied_ref LIKE 'ixaeon/%' AS landed_branch,
              t.created_at, t.updated_at,
              (SELECT status FROM todos WHERE linked_kind = 'coding_task' AND linked_id = t.id
                ORDER BY created_at DESC LIMIT 1) AS todo_status
         FROM coding_tasks t
        ORDER BY t.created_at DESC
        LIMIT ?`,
    )
    .all(limit);
  console.log(`最近 ${tasks.length} 个编码任务（新的在前；只有状态与时间）：`);
  for (const t of tasks) {
    console.log(
      `${t.id.slice(0, 8)} | 任务:${t.status} | 待办:${t.todo_status ?? '-'} | 验证:${t.verify_status ?? '-'} | 执行器:${t.executor_name ?? '-'} | 有错误:${t.has_error ? '是' : '否'} | 已落地:${t.landed ? (t.landed_branch ? '分支' : '改动包') : '否'} | ${t.created_at} → ${t.updated_at}`,
    );
  }
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
