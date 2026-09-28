/**
 * D4 验收（规格 docs/委派/D4-接受后在项目里建分支.md）
 *
 * 直接测 CodingOrchestrator.accept 之后的落地。项目是临时目录里的真 git 仓库
 * （或普通文件夹），执行器是替身，不调用 Codex。git 身份与本机全局配置隔开，
 * 否则「没配置提交人」测不到。
 *
 * 条件 1：改一个、加一个 → 分支 ixaeon/<任务 id 前 8 位>，提交正好这两处；
 *         当前分支、HEAD、工作区、暂存区都没变。
 * 条件 2：分支名已存在 → ixaeon/<前 8 位>-2。
 * 条件 3：派发后项目里又提交了同一个文件 → 不建分支，改动包，apply_error 列出该文件。
 * 条件 4：快照时文件有未提交改动（与 HEAD 不同）→ 同条件 3。
 * 条件 5：不是 git 仓库 → 改动包，清单列出改动。
 * 条件 6：项目根目录不在有效的文件夹授权里 → 不落地，apply_error 写明原因。
 * 条件 7：仓库没配置提交人 → 用 IXAEON 兜底身份提交成功。
 * 条件 8：提交失败（pre-commit 拒绝）→ 没有残留临时工作树，改走改动包。
 * 契约 2：这次没有改动文件 → 不落地。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedGit[key] = process.env[key];
    const empty = join(mkdtempSync(join(tmpdir(), 'ixa-d4-gitcfg-')), 'empty');
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
      // git 偶发占着临时目录，留给系统清
    }
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** 初始提交必须自带身份：测试把全局 git 配置隔开了。 */
function commitAll(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', message]);
}

function initRepo(root: string): void {
  git(root, ['init', '-b', 'main']);
  writeFileSync(join(root, 'note.txt'), '第一版');
  commitAll(root, '初始');
}

interface Harness {
  dataDir: string;
  root: string;
  coding: CodingOrchestrator;
  projectId: string;
  /** 替身下次派发要写进副本的文件。派发前改这里。 */
  files: Record<string, string>;
}

function harness(opts: { gitRepo: boolean; grant: boolean }): Harness {
  const dataDir = tempDir('ixa-d4-data-');
  const root = tempDir('ixa-d4-root-');
  if (opts.gitRepo) initRepo(root);
  else writeFileSync(join(root, 'note.txt'), '第一版');
  db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const project = new ProjectService(db).create({
    name: '合成项目',
    rootPath: root,
    description: null,
  });
  if (opts.grant) new PermissionService(db).grantFolder(root);
  const files: Record<string, string> = {};
  return {
    dataDir,
    root,
    projectId: project.id,
    files,
    coding: new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ claimedSuccess: true, files }),
      dataDir,
    ),
  };
}

function useFiles(h: Harness, files: Record<string, string>): void {
  for (const key of Object.keys(h.files)) delete h.files[key];
  Object.assign(h.files, files);
}

/** 建任务、批准（此时快照）、派发替身、接受。 */
async function acceptWith(
  h: Harness,
  files: Record<string, string>,
  goal = '把说明写清楚',
): Promise<{ taskId: string }> {
  useFiles(h, files);
  const task = h.coding.create({
    projectId: h.projectId,
    goal,
    scope: Object.keys(files).length > 0 ? Object.keys(files) : ['note.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  await h.coding.accept(task.id);
  return { taskId: task.id };
}

function row(taskId: string): {
  applied_ref: string | null;
  apply_error: string | null;
  status: string;
} {
  return db!
    .prepare('SELECT applied_ref, apply_error, status FROM coding_tasks WHERE id = ?')
    .get(taskId) as {
    applied_ref: string | null;
    apply_error: string | null;
    status: string;
  };
}

function repoFingerprint(root: string): {
  branch: string;
  head: string;
  status: string;
  staged: string;
} {
  return {
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(root, ['rev-parse', 'HEAD']),
    status: git(root, ['status', '--porcelain']),
    staged: git(root, ['diff', '--cached', '--name-only']),
  };
}

function worktreeCount(root: string): number {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
}

function patchText(dataDir: string, taskId: string): string {
  const dir = join(dataDir, 'patches', taskId);
  const chunks: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      try {
        const text = readFileSync(abs, 'utf8');
        chunks.push(text);
      } catch {
        walk(abs);
      }
    }
  };
  walk(dir);
  return chunks.join('\n');
}

it('条件 1：接受后在项目仓库建分支，提交正好是这两处改动，工作区不动', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const before = repoFingerprint(h.root);
  const { taskId } = await acceptWith(h, { 'note.txt': '改过了', 'hello.txt': '新文件' });
  const branch = `ixaeon/${taskId.slice(0, 8)}`;
  expect(row(taskId).applied_ref).toBe(branch);
  expect(row(taskId).status).toBe('completed');
  expect(git(h.root, ['branch', '--list', branch])).toBe(branch);
  expect(
    git(h.root, ['diff', '--name-only', `main...${branch}`])
      .split('\n')
      .sort(),
  ).toEqual(['hello.txt', 'note.txt']);
  expect(git(h.root, ['show', `${branch}:note.txt`])).toBe('改过了');
  expect(git(h.root, ['show', `${branch}:hello.txt`])).toBe('新文件');
  expect(git(h.root, ['log', '-1', '--format=%s', branch])).toBe('IXAEON：把说明写清楚');
  expect(git(h.root, ['log', '-1', '--format=%b', branch])).toContain(taskId);
  expect(repoFingerprint(h.root)).toEqual(before);
});

