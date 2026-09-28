/**
 * D4 验收（规格 docs/委派/D4-接受后在项目里建分支.md）
 *
 * 直接测 CodingOrchestrator.accept 之后的落地。项目是临时目录里的真 git 仓库
 * （或普通文件夹），执行器是替身，不调用 Codex。git 身份与本机全局配置隔开，
 * 否则「没配置提交人」测不到。
 *
 * 与验收条件、契约的对应：
 * - 条件 1：改一个、加一个 → 分支 ixaeon/<任务 id 前 8 位>，提交正好这两处；
 *   标题按契约 4，正文含任务 id 和验证结果；仓库里先备好已暂存、未提交修改、
 *   未跟踪三种内容，落地后当前分支、HEAD、工作区、暂存区全部原样（防实现清空
 *   暂存或覆盖工作区）；挂了远端也不推送。
 * - 契约 4 删除：删掉的文件照删——分支提交里看得到删除。
 * - 条件 2：分支名已存在 → -2。
 * - 条件 3：派发之后你在项目里提交了同一个文件 → 不建分支，改走改动包，
 *   apply_error 列出这个文件。
 * - 条件 4：快照时这个文件有没提交的改动（与 HEAD 不同）→ 同条件 3。
 * - 条件 5：不是 git 仓库 → 改动包，manifest.json 分类列出改了/新增/删除；
 *   删除在非 git 项目同样列为删除。
 * - 条件 6：授权提前撤销 / 派发后接受前撤销 / 有效授权在别处（项目不在其内）/
 *   父目录授权（项目在授权内）——最后这种要正常落地。
 * - 条件 7：仓库没配置提交人 → IXAEON 兜底身份照样提交，正文同样带验证结果。
 * - 条件 8：提交被钩子拒绝、写文件撞上同名目录 → 都没有残留临时工作树，改走改动包。
 * - 契约 2：这次没有改动文件 → 不落地。
 * - 只在点「接受」之后落地：批准后、派发后都没有分支、没有改动包。
 *
 * 契约 6 的对话回报与任务页显示在 apps/desktop/test/acceptance/d4-landing-report.test.ts
 * （回报走 D3 的桌面机制，核心层测不到）。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
  type CodingExecutor,
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

/** 工作区里先备好三种内容：已暂存的新文件、已提交后未暂存的修改、未跟踪文件。 */
function seedDirty(root: string): void {
  writeFileSync(join(root, 'modified.txt'), 'v1');
  commitAll(root, '已有内容');
  writeFileSync(join(root, 'modified.txt'), 'v2 没提交的改动');
  writeFileSync(join(root, 'staged.txt'), '已暂存');
  git(root, ['add', 'staged.txt']);
  writeFileSync(join(root, 'untracked.txt'), '未跟踪');
}

function dirtyContents(root: string): string {
  return ['modified.txt', 'staged.txt', 'untracked.txt']
    .map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '<无>'))
    .join('|');
}

/** 仓库全貌：当前分支、HEAD、状态、暂存区差异、未暂存差异、脏文件内容。 */
function repoFingerprint(root: string): Record<string, string> {
  return {
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(root, ['rev-parse', 'HEAD']),
    status: git(root, ['status', '--porcelain']),
    staged: git(root, ['diff', '--cached']),
    unstaged: git(root, ['diff']),
    dirty: dirtyContents(root),
  };
}

function worktreeCount(root: string): number {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
}

interface Harness {
  dataDir: string;
  root: string;
  gitRepo: boolean;
  coding: CodingOrchestrator;
  projectId: string;
  /** 替身下次派发要写进副本的文件。派发前改这里。 */
  files: Record<string, string>;
}

function harness(
  opts: {
    gitRepo?: boolean;
    grant?: boolean;
    /** 授权给项目根的父目录（项目仍在授权范围之内，照规格应落地）。 */
    grantParent?: boolean;
    executor?: CodingExecutor;
  } = {},
): Harness {
  const dataDir = tempDir('ixa-d4-data-');
  let root: string;
  if (opts.grantParent) {
    const parent = tempDir('ixa-d4-parent-');
    root = join(parent, 'proj');
    mkdirSync(root, { recursive: true });
  } else {
    root = tempDir('ixa-d4-root-');
  }
  const gitRepo = opts.gitRepo !== false;
  if (gitRepo) initRepo(root);
  else writeFileSync(join(root, 'note.txt'), '第一版');
  db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const project = new ProjectService(db).create({
    name: '合成项目',
    rootPath: root,
    description: null,
  });
  const perms = new PermissionService(db);
  if (opts.grantParent) perms.grantFolder(dirname(root));
  else if (opts.grant !== false) perms.grantFolder(root);
  const files: Record<string, string> = {};
  const executor = opts.executor ?? new FakeCodingExecutor({ claimedSuccess: true, files });
  return {
    dataDir,
    root,
    gitRepo,
    projectId: project.id,
    files,
    coding: new CodingOrchestrator(db, executor, dataDir),
  };
}

