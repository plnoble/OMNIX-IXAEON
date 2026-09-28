/**
 * D4 真机检查：临时目录里建一个合成的 git 仓库当项目，走完整的
 * 「建任务 → 执行器替身改文件 → 接受」（不调用真 Codex），贴
 * git branch / git log --stat <分支> -1 / git status 的输出，证明
 * 分支建好、工作区没动。改动包路径与冲突回退也在同一个脚本里各走一遍。
 *
 *   node scripts/real/d4-landing.ts
 *
 * 只用合成数据；git 全局配置隔开，不碰用户的项目。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
} from '../../packages/core/src/index.js';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (repo: string, args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// 隔开本机 git 全局配置（签名、钩子），合成仓库不带任何用户痕迹。
for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
  const empty = join(tempDir('ixa-d4-real-cfg-'), 'empty');
  writeFileSync(empty, '');
  process.env[key] = empty;
}

const scenario = (name: string, files: Record<string, string>) => {
  const dataDir = tempDir('ixa-d4-real-data-');
  const root = tempDir('ixa-d4-real-proj-');
  git(root, ['init', '-b', 'main']);
  writeFileSync(join(root, 'note.txt'), '第一版\n');
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=Real', '-c', 'user.email=real@localhost', 'commit', '-m', '初始']);
  const db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const project = new ProjectService(db).create({
    name: '合成项目',
    rootPath: root,
    description: null,
  });
  new PermissionService(db).grantFolder(root);
  const executor = new FakeCodingExecutor({ claimedSuccess: true, files });
  const coding = new CodingOrchestrator(db, executor, dataDir);
  return { name, dataDir, root, db, project, coding };
};

// --- 场景 1：git 仓库建分支 ---
{
  const { root, db, project, coding } = scenario('branch', {
    'note.txt': '改过了\n',
    'hello.txt': '新文件\n',
  });
  const task = coding.create({
    projectId: project.id,
    goal: '把说明写清楚',
    scope: ['note.txt', 'hello.txt'],
    allowedCommands: [[process.execPath, '-e', 'process.exit(0)']],
  });
  await coding.approveAndQueue(task.id);
  await coding.dispatch(task.id);
  const done = await coding.accept(task.id);
  const branch = `ixaeon/${task.id.slice(0, 8)}`;
  console.log(`\n=== 场景 1：git 仓库 → 建分支（applied_ref=${done.applied_ref}）`);
  console.log('--- git branch：');
  console.log(git(root, ['branch']));
  console.log(`--- git log --stat ${branch} -1：`);
  console.log(git(root, ['log', '--stat', branch, '-1']));
  console.log('--- git status：');
  console.log(git(root, ['status', '--porcelain']) || '(干净)');
  db.close();
}

// --- 场景 2：派发后用户先提交同一文件 → 冲突回退改动包 ---
{
  const { root, db, project, coding } = scenario('conflict', { 'note.txt': '代理改的\n' });
  const task = coding.create({
    projectId: project.id,
    goal: '改说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await coding.approveAndQueue(task.id);
  await coding.dispatch(task.id);
  writeFileSync(join(root, 'note.txt'), '用户先提交的\n');
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.name=Real',
    '-c',
    'user.email=real@localhost',
    'commit',
    '-m',
    '用户的新提交',
  ]);
  const done = await coding.accept(task.id);
  console.log(`\n=== 场景 2：派发后用户提交了同一文件 → 改动包（applied_ref=${done.applied_ref}）`);
  console.log(`apply_error：${done.apply_error}`);
  console.log(`清单：${readFileSync(join(done.applied_ref!, 'manifest.json'), 'utf8').trim()}`);
  console.log('--- 用户版本留在原地：');
  console.log(git(root, ['show', 'HEAD:note.txt']));
  db.close();
}

// --- 场景 3：不是 git 仓库 → 改动包 ---
{
  const { root, db, project, coding } = scenario('patch', { 'note.txt': '改过了\n' });
  rmSync(join(root, '.git'), { recursive: true, force: true });
  const task = coding.create({
    projectId: project.id,
    goal: '改说明',
    scope: ['note.txt'],
    allowedCommands: [],
  });
  await coding.approveAndQueue(task.id);
  await coding.dispatch(task.id);
  const done = await coding.accept(task.id);
  console.log(`\n=== 场景 3：不是 git 仓库 → 改动包（applied_ref=${done.applied_ref}）`);
  console.log(`apply_error：${done.apply_error}`);
  console.log(`清单：${readFileSync(join(done.applied_ref!, 'manifest.json'), 'utf8').trim()}`);
  console.log(`note.txt 内容：${readFileSync(join(done.applied_ref!, 'note.txt'), 'utf8').trim()}`);
  db.close();
}

for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
process.exit(0);
