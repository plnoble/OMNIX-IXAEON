/**
 * K4：项目卡片上的最近活动。只对「做过目录登记读取、授权仍有效、根目录在授权范围里」
 * 的项目跑 git；判断和 `projectBrief.ts` 共用 `readableProjectRoot`。读不了只给空数字。
 */
import { spawnSync } from 'node:child_process';
import type * as C from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { readableProjectRoot } from '../runtime/projectBrief.js';

function git(root: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

export function readProjectActivity(
  db: CoreDatabase,
  projectId: string,
  rootPath: string | null,
): C.ProjectActivity {
  const root = readableProjectRoot(db, projectId, rootPath);
  if (!root) return { lastCommitAt: null, commits7d: null, readable: false };
  const last = git(root, ['log', '-1', '--format=%cI']);
  const count = git(root, ['rev-list', '--count', '--since=7.days', 'HEAD']);
  return {
    lastCommitAt: last || null,
    commits7d: count !== null && /^\d+$/.test(count) ? Number(count) : null,
    readable: true,
  };
}