function useFiles(h: Harness, files: Record<string, string>): void {
  for (const key of Object.keys(h.files)) delete h.files[key];
  Object.assign(h.files, files);
}

function row(taskId: string): {
  applied_ref: string | null;
  applied_at: string | null;
  apply_error: string | null;
  status: string;
} {
  return db!
    .prepare('SELECT applied_ref, applied_at, apply_error, status FROM coding_tasks WHERE id = ?')
    .get(taskId) as {
    applied_ref: string | null;
    applied_at: string | null;
    apply_error: string | null;
    status: string;
  };
}

/** 改动包落地的统一断言：applied_ref 指向补丁目录本身，applied_at 有时间。 */
function expectPatchRef(h: Harness, taskId: string): void {
  const r = row(taskId);
  expect(r.applied_ref).not.toBeNull();
  expect(resolve(r.applied_ref!)).toBe(resolve(patchDir(h.dataDir, taskId)));
  expect(r.applied_at).not.toBeNull();
}

function patchDir(dataDir: string, taskId: string): string {
  return join(dataDir, 'patches', taskId);
}

/** 改动包清单：分类列出改了/新增/删除，冲突时点名冲突文件（契约 5）。 */
function manifest(
  dataDir: string,
  taskId: string,
): { changed: string[]; added: string[]; deleted: string[]; conflict: string[] } {
  return JSON.parse(readFileSync(join(patchDir(dataDir, taskId), 'manifest.json'), 'utf8')) as {
    changed: string[];
    added: string[];
    deleted: string[];
    conflict: string[];
  };
}

const sorted = (a: string[]) => a.slice().sort();

/** 点「接受」之前不允许有任何落地：批准后查一次，派发后再查一次（只在接受之后落地）。 */
function expectNotLanded(h: Harness, taskId: string): void {
  expect(row(taskId).applied_ref).toBeNull();
  expect(row(taskId).applied_at).toBeNull();
  expect(existsSync(patchDir(h.dataDir, taskId))).toBe(false);
  if (h.gitRepo) expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
}

/** 建任务、批准、派发、接受；批准后与派发后各核一次「还没落地」。 */
async function runTask(
  h: Harness,
  input: { goal: string; scope: string[]; commands?: string[][] },
): Promise<string> {
  const task = h.coding.create({
    projectId: h.projectId,
    goal: input.goal,
    scope: input.scope,
    allowedCommands: input.commands ?? [],
  });
  await h.coding.approveAndQueue(task.id);
  expectNotLanded(h, task.id);
  await h.coding.dispatch(task.id);
  expectNotLanded(h, task.id);
  await h.coding.accept(task.id);
  return task.id;
}

async function acceptWith(
  h: Harness,
  files: Record<string, string>,
  opts: { goal?: string; commands?: string[][] } = {},
): Promise<string> {
  useFiles(h, files);
  const keys = Object.keys(files);
  return runTask(h, {
    goal: opts.goal ?? '把说明写清楚',
    scope: keys.length > 0 ? keys : ['note.txt'],
    commands: opts.commands,
  });
}

const PASSING_COMMAND = [[process.execPath, '-e', 'process.exit(0)']];

