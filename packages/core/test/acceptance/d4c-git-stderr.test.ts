/**
 * D4c 验收测试：建分支失败时，落地回报里带上 git 自己说的那句话。
 *
 * 逐条对应委派单：
 * - 建分支失败（post-checkout 钩子拒绝，git 往错误输出写原话）→ 回报原因里有 git 错误输出那一条非空行，
 *   不是只有「Command failed: git … commit …」；
 * - 没有错误输出时照旧（代码里保证，不容易造，不另测）。
 *
 * 不改 D4 的锁定测试（`d4-apply-branch.test.ts`，指纹在 `docs/委派/锁定验收.json`）：这里自己搭一份
 * 最小 harness（照它的搭法），只多断言「原因里带 git 的原话」；D4 条件 8 覆盖的收尾（无残留工作树、
 * 无残留分支、改走改动包）这里也照旧断言一遍。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
  // 和锁定测试一样：隔开本机的 git 全局/系统配置（提交签名、钩子不能影响合成仓库）
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
      /* git 偶发占着临时目录，留给系统清 */
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

it('建分支失败：回报里带上 git 错误输出的那一行原话', async () => {
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

  // git 建工作树时会跑 post-checkout；钩子把一句固定的话写到标准错误上再退出非零
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  const hook = join(hooks, 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\necho "D4C-合成的钩子拒绝" >&2\nexit 1\n');
  chmodSync(hook, 0o755); // POSIX 上没有执行位的钩子会被跳过
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

  const row = db
    .prepare('SELECT applied_ref, apply_error FROM coding_tasks WHERE id = ?')
    .get(task.id) as { applied_ref: string | null; apply_error: string | null };
  // 照 D4 的约定：失败改走改动包
  expect(row.applied_ref).not.toBeNull();
  expect(resolve(row.applied_ref!)).toBe(resolve(join(dataDir, 'patches', task.id)));
  const err = row.apply_error ?? '';
  expect(err).toContain('建分支失败：');
  // git 的原话在里面（钩子那行，或者 git 自己的报错行）
  expect(err).toMatch(/D4C-合成的钩子拒绝|hook|exit code/i);
  // 不能只剩「Command failed: git …」这种没信息的话
  expect(err.replace(/^建分支失败：/, '')).not.toBe('');
  // D4 条件 8 的收尾照旧
  expect(worktreeCount(root)).toBe(1);
  expect(git(root, ['branch', '--list', 'ixaeon/*'])).toBe('');
  expect(readFileSync(join(dataDir, 'patches', task.id, 'note.txt'), 'utf8')).toBe('建树被拒');
  expect(existsSync(join(root, 'hooks'))).toBe(true);
});
