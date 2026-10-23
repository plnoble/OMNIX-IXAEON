/**
 * L10 真机检查甲：在本机真跑一次看门人（不设 IXAEON_RELAY_CODE）。
 *
 * 布局照契约第 1 条，但为了不碰用户真实的 `<Worktrees>/IXAEON/relay-run` 和共用检出目录：
 * - 「调度器所在仓库」是一份临时克隆 `sched`，它的 `origin` 是临时裸仓库；
 * - 裸仓库的 `main` 先推上**这一支的代码**，再叠一个只存在于合成世界的队列（第 70 行「待领」）；
 * - `IXAEON_WORKTREES` 指到临时目录 → 看门人把 `relay-run` 建在 `<临时>/trees/relay-run`；
 * - 角色用替身（拉队列、改状态、提交、推回合成 origin）。
 *
 * 看：relay-run 建出来了没有、停在哪个提交、依赖装了没有（记号文件）、两轮的输出。
 * 跑完 `git worktree remove` 掉 relay-run，删临时目录。输出的路径遮掉用户目录。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'ixa-l10-real-'));
const bare = join(root, 'origin.git');
const seed = join(root, 'seed');
const sched = join(root, 'sched');
const integ = join(root, 'integ');
const dev = join(root, 'dev');
const trees = join(root, 'trees');
const dataDir = join(root, 'relay');
const MORNING = '2026-10-22T02:00:00.000Z';

const mask = (s) => {
  let text = String(s);
  for (const p of [root, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    text = text.split(p).join('<临时目录>');
    text = text.split(p.replaceAll('\\', '/')).join('<临时目录>');
    text = text.split(JSON.stringify(p).slice(1, -1)).join('<临时目录>');
  }
  const user = process.env.USERPROFILE ?? '';
  const name = user ? user.split(/[\\/]/).pop() : '';
  return name ? text.split(name).join('<账户名>') : text;
};
const log = (s) => console.log(mask(s));

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};
const tryGit = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

const queueOf = (status) =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    `| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | ${status} |`,
    '',
  ].join('\n');

const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const opt = (n) => argv[argv.indexOf(n) + 1];',
  'const role = opt("--role");',
  'const clone = opt("--clone");',
  'const g = (...a) => {',
  '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
  '};',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'let after;',
  'if (role === "developer") {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 测试待审（整合方） |"), "utf8");',
  '  after = "测试待审（整合方）";',
  '} else {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 测试待审（整合方） |", "| 已完成（2026-10-23） |"), "utf8");',
  '  after = "已完成（2026-10-23）";',
  '}',
  'g("add", "-A");',
  'g("commit", "-q", "-m", "合成：替身改状态");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE 70 " + after);',
  '',
].join('\n');

try {
  // 1) 裸仓库：先推这一支的代码当 main，再叠一个合成队列
  git(root, ['init', '--bare', '-b', 'main', bare]);
  git(REPO, ['push', '--quiet', bare, 'HEAD:main']);
  git(root, ['clone', bare, seed]);
  git(seed, ['config', 'user.email', 'relay@example.invalid']);
  git(seed, ['config', 'user.name', 'relay']);
  mkdirSync(join(seed, 'docs', '委派'), { recursive: true });
  writeFileSync(join(seed, 'docs', '委派', '队列.md'), queueOf('待领'), 'utf8');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', '合成队列']);
  git(seed, ['push', '-q', 'origin', 'HEAD:main']);

  // 2) 调度器所在仓库 + 两个角色的工作目录
  git(root, ['clone', bare, sched]);
  git(root, ['clone', bare, integ]);
  git(root, ['clone', bare, dev]);
  mkdirSync(trees, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd, name) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--role', name, '--clone', cwd],
    cwd,
    timeoutMinutes: 10,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 120,
  });
  const localUserCheck = [process.execPath, '-e', 'process.exit(0)'];
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: { integrator: role(integ, 'integrator'), developer: role(dev, 'developer') },
        idleSeconds: 1,
        localUserCheck,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
    'utf8',
  );

  const mainSha = git(sched, ['rev-parse', 'origin/main']);
  log(`== 甲：真跑看门人（不设 IXAEON_RELAY_CODE）`);
  log(`   合成 origin/main = ${mainSha.slice(0, 12)}（这一支的代码 + 合成队列）`);
  log(`   数据目录、工作目录根都指到临时目录；relay-run 会建在 <临时目录>/trees/relay-run`);

  // 真机上「调度器所在仓库」是装过依赖的；临时克隆要自己装一次（不然 relay.mjs 找不到 jiti）。
  log('   先给调度器所在仓库装依赖（真机上这一步早就做过了）…');
  const installed = spawnSync('corepack pnpm install --frozen-lockfile --prefer-offline', {
    cwd: sched,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
  log(`   装依赖退出码 ${installed.status}`);

  // 3) 真跑：node <sched>/packages/relay/bin/relay.mjs run --exit-when-idle
  const started = Date.now();
  const run = spawn(
    process.execPath,
    [join(sched, 'packages', 'relay', 'bin', 'relay.mjs'), 'run', '--exit-when-idle'],
    {
      cwd: sched,
      env: {
        ...process.env,
        IXAEON_RELAY_DIR: dataDir,
        IXAEON_WORKTREES: trees,
        IXAEON_RELAY_NOW: MORNING,
      },
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  run.stdout.on('data', (d) => (stdout += d.toString('utf8')));
  run.stderr.on('data', (d) => (stderr += d.toString('utf8')));
  const code = await new Promise((r) => run.on('close', r));
  log(`   relay run 退出码 ${code}｜用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

  log('== 看门人输出（原样，遮掉临时目录）');
  for (const line of `${stdout}`.trim().split('\n')) log(`   ${line}`);
  if (stderr.trim()) {
    log('== 错误输出');
    for (const line of stderr.trim().split('\n').slice(0, 40)) log(`   ${line}`);
  }

  // 4) 看：relay-run 建出来了没有、停在哪个提交、依赖装了没有
  const runDir = join(trees, 'relay-run');
  // 整合方补：哪一条不符就记下，最后退出码非零（不在前面不符时还写「通过」）。
  const bad = [];
  if (code !== 0) bad.push(`relay run 退出码 ${code}`);
  log('== 结果');
  log(`   relay-run 建出来了：${existsSync(runDir)}`);
  if (!existsSync(runDir)) bad.push('relay-run 没建出来');
  if (existsSync(runDir)) {
    const head = tryGit(runDir, ['rev-parse', 'HEAD']).out;
    const om = git(sched, ['rev-parse', 'origin/main']);
    const branch = tryGit(runDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
    log(`   relay-run 的 HEAD：${head.slice(0, 12)}`);
    log(`   origin/main：${om.slice(0, 12)}`);
    log(`   在分支上吗：${branch}`);
    if (head !== om) bad.push('relay-run 不在 origin/main');
    if (branch !== 'HEAD') bad.push('relay-run 在分支上');
    const marker = join(runDir, 'node_modules', '.relay-lock-sha256');
    log(
      `   依赖记号文件：${existsSync(marker) ? readFileSync(marker, 'utf8').trim().slice(0, 16) : '没有'}`,
    );
    if (!existsSync(marker)) bad.push('没有依赖记号文件');
    log(`   node_modules 在：${existsSync(join(runDir, 'node_modules'))}`);
  }
  const ledger = join(dataDir, 'ledger.jsonl');
  const rows = existsSync(ledger)
    ? readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  for (const j of rows) {
    log(`   记账：turn=${j.turn} role=${j.role} 行=${j.taskId} → ${j.statusAfter}`);
  }
  if (rows.length !== 2) bad.push(`记账 ${rows.length} 棒，不是 2 棒`);
  const exits = [...stdout.matchAll(/子进程 (\d+) 退出 0/g)].map((m) => m[1]);
  const watcher = /看门人 (\d+)/.exec(stdout)?.[1];
  if (!watcher) bad.push('没有「看门人 <pid>」');
  if (exits.length < 2) bad.push('「子进程 … 退出 0」不到两行');
  if (new Set(exits).size !== exits.length || exits.includes(watcher)) {
    bad.push('子进程号有重复或等于看门人');
  }
  const stopped = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).stoppedReason;
  log(`   state.json 的 stoppedReason：${stopped}`);
  if (stopped) bad.push('停下了');
  const branches = git(bare, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split(
    '\n',
  );
  log(`   合成 origin 的分支：${branches.join('、')}`);

  // 5) 收尾：摘掉 relay-run、删临时目录。刚装过依赖，Windows 上文件可能还被占一会儿——重试几次。
  let removed = tryGit(sched, ['worktree', 'remove', '--force', runDir]);
  for (let i = 0; i < 5 && removed.code !== 0 && existsSync(runDir); i++) {
    await new Promise((r) => setTimeout(r, 800));
    removed = tryGit(sched, ['worktree', 'remove', '--force', runDir]);
  }
  if (removed.code !== 0 && existsSync(runDir)) {
    rmSync(runDir, { recursive: true, force: true });
    tryGit(sched, ['worktree', 'prune']);
    log('   收尾：worktree remove 没成功，已直接删目录并 prune（残留的是临时目录，不影响别的）');
  }
  tryGit(sched, ['worktree', 'prune']);
  log(`   收尾：relay-run ${existsSync(runDir) ? '没摘掉' : '已摘掉'}`);
  rmSync(root, { recursive: true, force: true });
  log(`   收尾：临时目录 ${existsSync(root) ? '没删掉' : '删掉了'}`);
  log(bad.length ? `== 结论：不通过（${bad.join('；')}）` : '== 结论：通过');
  process.exitCode = bad.length ? 1 : 0;
} catch (e) {
  log(`没跑成：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  try {
    tryGit(sched, ['worktree', 'remove', '--force', join(trees, 'relay-run')]);
    tryGit(sched, ['worktree', 'prune']);
  } catch {
    /* 收尾失败不影响结论 */
  }
}
