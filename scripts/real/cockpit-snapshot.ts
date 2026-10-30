/**
 * K2 真机检查：对本机真实的 relay 数据目录和 IXAEON 仓库构建驾驶舱快照。
 *
 *   node scripts/real/run-batch.mjs scripts/real/cockpit-snapshot.ts
 *
 * 只输出统计数字：各来源的 status、running / attention / recent 的条数、projects 三组的数量。
 * 不输出任何文本内容，也不打印临时目录（本机账户名只在路径里）。项目分组用临时空库 + 3 个
 * 合成项目（active / paused / archived 各一），不碰用户的应用数据库。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCockpitSnapshot,
  migrate,
  openDatabase,
  ProjectService,
} from '../../packages/core/src/index.js';
import { findSharedCheckout } from '../../packages/relay/src/config.js';
import { relayDir } from '../../packages/relay/src/datadir.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-k2-real-'));
const db = openDatabase(join(dir, 'ixaeon.db'));
migrate(db);
try {
  const projects = new ProjectService(db);
  projects.create({ name: 'K2 真机 active', rootPath: null, description: null });
  const paused = projects.create({ name: 'K2 真机 paused', rootPath: null, description: null });
  projects.updateStatus(paused.id, 'paused');
  const archived = projects.create({ name: 'K2 真机 archived', rootPath: null, description: null });
  projects.updateStatus(archived.id, 'archived');

  const repo = findSharedCheckout();
  if (!repo) {
    console.log('RESULT K2 找不到 IXAEON 仓库（要在仓库的工作目录里跑）');
    process.exitCode = 2;
  } else {
    const snap = buildCockpitSnapshot(db, { relayDir: relayDir(), ixaeonRepo: repo });
    const { relay, queue, projects: projectHealth } = snap.sources;
    console.log(
      `来源状态：relay=${relay.status} queue=${queue.status} projects=${projectHealth.status}`,
    );
    console.log(`running=${snap.running.length} attention=${snap.attention.length}`);
    console.log(`recent=${snap.recent.length} today.finishedTurns=${snap.today.finishedTurns}`);
    console.log(
      `projects：active=${snap.projects.active.length} paused=${snap.projects.paused.length} archived=${snap.projects.archived.length}`,
    );
    console.log(
      `RESULT K2 relay=${relay.status} queue=${queue.status} projects=${projectHealth.status} running=${snap.running.length} attention=${snap.attention.length} recent=${snap.recent.length} active=${snap.projects.active.length} paused=${snap.projects.paused.length} archived=${snap.projects.archived.length}`,
    );
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
