/**
 * L10 契约第 3 条：把看门人自己那份代码（`<工作目录根>/relay-run`）更新到 `origin/main`。
 *
 * - `dir` 不存在 → `git -C <repo> worktree add --detach <dir> origin/main`；
 * - 存在 → 在 `dir` 里 `git switch --detach origin/main`；
 * - `dir` 里有没提交的改动 → 不动它，`note` 说明，`sha` 是它现在的提交。
 */
import { existsSync } from 'node:fs';
import { git } from './git.js';

export function updateCodeCheckout(
  repo: string,
  dir: string,
): { sha: string | null; note: string } {
  const headOf = (): string | null => git(dir, ['rev-parse', 'HEAD']).out || null;
  if (!existsSync(dir)) {
    const made = git(repo, ['worktree', 'add', '--detach', dir, 'origin/main'], 300_000);
    if (made.code !== 0) return { sha: null, note: `建不了看门人自己的那份代码：${made.out}` };
    return { sha: headOf(), note: '' };
  }
  const dirty = git(dir, ['status', '--porcelain']).out;
  if (dirty) return { sha: headOf(), note: '那份代码里有没提交的改动，没动它' };
  const switched = git(dir, ['switch', '--detach', 'origin/main'], 300_000);
  if (switched.code !== 0) return { sha: headOf(), note: `切不到 origin/main：${switched.out}` };
  return { sha: headOf(), note: '' };
}
