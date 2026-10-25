/**
 * L10 契约第 3 条：把看门人自己那份代码（`<工作目录根>/relay-run`）更新到 `origin/main`。
 *
 * - `dir` 不存在 → `git -C <repo> worktree add --detach <dir> origin/main`；
 * - 存在 → 在 `dir` 里 `git switch --detach origin/main`；
 * - `dir` 里有没提交的改动 → 不动它，`note` 说明，`sha` 是它现在的提交。
 *
 * L18 契约第 2、3 条：`relayCodeHash`——看门人那层代码的指纹（`bin/` 和 `src/` 下所有文件，
 * 按相对路径排序，逐个把「路径 + \0 + 内容」喂进 sha256）；`RESTART_EXIT_CODE`——
 * `relay run` 用它退出表示「代码换了，relay forever 快重起我」。测试、README 不算指纹——
 * 换了它们不需要重起看门人。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { git } from './git.js';

/** L18 契约第 4 条：`relay run` 用这个码退出 = 「代码换了，relay forever 快重起我」。 */
export const RESTART_EXIT_CODE = 75;

/** 看门人那层代码的 sha256（十六进制串）。同样的文件两次算出来一样。 */
export function relayCodeHash(root: string): string {
  const rels: string[] = [];
  for (const sub of ['bin', 'src']) {
    const dir = join(root, 'packages', 'relay', sub);
    let entries: Array<{ isFile: () => boolean; parentPath: string; name: string }> = [];
    try {
      entries = readdirSync(dir, { recursive: true, withFileTypes: true }) as typeof entries;
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile()) rels.push(relative(root, join(e.parentPath, e.name)));
    }
  }
  const hash = createHash('sha256');
  for (const rel of rels.map((p) => p.split(sep).join('/')).sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(root, ...rel.split('/'))));
  }
  return hash.digest('hex');
}

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
