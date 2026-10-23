/** 数据目录的位置（L4 契约第 2 条）：新默认在用户目录下；旧位置只在 `relay status` 里提醒。 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 默认位置（L10 契约第 6 条）：所有系统都是 `~/.ixaeon/relay`——**不在 AppData 下面**，桌面版不会转存。 */
export function defaultRelayDir(): string {
  return join(homedir(), '.ixaeon', 'relay');
}

/** 数据目录：`IXAEON_RELAY_DIR` 有值就优先用它，否则用新默认。 */
export function relayDir(): string {
  const env = process.env.IXAEON_RELAY_DIR?.trim();
  return env ? resolve(env) : defaultRelayDir();
}

/** 工作目录根：`IXAEON_WORKTREES` 有值就是它，否则主检出往上两级的 `Worktrees/IXAEON`（照 scripts/worktree.mjs）。 */
export function worktreesRoot(): string {
  const trees = process.env.IXAEON_WORKTREES?.trim();
  if (trees) return resolve(trees);
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  const common = (r.stdout ?? '').trim();
  const mainRoot = common ? dirname(common) : process.cwd();
  return resolve(mainRoot, '..', '..', 'Worktrees', 'IXAEON');
}

/**
 * 旧位置：`<工作目录根>/relay`。
 * 数据目录挪出去之后只用来提醒「这里还有文件」，**不自动搬**（L4 契约第 2 条）。
 */
export function oldRelayDir(): string {
  return join(worktreesRoot(), 'relay');
}