it('条件 2：分支名已经存在时用 -2', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '再改一版',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  git(h.root, ['branch', `ixaeon/${task.id.slice(0, 8)}`]);
  useFiles(h, { 'note.txt': '第二版' });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  await h.coding.accept(task.id);
  expect(row(task.id).applied_ref).toBe(`ixaeon/${task.id.slice(0, 8)}-2`);
});

it('条件 3：派发后项目里又提交了同一个文件 → 不建分支，改动包点名该文件', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '改说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  writeFileSync(join(h.root, 'note.txt'), '你后来提交的');
  commitAll(h.root, '你的提交');
  const before = repoFingerprint(h.root);
  useFiles(h, { 'note.txt': '代理改的' });
  await h.coding.dispatch(task.id);
  await h.coding.accept(task.id);
  expect(git(h.root, ['branch', '--list', `ixaeon/${task.id.slice(0, 8)}*`])).toBe('');
  expect(row(task.id).applied_ref ?? '').toContain(join('patches', task.id));
  expect(row(task.id).apply_error ?? '').toContain('note.txt');
  expect(patchText(h.dataDir, task.id)).toContain('note.txt');
  expect(repoFingerprint(h.root)).toEqual(before);
});

it('条件 4：快照时文件有没提交的改动 → 同冲突，不建分支', async () => {
  const h = harness({ gitRepo: true, grant: true });
  writeFileSync(join(h.root, 'note.txt'), '还没提交的改动');
  const { taskId } = await acceptWith(h, { 'note.txt': '代理改的' }, '覆盖说明');
  expect(git(h.root, ['branch', '--list', `ixaeon/${taskId.slice(0, 8)}*`])).toBe('');
  expect(row(taskId).apply_error ?? '').toContain('note.txt');
  expect(existsSync(join(h.dataDir, 'patches', taskId))).toBe(true);
});

it('条件 5：不是 git 仓库 → 改动包，清单列出改了的和新增的', async () => {
  const h = harness({ gitRepo: false, grant: true });
  const { taskId } = await acceptWith(h, { 'note.txt': '改过了', 'hello.txt': '新文件' });
  expect(existsSync(join(h.dataDir, 'patches', taskId))).toBe(true);
  expect(row(taskId).applied_ref ?? '').toContain(join('patches', taskId));
  const text = patchText(h.dataDir, taskId);
  expect(text).toContain('note.txt');
  expect(text).toContain('hello.txt');
  expect(readFileSync(join(h.dataDir, 'patches', taskId, 'note.txt'), 'utf8')).toBe('改过了');
});

it('条件 6：项目根目录没有有效的文件夹授权 → 不落地，写明原因', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const perm = new PermissionService(db!).list(false)[0]!;
  new PermissionService(db!).revoke(perm.id);
  const branchesBefore = git(h.root, ['branch', '--list']);
  const { taskId } = await acceptWith(h, { 'note.txt': '不该落地' });
  expect(row(taskId).applied_ref).toBeNull();
  expect(row(taskId).apply_error ?? '').toContain('没有这个项目目录的读取授权');
  expect(git(h.root, ['branch', '--list'])).toBe(branchesBefore);
  expect(existsSync(join(h.dataDir, 'patches', taskId))).toBe(false);
});

it('条件 7：仓库没配置提交人 → 用 IXAEON 兜底身份提交成功', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const { taskId } = await acceptWith(h, { 'note.txt': '兜底身份' }, '补一句');
  const branch = `ixaeon/${taskId.slice(0, 8)}`;
  expect(row(taskId).applied_ref).toBe(branch);
  expect(git(h.root, ['log', '-1', '--format=%an', branch])).toBe('IXAEON');
  expect(git(h.root, ['log', '-1', '--format=%ae', branch])).toBe('ixaeon@localhost');
});

it('条件 8：提交被钩子拒绝后，临时工作树被清掉，改走改动包', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const hooks = join(h.root, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  git(h.root, ['config', 'core.hooksPath', hooks]);
  const { taskId } = await acceptWith(h, { 'note.txt': '钩子会拒绝' });
  expect(row(taskId).applied_ref ?? '').toContain(join('patches', taskId));
  expect(worktreeCount(h.root)).toBe(1);
  expect(existsSync(join(h.dataDir, 'patches', taskId, 'note.txt'))).toBe(true);
});

it('契约 2：这次没有改动文件 → 不建分支也不生成改动包', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const branchesBefore = git(h.root, ['branch', '--list']);
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '看看就好',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  await h.coding.accept(task.id);
  expect(row(task.id).applied_ref).toBeNull();
  expect(git(h.root, ['branch', '--list'])).toBe(branchesBefore);
  expect(existsSync(join(h.dataDir, 'patches', task.id))).toBe(false);
});