it('条件 1：接受后建分支，提交正好这两处，已有暂存/未提交/未跟踪原样，也不推送', async () => {
  const h = harness({ gitRepo: true, grant: true });
  seedDirty(h.root);
  // 挂一个空远端：实现若推送，这里立刻多出引用
  const bare = tempDir('ixa-d4-bare-');
  git(bare, ['init', '--bare']);
  git(h.root, ['remote', 'add', 'origin', bare]);
  const before = repoFingerprint(h.root);
  const taskId = await acceptWith(
    h,
    { 'note.txt': '改过了', 'hello.txt': '新文件' },
    { commands: PASSING_COMMAND },
  );
  const branch = `ixaeon/${taskId.slice(0, 8)}`;
  const r = row(taskId);
  expect(r.status).toBe('completed');
  expect(r.applied_ref).toBe(branch);
  expect(r.apply_error).toBeNull();
  expect(r.applied_at).not.toBeNull();
  expect(Number.isNaN(Date.parse(r.applied_at!))).toBe(false);
  expect(git(h.root, ['branch', '--list', branch])).toBe(branch);
  expect(
    git(h.root, ['diff', '--name-only', `main...${branch}`])
      .split('\n')
      .sort(),
  ).toEqual(['hello.txt', 'note.txt']);
  expect(git(h.root, ['show', `${branch}:note.txt`])).toBe('改过了');
  expect(git(h.root, ['show', `${branch}:hello.txt`])).toBe('新文件');
  expect(git(h.root, ['log', '-1', '--format=%s', branch])).toBe('IXAEON：把说明写清楚');
  // 契约 4：正文写任务 id 和验证结果
  const body = git(h.root, ['log', '-1', '--format=%b', branch]);
  expect(body).toContain(taskId);
  expect(body).toContain('passed');
  // 契约 4：临时工作树用完就清
  expect(worktreeCount(h.root)).toBe(1);
  // 契约 4：不推送——远端还是空的
  expect(git(h.root, ['ls-remote', 'origin'])).toBe('');
  // 当前分支、HEAD、工作区、暂存区都没变
  expect(repoFingerprint(h.root)).toEqual(before);
});

it('契约 4：删掉的文件照删——分支提交里有删除', async () => {
  const h = harness({
    gitRepo: true,
    grant: true,
    executor: {
      name: 'fake',
      run: async (_task, workspace) => {
        rmSync(join(workspace, 'note.txt'));
        return {
          claimedSuccess: true,
          summary: '删掉了 note.txt',
          changedPaths: ['note.txt'],
          testsModified: false,
          raw: '',
        };
      },
    },
  });
  const before = repoFingerprint(h.root);
  const taskId = await runTask(h, { goal: '删掉说明', scope: ['note.txt'] });
  const branch = `ixaeon/${taskId.slice(0, 8)}`;
  expect(row(taskId).applied_ref).toBe(branch);
  expect(git(h.root, ['diff', '--name-status', `main...${branch}`])).toMatch(/^D\s+note\.txt$/m);
  expect(() => git(h.root, ['show', `${branch}:note.txt`])).toThrow();
  expect(worktreeCount(h.root)).toBe(1);
  expect(repoFingerprint(h.root)).toEqual(before);
});

it('条件 2：分支名已存在时用 -2', async () => {
  const h = harness({ gitRepo: true, grant: true });
  seedDirty(h.root);
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '再改一版',
    scope: ['note.txt'],
    allowedCommands: PASSING_COMMAND,
  });
  git(h.root, ['branch', `ixaeon/${task.id.slice(0, 8)}`]);
  useFiles(h, { 'note.txt': '第二版' });
  const before = repoFingerprint(h.root);
  const existingBefore = git(h.root, ['rev-parse', `ixaeon/${task.id.slice(0, 8)}`]);
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  await h.coding.accept(task.id);
  const r = row(task.id);
  const branch2 = `ixaeon/${task.id.slice(0, 8)}-2`;
  expect(r.applied_ref).toBe(branch2);
  expect(r.applied_at).not.toBeNull();
  // -2 分支真的存在，改动落在它上面；占住名字的原分支没被动，工作树清干净
  expect(git(h.root, ['branch', '--list', branch2])).toBe(branch2);
  expect(git(h.root, ['show', `${branch2}:note.txt`])).toBe('第二版');
  expect(git(h.root, ['rev-parse', `ixaeon/${task.id.slice(0, 8)}`])).toBe(existingBefore);
  expect(worktreeCount(h.root)).toBe(1);
  expect(repoFingerprint(h.root)).toEqual(before);
});

it('条件 3：派发之后你又提交了同一个文件 → 不建分支，改动包点名该文件', async () => {
  const h = harness({ gitRepo: true, grant: true });
  useFiles(h, { 'note.txt': '代理改的' });
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '改说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  // 派发之后、接受之前，你在项目里提交了同一个文件
  writeFileSync(join(h.root, 'note.txt'), '你后来提交的');
  commitAll(h.root, '你的提交');
  const before = repoFingerprint(h.root);
  await h.coding.accept(task.id);
  const r = row(task.id);
  expect(git(h.root, ['branch', '--list', `ixaeon/${task.id.slice(0, 8)}*`])).toBe('');
  expectPatchRef(h, task.id);
  expect(r.apply_error ?? '').toContain('note.txt');
  const m = manifest(h.dataDir, task.id);
  expect(sorted(m.conflict)).toEqual(['note.txt']);
  expect(sorted(m.changed)).toEqual(['note.txt']);
  expect(m.added).toEqual([]);
  expect(m.deleted).toEqual([]);
  expect(readFileSync(join(patchDir(h.dataDir, task.id), 'note.txt'), 'utf8')).toBe('代理改的');
  expect(repoFingerprint(h.root)).toEqual(before);
});

