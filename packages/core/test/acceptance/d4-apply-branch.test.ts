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
 *
 * 整合方复审时定（2026-09-28）：
 * - 改动包的清单照执行方的写法：`<数据目录>/patches/<任务 id>/manifest.json`，四个数组
 *   changed / added / deleted / conflict。
 * - 补一条：临时工作树建在 IXAEON 自己的数据目录里——不在你的项目文件夹里，也不在它旁边。
 *   成功后它被清掉，别的断言看不出建在哪；建在项目里会惊动你那边开着的开发服务器和文件
 *   监视器，建在项目旁边就又弄脏了放项目的文件夹（用户 2026-09-28 刚指出过这类问题）。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  executor: CodingExecutor;
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
    executor,
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

/**
 * 契约 3：基线指纹是派发时记下、要存得住的——换一个新建的编排器实例来接受，
 * 只许从存档（执行报告/库）里读，放在内存里的实现过不了。
 */
async function acceptOnFresh(h: Harness, taskId: string): Promise<void> {
  const fresh = new CodingOrchestrator(db!, h.executor, h.dataDir);
  await fresh.accept(taskId);
}

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
  await acceptOnFresh(h, task.id);
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

it('条件 3：派发后你提交了执行器要新增的文件（基线记为不存在）→ 也算冲突', async () => {
  const h = harness({ gitRepo: true, grant: true });
  useFiles(h, { 'new.txt': '执行器写的' });
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '加个新文件',
    scope: ['new.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  // 派发之后、接受之前，你先一步提交了同名的新文件（基线里它记为不存在）
  writeFileSync(join(h.root, 'new.txt'), '你写的');
  commitAll(h.root, '你的新文件');
  await acceptOnFresh(h, task.id);
  expect(git(h.root, ['branch', '--list', `ixaeon/${task.id.slice(0, 8)}*`])).toBe('');
  expectPatchRef(h, task.id);
  expect(row(task.id).apply_error ?? '').toContain('new.txt');
  const m = manifest(h.dataDir, task.id);
  expect(sorted(m.conflict)).toEqual(['new.txt']);
  expect(sorted(m.added)).toEqual(['new.txt']);
  expect(m.changed).toEqual([]);
  // 改动包里放执行器的版本；你提交的版本留在你的工作区
  expect(readFileSync(join(patchDir(h.dataDir, task.id), 'new.txt'), 'utf8')).toBe('执行器写的');
  expect(readFileSync(join(h.root, 'new.txt'), 'utf8')).toBe('你写的');
  expect(worktreeCount(h.root)).toBe(1);
});

it('契约 4：分支从接受时的 HEAD 建——派发后你提交了别的文件，也在分支里', async () => {
  const h = harness({ gitRepo: true, grant: true });
  useFiles(h, { 'note.txt': '改过了' });
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '改说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  const base = git(h.root, ['rev-parse', 'HEAD']);
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  // 派发之后、接受之前，你提交了执行器没碰的另一个文件
  writeFileSync(join(h.root, 'other.txt'), '你后来提交的');
  commitAll(h.root, '你的新提交');
  const userCommit = git(h.root, ['rev-parse', 'HEAD']);
  expect(userCommit).not.toBe(base);
  await acceptOnFresh(h, task.id);
  const branch = `ixaeon/${task.id.slice(0, 8)}`;
  expect(row(task.id).applied_ref).toBe(branch);
  // 分支的父提交就是接受时的新 HEAD，不是派发时的旧基线
  expect(git(h.root, ['rev-parse', `${branch}^`])).toBe(userCommit);
  expect(git(h.root, ['show', `${branch}:other.txt`])).toBe('你后来提交的');
  expect(git(h.root, ['show', `${branch}:note.txt`])).toBe('改过了');
  expect(
    git(h.root, ['diff', '--name-only', `main...${branch}`])
      .split('\n')
      .sort(),
  ).toEqual(['note.txt']);
  expect(worktreeCount(h.root)).toBe(1);
});

it('条件 4：快照时文件有没提交的改动 → 同冲突，不建分支', async () => {
  const h = harness({ gitRepo: true, grant: true });
  useFiles(h, { 'note.txt': '代理改的' });
  // 批准建副本之前就把没提交的改动放进去：快照（hashWorkspace(before)）会记下它
  writeFileSync(join(h.root, 'note.txt'), '还没提交的改动');
  const task = h.coding.create({
    projectId: h.projectId,
    goal: '覆盖说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await h.coding.approveAndQueue(task.id);
  await h.coding.dispatch(task.id);
  await acceptOnFresh(h, task.id);
  const r = row(task.id);
  expect(git(h.root, ['branch', '--list', `ixaeon/${task.id.slice(0, 8)}*`])).toBe('');
  expectPatchRef(h, task.id);
  expect(r.apply_error ?? '').toContain('note.txt');
  expect(sorted(manifest(h.dataDir, task.id).conflict)).toEqual(['note.txt']);
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

it('条件 6：授权目录只是字符串前缀相同、并不包含项目 → 不落地', async () => {
  // 授权路径取项目根去掉最后一个字符（如授权 …/root-abc12、项目根是 …/root-abc123）：
  // 字符串前缀相同，但它不是项目根的祖先目录——拿 startsWith 判「包含」的实现会误判成已授权。
  // grantFolder 不要求目录存在，不用真建这个目录。
  const h = harness({ gitRepo: true, grant: false });
  new PermissionService(db!).grantFolder(h.root.slice(0, -1));
  const taskId = await acceptWith(h, { 'note.txt': '不该落地' });
  const r = row(taskId);
  expect(r.applied_ref).toBeNull();
  expect(r.apply_error ?? '').toContain('没有这个项目目录的读取授权');
  expect(existsSync(patchDir(h.dataDir, taskId))).toBe(false);
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
});

it('条件 6：接受时项目没有根目录 → 不落地，写明原因', async () => {
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
  // 接受之前项目没了根目录（目录解绑或没设置）
  db!.prepare('UPDATE projects SET root_path = NULL WHERE id = ?').run(h.projectId);
  await h.coding.accept(task.id);
  const r = row(task.id);
  expect(r.applied_ref).toBeNull();
  expect(r.applied_at).toBeNull();
  expect(r.apply_error ?? '').toContain('没有这个项目目录的读取授权');
  expect(existsSync(patchDir(h.dataDir, task.id))).toBe(false);
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
  expect(row(taskId).apply_error ?? '').not.toBe(''); // 写明失败原因
  expect(worktreeCount(h.root)).toBe(1);
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
  expect(readFileSync(join(patchDir(h.dataDir, taskId), 'note.txt'), 'utf8')).toBe('钩子会拒绝');
  expect(sorted(manifest(h.dataDir, taskId).changed)).toEqual(['note.txt']);
});

it('条件 8：建工作树这步就被挡（post-checkout 钩子拒绝）→ 没有残留，改走改动包', async () => {
  // git worktree add 会跑 post-checkout 钩子；钩子退出非零则建树失败，
  // 而且半成品工作树和已建出的分支 git 都不会自己回收——实现必须清干净再改走改动包。
  const h = harness({ gitRepo: true, grant: true });
  const hooks = join(h.root, 'hooks');
  mkdirSync(hooks);
  const hook = join(hooks, 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755); // POSIX 上没有执行位钩子会被跳过，就白挂了
  git(h.root, ['config', 'core.hooksPath', hooks]);
  const taskId = await acceptWith(h, { 'note.txt': '建树被拒' });
  expectPatchRef(h, taskId);
  expect(row(taskId).apply_error ?? '').not.toBe(''); // 写明失败原因
  expect(worktreeCount(h.root)).toBe(1);
  expect(git(h.root, ['branch', '--list', 'ixaeon/*'])).toBe('');
  expect(readFileSync(join(patchDir(h.dataDir, taskId), 'note.txt'), 'utf8')).toBe('建树被拒');
  expect(sorted(manifest(h.dataDir, taskId).changed)).toEqual(['note.txt']);
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

it('整合方补：临时工作树建在 IXAEON 的数据目录里，不在你的项目文件夹里、也不在它旁边', async () => {
  const h = harness({ gitRepo: true, grant: true });
  // post-checkout 在新建的工作树里跑：记下它的位置
  const hooksHome = tempDir('ixa-d4-where-');
  const hooks = join(hooksHome, 'hooks');
  mkdirSync(hooks);
  const record = join(hooksHome, 'where.txt').replaceAll('\\', '/');
  const hook = join(hooks, 'post-checkout');
  writeFileSync(
    hook,
    ['#!/bin/sh', `git rev-parse --show-toplevel >> "${record}"`, 'exit 0', ''].join('\n'),
  );
  chmodSync(hook, 0o755); // POSIX 上没有执行位钩子会被跳过
  git(h.root, ['config', 'core.hooksPath', hooks]);
  const taskId = await acceptWith(h, { 'note.txt': '改过了' });
  expect(row(taskId).applied_ref).toBe(`ixaeon/${taskId.slice(0, 8)}`);
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  // 临时工作树已经删了，取不到它的真实路径：找最长的还在的上级取真实路径再接上余下部分
  // （CI 的 Windows 临时目录是 RUNNER~1 这类短名，git 报的是长名，直接比字符串会误判）
  const canonical = (p: string): string => {
    let head = resolve(p);
    const tail: string[] = [];
    while (!existsSync(head) && dirname(head) !== head) {
      tail.unshift(basename(head));
      head = dirname(head);
    }
    return fold(join(realpathSync.native(head), ...tail));
  };
  const inside = (parent: string, child: string) =>
    canonical(child).startsWith(canonical(parent) + sep);
  const seen = readFileSync(record, 'utf8').split(/\r?\n/).filter(Boolean);
  expect(seen.length).toBeGreaterThan(0);
  for (const where of seen) {
    expect(inside(h.dataDir, where)).toBe(true);
    expect(inside(h.root, where)).toBe(false);
    expect(inside(dirname(h.root), where) && !inside(h.dataDir, where)).toBe(false);
  }
  expect(worktreeCount(h.root)).toBe(1);
});
