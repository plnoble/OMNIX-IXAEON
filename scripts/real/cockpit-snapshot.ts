/**
 * K2 真机检查：对本机真实的 relay 数据目录和 IXAEON 仓库构建驾驶舱快照。
 *
 *   node scripts/real/run-batch.mjs scripts/real/cockpit-snapshot.ts
 *
 * 只输出统计数字：各来源的 status、running / attention / recent 的条数、projects 三组的数量。
 * 不输出任何文本内容，也不打印临时目录（本机账户名只在路径里）。项目分组用临时空库 + 3 个
 * 合成项目（active / paused / archived 各一），不碰用户的应用数据库。
 *
 * K4：设了 `IXAEON_QUOTAHUB_URL` 时把它写进临时库的 `cockpit.quotahub_url`，走真的本机
 * QuotaHub（没设就照旧只报 quotas=missing）；输出仍只有数字。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCockpitSnapshot,
  migrate,
  openDatabase,
  ProjectService,
  setSetting,
} from '../../packages/core/src/index.js';
import { findSharedCheckout } from '../../packages/relay/src/config.js';
import { relayDir } from '../../packages/relay/src/datadir.js';

const dir = mkdtempSync(join(tmpdir(), 'ixaeon-k2-real-'));
const db = openDatabase(join(dir, 'ixaeon.db'));
migrate(db);
// K4：真机检查可以显式指向本机 QuotaHub；默认不动，保持 K2 的「没配 = missing」。
const quotaUrl = process.env.IXAEON_QUOTAHUB_URL?.trim();
if (quotaUrl) setSetting(db, 'cockpit.quotahub_url', quotaUrl);
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
    const snap = await buildCockpitSnapshot(db, { relayDir: relayDir(), ixaeonRepo: repo });
    const { relay, queue, projects: projectHealth } = snap.sources;
    const quotas = snap.sources.quotas;
    const quotaCards = snap.quotas ?? [];
    const windows = quotaCards.reduce((n, q) => n + q.windows.length, 0);
    const readable = [
      ...snap.projects.active,
      ...snap.projects.paused,
      ...snap.projects.archived,
    ].filter((p) => p.activity?.readable).length;
    console.log(
      `来源状态：relay=${relay.status} queue=${queue.status} projects=${projectHealth.status}`,
    );
    console.log(`running=${snap.running.length} attention=${snap.attention.length}`);
    console.log(`recent=${snap.recent.length} today.finishedTurns=${snap.today.finishedTurns}`);
    console.log(
      `projects：active=${snap.projects.active.length} paused=${snap.projects.paused.length} archived=${snap.projects.archived.length}`,
    );
    console.log(
      `额度：quotas=${quotas?.status ?? 'missing'} accounts=${quotaCards.length} windows=${windows}`,
    );
    console.log(`项目活动：可读项目=${readable}`);
    console.log(
      `RESULT K2 relay=${relay.status} queue=${queue.status} projects=${projectHealth.status} running=${snap.running.length} attention=${snap.attention.length} recent=${snap.recent.length} active=${snap.projects.active.length} paused=${snap.projects.paused.length} archived=${snap.projects.archived.length} quotas=${quotas?.status ?? 'missing'} accounts=${quotaCards.length} windows=${windows} readableProjects=${readable}`,
    );
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