it('条件 4：快照时文件有没提交的改动 → 同冲突，不建分支', async () => {
  const h = harness({ gitRepo: true, grant: true });
  writeFileSync(join(h.root, 'note.txt'), '还没提交的改动');
  const taskId = await acceptWith(h, { 'note.txt': '代理改的' }, { goal: '覆盖说明' });
  const r = row(taskId);
  expect(git(h.root, ['branch', '--list', `ixaeon/${taskId.slice(0, 8)}*`])).toBe('');
  expectPatchRef(h, taskId);
  expect(r.apply_error ?? '').toContain('note.txt');
  expect(sorted(manifest(h.dataDir, taskId).conflict)).toEqual(['note.txt']);
  // 用户没提交的改动原样留着
  expect(readFileSync(join(h.root, 'note.txt'), 'utf8')).toBe('还没提交的改动');
  expect(git(h.root, ['status', '--porcelain'])).toContain('note.txt');
});

it('条件 5：不是 git 仓库 → 改动包，manifest.json 分类列出改了和新增', async () => {
  const h = harness({ gitRepo: false, grant: true });
  const taskId = await acceptWith(h, { 'note.txt': '改过了', 'hello.txt': '新文件' });
  expectPatchRef(h, taskId);
  const m = manifest(h.dataDir, taskId);
  expect(sorted(m.changed)).toEqual(['note.txt']);
  expect(sorted(m.added)).toEqual(['hello.txt']);
  expect(m.deleted).toEqual([]);
  expect(m.conflict).toEqual([]);
  expect(readFileSync(join(patchDir(h.dataDir, taskId), 'note.txt'), 'utf8')).toBe('改过了');
  expect(readFileSync(join(patchDir(h.dataDir, taskId), 'hello.txt'), 'utf8')).toBe('新文件');
});

it('条件 5：改动包把删除列为删除，目录里没有这个文件', async () => {
  const h = harness({
    gitRepo: false,
    grant: true,
    executor: {
      name: 'fake',
      run: async (_task, workspace) => {
        rmSync(join(workspace, 'note.txt'));
        return {
          claimedSuccess: true,
          summary: '删掉了 note.txt',
          changedPaths: ['note.txt'],
          testsModified: false,
          raw: '',
        };
      },
    },
  });
  const taskId = await runTask(h, { goal: '删掉说明', scope: ['note.txt'] });
  expectPatchRef(h, taskId);
  const m = manifest(h.dataDir, taskId);
  expect(sorted(m.deleted)).toEqual(['note.txt']);
  expect(m.changed).toEqual([]);
  expect(m.added).toEqual([]);
  expect(existsSync(join(patchDir(h.dataDir, taskId), 'note.txt'))).toBe(false);
});

it('条件 6：授权在开流程前撤销 → 不落地，写明原因', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const perm = new PermissionService(db!).list(false)[0]!;
  new PermissionService(db!).revoke(perm.id);
  const branchesBefore = git(h.root, ['branch', '--list']);
  const taskId = await acceptWith(h, { 'note.txt': '不该落地' });
  const r = row(taskId);
  expect(r.applied_ref).toBeNull();
  expect(r.applied_at).toBeNull();
  expect(r.apply_error ?? '').toContain('没有这个项目目录的读取授权');
  expect(git(h.root, ['branch', '--list'])).toBe(branchesBefore);
  expect(existsSync(patchDir(h.dataDir, taskId))).toBe(false);
});

it('条件 6：授权在派发后、接受前撤销 → 不落地', async () => {
  const h = harness({ gitRepo: true, grant: true });
  useFiles(h, { 'note.txt': '代理改的' });
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '改说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  const perm = new PermissionService(db!).list(false)[0]!;
  new PermissionService(db!).revoke(perm.id);
  await h.coding.accept(task.id);
  const r = row(task.id);
  expect(r.applied_ref).toBeNull();
  expect(r.applied_at).toBeNull();
  expect(r.apply_error ?? '').toContain('没有这个项目目录的读取授权');
  expect(existsSync(patchDir(h.dataDir, task.id))).toBe(false);
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
});

