/**
 * L10 验收测试（三）：更新看门人自己的那份代码（规格条件 4，对应契约第 3 条）。
 *
 * 逐条对应（`updateCodeCheckout(repo, dir)`）：
 * - `dir` 不存在 → 建出来，`HEAD` 是 `origin/main` 的提交、不在任何分支上（detached）；
 * - 往 origin 推一个新提交、在 `repo` 里拉一次 → 再调一次就到了新提交；
 * - `dir` 里改一个文件不提交 → 不动它，`note` 不为空，`sha` 还是它现在的提交。
 *
 * 用临时 bare origin + 一份克隆当 `repo`。不调真模型、不连 GitHub。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { updateCodeCheckout } from '../../src/selfupdate.js';

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};
const commitIn = (cwd: string, file: string, content: string, message: string): void => {
  writeFileSync(join(cwd, file), content, 'utf8');
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '-m',
    message,
  ]);
};

/** 合成仓库：bare origin + 一份克隆（它的 origin 就是那个 bare）。 */
function makeRepo(): { root: string; origin: string; repo: string } {
  const root = tmp('ixa-l10-selfupdate-');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, repo]);
  git(repo, ['config', 'user.email', 'relay@example.invalid']);
  git(repo, ['config', 'user.name', 'relay']);
  commitIn(repo, 'a.txt', '第一版\n', '初始');
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  return { root, origin, repo };
}

describe('条件 4：updateCodeCheckout', () => {
  it('dir 不存在 → 建出来、HEAD 是 origin/main、detached；再推一个提交就跟着到新的；有没提交的改动就不动它', () => {
    const { root, origin, repo } = makeRepo();
    const dir = join(root, 'relay-run');
    const first = git(repo, ['rev-parse', 'origin/main']);

    const r1 = updateCodeCheckout(repo, dir);
    expect(r1.sha).toBe(first);
    expect(existsSync(dir)).toBe(true);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(first);
    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD'); // 不在任何分支上

    // origin 上多一笔（另一个克隆推的），repo 里拉一次
    const pusher = join(root, 'pusher');
    git(root, ['clone', origin, pusher]);
    git(pusher, ['config', 'user.email', 'relay@example.invalid']);
    git(pusher, ['config', 'user.name', 'relay']);
    commitIn(pusher, 'b.txt', '第二版\n', '后来的一笔');
    git(pusher, ['push', '-q', 'origin', 'HEAD:main']);
    git(repo, ['fetch', '-q', 'origin', 'main']);
    const second = git(repo, ['rev-parse', 'origin/main']);
    expect(second).not.toBe(first);

    const r2 = updateCodeCheckout(repo, dir);
    expect(r2.sha).toBe(second);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(second);

    // dir 里有没提交的改动：不动它
    writeFileSync(join(dir, 'dirty.txt'), '还没提交\n', 'utf8');
    const r3 = updateCodeCheckout(repo, dir);
    expect(r3.note).not.toBe('');
    expect(r3.sha).toBe(second);
    expect(existsSync(join(dir, 'dirty.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'dirty.txt'), 'utf8')).toBe('还没提交\n');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(second);
  }, 120_000);
});
