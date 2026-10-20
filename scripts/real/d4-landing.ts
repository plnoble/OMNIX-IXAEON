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

// 打印遮掉本机账户名与临时目录（照 scripts/real/p5-unbind-folder.mjs 的规矩；真机输出会进交付说明）
const maskOut = (v: unknown): string => {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (v instanceof Error) text = v.stack ?? v.message;
  else {
    try {
      const json = JSON.stringify(v);
      text = json === undefined ? String(v) : json;
    } catch {
      text = String(v);
    }
  }
  let s = text;
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
  ]) {
    if (!p || !p.trim()) continue;
    s = s.replaceAll(p, '<本机>');
    // JSON.stringify 把反斜杠转义成双份：对象里的路径要照转义后的样子再遮一次
    const escaped = JSON.stringify(p).slice(1, -1);
    if (escaped !== p) s = s.replaceAll(escaped, '<本机>');
  }
  return s;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(...a.map(maskOut));
}

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

// 三个场景逐条对照，只有全都符合才写「通过」；出错非零（照 p5/p7 的规矩）。
let passed = true;
const fail = (why: string) => {
  passed = false;
  console.log('不符：', why);
};
// 出错也要有 RESULT 行、退出码和结论一致（这个脚本是顶层的顺序块，不好包 try/catch）
const bail = (err: unknown): never => {
  console.log('RESULT 没通过：' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

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
  const branches = git(root, ['branch']);
  const logStat = git(root, ['log', '--stat', branch, '-1']);
  const status = git(root, ['status', '--porcelain']);
  console.log(`\n=== 场景 1：git 仓库 → 建分支（applied_ref=${done.applied_ref}）`);
  console.log('--- git branch：');
  console.log(branches);
  console.log(`--- git log --stat ${branch} -1：`);
  console.log(logStat);
  console.log('--- git status：');
  console.log(status || '(干净)');
  if (!branches.includes(branch)) fail(`场景 1 没建出分支 ${branch}`);
  if (!logStat.includes('note.txt') || !logStat.includes('hello.txt')) {
    fail('场景 1 那个提交里没有同时包含 note.txt 与 hello.txt');
  }
  if (status !== '') fail(`场景 1 落地之后工作区不干净：${status}`);
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
  const manifest2 = readFileSync(join(done.applied_ref!, 'manifest.json'), 'utf8').trim();
  const userVersion = git(root, ['show', 'HEAD:note.txt']);
  // 只查提交里那份不够：改动包落地时也可能把工作区那份覆盖掉，所以工作区文件也读一遍（两处都得是用户的版本）
  const workingVersion = readFileSync(join(root, 'note.txt'), 'utf8').trim();
  console.log(`\n=== 场景 2：派发后用户提交了同一文件 → 改动包（applied_ref=${done.applied_ref}）`);
  console.log(`apply_error：${done.apply_error}`);
  console.log(`清单：${manifest2}`);
  console.log('--- 用户版本留在原地（提交里）：');
  console.log(userVersion);
  console.log('--- 用户版本留在原地（工作区）：');
  console.log(workingVersion);
  if (!done.apply_error)
    fail('场景 2：用户先提交过同一文件，apply_error 却是空的（期望回退成改动包）');
  if (!String(done.applied_ref).includes('patches')) {
    fail('场景 2：没落到改动包目录（applied_ref 里没有 patches）');
  }
  if (userVersion !== '用户先提交的') fail(`场景 2：提交里用户自己的版本被覆盖了：${userVersion}`);
  if (workingVersion !== '用户先提交的')
    fail(`场景 2：工作区里用户自己的版本被覆盖了：${workingVersion}`);
  if (!manifest2.includes('note.txt')) fail('场景 2：改动包清单里没有 note.txt');
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
  const manifest3 = readFileSync(join(done.applied_ref!, 'manifest.json'), 'utf8').trim();
  const patchContent = readFileSync(join(done.applied_ref!, 'note.txt'), 'utf8').trim();
  console.log(`\n=== 场景 3：不是 git 仓库 → 改动包（applied_ref=${done.applied_ref}）`);
  console.log(`apply_error：${done.apply_error}`);
  console.log(`清单：${manifest3}`);
  console.log(`note.txt 内容：${patchContent}`);
  if (!done.apply_error) fail('场景 3：不是 git 仓库，apply_error 却是空的');
  if (!manifest3.includes('note.txt')) fail('场景 3：改动包清单里没有 note.txt');
  if (patchContent !== '改过了') fail(`场景 3：改动包里的 note.txt 内容不对：${patchContent}`);
  db.close();
}

for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
console.log(
  'RESULT',
  passed
    ? '通过：git 仓库落地成分支（含两个文件、工作区干净）→ 用户先提交同一文件时回退成改动包且不覆盖用户版本 → 不是 git 仓库时也出改动包'
    : '没通过：上面有不符或脚本出错的那条',
);
process.exit(passed ? 0 : 1);