it('条件 6：有效授权在别处、项目不在其内 → 不落地', async () => {
  const h = harness({ gitRepo: true, grant: false });
  new PermissionService(db!).grantFolder(tempDir('ixa-d4-other-'));
  const taskId = await acceptWith(h, { 'note.txt': '不该落地' });
  const r = row(taskId);
  expect(r.applied_ref).toBeNull();
  expect(r.apply_error ?? '').toContain('没有这个项目目录的读取授权');
  expect(existsSync(patchDir(h.dataDir, taskId))).toBe(false);
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
});

it('条件 6：授权给父目录（项目在授权范围之内）→ 照常建分支', async () => {
  const h = harness({ gitRepo: true, grantParent: true });
  const taskId = await acceptWith(h, { 'note.txt': '照常落地' });
  const branch = `ixaeon/${taskId.slice(0, 8)}`;
  expect(row(taskId).applied_ref).toBe(branch);
  expect(git(h.root, ['branch', '--list', branch])).toBe(branch);
  expect(git(h.root, ['show', `${branch}:note.txt`])).toBe('照常落地');
});

it('条件 7：仓库没配置提交人 → IXAEON 兜底身份提交成功，正文带验证结果', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const taskId = await acceptWith(
    h,
    { 'note.txt': '兜底身份' },
    { goal: '补一句', commands: PASSING_COMMAND },
  );
  const branch = `ixaeon/${taskId.slice(0, 8)}`;
  expect(row(taskId).applied_ref).toBe(branch);
  expect(git(h.root, ['log', '-1', '--format=%an', branch])).toBe('IXAEON');
  expect(git(h.root, ['log', '-1', '--format=%ae', branch])).toBe('ixaeon@localhost');
  const body = git(h.root, ['log', '-1', '--format=%b', branch]);
  expect(body).toContain(taskId);
  expect(body).toContain('passed');
});

it('条件 8：提交被钩子拒绝 → 没有残留临时工作树，改走改动包', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const hooks = join(h.root, 'hooks');
  mkdirSync(hooks);
  const hook = join(hooks, 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755); // POSIX 上没有执行位钩子会被跳过，就白挂了
  git(h.root, ['config', 'core.hooksPath', hooks]);
  const taskId = await acceptWith(h, { 'note.txt': '钩子会拒绝' });
  expectPatchRef(h, taskId);
  expect(worktreeCount(h.root)).toBe(1);
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
  expect(readFileSync(join(patchDir(h.dataDir, taskId), 'note.txt'), 'utf8')).toBe('钩子会拒绝');
  expect(sorted(manifest(h.dataDir, taskId).changed)).toEqual(['note.txt']);
});

it('条件 8：写文件撞上同名目录 → 临时工作树照样清掉，改走改动包', async () => {
  // HEAD 里 d 是个目录；执行器把副本里的 d 换成文件，往工作树里写必失败。
  // 实现得清干净临时工作树，再改走改动包。
  const mutator: CodingExecutor = {
    name: 'fake',
    run: async (_task, workspace) => {
      rmSync(join(workspace, 'd'), { recursive: true, force: true });
      writeFileSync(join(workspace, 'd'), '现在是文件');
      return {
        claimedSuccess: true,
        summary: '目录换文件',
        changedPaths: ['d', 'd/a.txt'],
        testsModified: false,
        raw: '',
      };
    },
  };
  const h = harness({ gitRepo: true, grant: true, executor: mutator });
  mkdirSync(join(h.root, 'd'));
  writeFileSync(join(h.root, 'd', 'a.txt'), '目录内容');
  commitAll(h.root, '先有目录');
  const taskId = await runTask(h, { goal: '目录换文件', scope: ['d', 'd/a.txt'] });
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
  expect(worktreeCount(h.root)).toBe(1);
  expectPatchRef(h, taskId);
  expect(readFileSync(join(patchDir(h.dataDir, taskId), 'd'), 'utf8')).toBe('现在是文件');
  const m = manifest(h.dataDir, taskId);
  expect(sorted(m.added)).toEqual(['d']);
  expect(sorted(m.deleted)).toEqual(['d/a.txt']);
  expect(m.changed).toEqual([]);
});

it('契约 2：这次没有改动文件 → 不建分支也不生成改动包', async () => {
  const h = harness({ gitRepo: true, grant: true });
  const branchesBefore = git(h.root, ['branch', '--list']);
  const taskId = await acceptWith(h, {});
  const r = row(taskId);
  expect(r.status).toBe('completed');
  expect(r.applied_ref).toBeNull();
  expect(r.applied_at).toBeNull();
  expect(git(h.root, ['branch', '--list'])).toBe(branchesBefore);
  expect(existsSync(patchDir(h.dataDir, taskId))).toBe(false);
});
