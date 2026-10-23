/**
 * D4c 验收测试：建分支失败时，回报里带上 git 自己说的那句话。
 *
 * 逐条对应委派单：
 * 1. 有错误输出：`why` 后面接上 git 错误输出里第一条非空的行（去掉首尾空白，最多 200 字）；
 * 2. 首尾空白去掉；超过 200 字截断；
 * 3. 没有错误输出：照旧（只有 `why`，不追加冒号）；
 * 4. 失败改走改动包、无残留工作树与分支（D4 条件 8 的收尾）。
 *
 * 不改 D4 的锁定测试（`packages/core/test/acceptance/d4-apply-branch.test.ts`，指纹在
 * `docs/委派/锁定验收.json`）；这里自建最小 harness。
 *
 * 实测（2026-10-23，Windows + git 2.x）：
 * - `post-checkout` 钩子拒绝时，git 的 stderr 是 `"Preparing worktree (new branch '…')\n<钩子输出>\n"`，
 *   而 `err.message` 的首行也是 `Preparing worktree …`——所以「第一条非空行」接出来会与 `why` 重复。
 * - `pre-commit` 钩子拒绝时（走到 commit 那一步），stderr 就是钩子的那几行，第一条非空行是钩子原话。
 * 这两种都照契约字面处理，下面各一条。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const dirs: string[] = [];
let db: CoreDatabase | null = null;
const savedGit: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedGit[key] = process.env[key];
    const empty = join(mkdtempSync(join(tmpdir(), 'ixa-d4c-gitcfg-')), 'empty');
    writeFileSync(empty, '');
    dirs.push(join(empty, '..'));
    process.env[key] = empty;
  }
});

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const key of Object.keys(savedGit)) {
    if (savedGit[key] === undefined) delete process.env[key];
    else process.env[key] = savedGit[key];
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录留给系统清 */
    }
  }
});

const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commitAll = (repo: string, message: string): void => {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', message]);
};
const worktreeCount = (root: string): number =>
  git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

interface World {
  dataDir: string;
  root: string;
  runWithHook(
    hookContent: string,
    hookName?: 'post-checkout' | 'pre-commit',
  ): Promise<{ taskId: string; error: string }>;
}

function makeWorld(): World {
  const dataDir = tempDir('ixa-d4c-data-');
  const root = tempDir('ixa-d4c-root-');
  git(root, ['init', '-b', 'main']);
  writeFileSync(join(root, 'note.txt'), '第一版');
  commitAll(root, '初始');

  db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const project = new ProjectService(db).create({
    name: '合成项目',
    rootPath: root,
    description: null,
  });
  new PermissionService(db).grantFolder(root);
  const files: Record<string, string> = {};
  const coding = new CodingOrchestrator(
    db,
    new FakeCodingExecutor({ claimedSuccess: true, files }),
    dataDir,
  );

  return {
    dataDir,
    root,
    async runWithHook(hookContent, hookName = 'post-checkout') {
      const hooks = join(root, 'hooks');
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, hookName);
      writeFileSync(hook, hookContent);
      chmodSync(hook, 0o755);
      git(root, ['config', 'core.hooksPath', hooks]);

      const task = coding.create({
        projectId: project.id,
        goal: '把说明写清楚',
        scope: ['note.txt'],
        allowedCommands: [],
      });
      files['note.txt'] = '建树被拒';
      await coding.approveAndQueue(task.id);
      await coding.dispatch(task.id);
      await coding.accept(task.id);

      const row = db!
        .prepare('SELECT applied_ref, apply_error FROM coding_tasks WHERE id = ?')
        .get(task.id) as { applied_ref: string | null; apply_error: string | null };
      expect(row.applied_ref).not.toBeNull();
      expect(resolve(row.applied_ref!)).toBe(resolve(join(dataDir, 'patches', task.id)));
      return { taskId: task.id, error: row.apply_error ?? '' };
    },
  };
}

describe('D4c 验收条件：建分支失败带上 git 的原话', () => {
  it('建树失败：接上的是 stderr 第一条非空行（git 的 Preparing worktree，与 why 相同也照接）', async () => {
    const w = makeWorld();
    const hook = '#!/bin/sh\nexit 1\n';
    const { taskId, error } = await w.runWithHook(hook);

    expect(error).toContain('建分支失败：');
    // 照契约字面：why 后面接上第一条非空行（这里 git 的第一行就是 Preparing worktree）
    expect(error).toContain('Preparing worktree');
    // 拼在一行里，不会带出换行
    expect(error).not.toContain('\n');

    // D4 条件 8 的收尾照旧
    expect(worktreeCount(w.root)).toBe(1);
    expect(git(w.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
    expect(readFileSync(join(w.dataDir, 'patches', taskId, 'note.txt'), 'utf8')).toBe('建树被拒');
  });

  it('提交被钩子拒绝：接上钩子写在 stderr 上的那句话', async () => {
    const w = makeWorld();
    const hook = ['#!/bin/sh', 'echo "D4C_COMMIT_HOOK_SAYS" >&2', 'exit 1', ''].join('\n');
    const { error } = await w.runWithHook(hook, 'pre-commit');

    expect(error).toContain('建分支失败：');
    expect(error).toContain('D4C_COMMIT_HOOK_SAYS');
    expect(error).not.toContain('\n');
  });

  it('超长原话：正好截断到 200 字', async () => {
    const w = makeWorld();
    const longText = 'ABCDEFGHIJ'.repeat(25); // 250 字
    const hook = `#!/bin/sh\necho "${longText}" >&2\nexit 1\n`;
    const { error } = await w.runWithHook(hook, 'pre-commit');

    expect(error).toContain('建分支失败：');
    expect(error).toContain(longText.slice(0, 200));
    expect(error).not.toContain(longText.slice(0, 200) + longText.slice(200, 201));
  });

  it('没有错误输出：照旧（不追加冒号与原话）', async () => {
    const w = makeWorld();
    const hook = '#!/bin/sh\nexit 1\n';
    // 用 pre-commit 的失败路径（stderr 为空），看格式是否还是 `建分支失败：<why>`
    const { error } = await w.runWithHook(hook, 'pre-commit');

    expect(error).toContain('建分支失败：');
    const body = error.replace(/^建分支失败：/, '').split('；且')[0]!;
    expect(body.endsWith('：')).toBe(false);
  });
});
