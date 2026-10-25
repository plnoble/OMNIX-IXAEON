/**
 * L11 真机检查甲（规格 docs/委派/L11-两条道同时跑.md「真机检查·甲」）：
 * 不设 IXAEON_RELAY_CODE，真跑一次 `lanes: 2` 的看门人——真 fetch 共用检出的 origin/main、
 * 真建两份代码目录（relay-run-developer / relay-run-integrator，在临时工作目录根里）、
 * 真装依赖；队列和角色全是合成的（origin 是临时裸仓库，不碰真 GitHub、不调真模型）。
 *
 * 核对：两份代码目录都建出来了、停在 main 的提交上；两条道各跑了棒、时间重叠；
 * 合成 origin 上的提交作者是 dev / relay-integrator（gitIdentity 生效）。
 * 跑完摘掉两份代码目录、删临时目录；打印遮掉用户目录。RESULT 与退出码一致，出错非零。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'ixa-l11-real-'));
const masks = [homedir(), work];
const mask = (s) =>
  masks.reduce((acc, m) => acc.split(m).join(m === homedir() ? '<本机>' : '<临时>'), String(s));
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

let passed = false;
let result = '没通过：脚本没跑到结论';
try {
  const origin = join(work, 'origin.git');
  const integ = join(work, 'integ');
  const dev = join(work, 'dev');
  const dataDir = join(work, 'relay');
  const trees = join(work, 'trees');
  mkdirSync(dataDir, { recursive: true });
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
    return (r.stdout ?? '').trim();
  };
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { windowsHide: true });
  spawnSync('git', ['clone', '-q', origin, integ], { windowsHide: true });
  g(integ, 'config', 'user.email', 'relay@example.invalid');
  g(integ, 'config', 'user.name', 'relay');
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(
    join(integ, 'docs', '委派', '队列.md'),
    [
      '# 委派队列',
      '',
      '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
      '| ---- | ---- | ------------ | ---- | ---- | ---- |',
      '| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | 待领 |',
      '| 71 | L9 合成的另一行 | [L9](L9.md) | B | 无 | 测试待审（整合方） |',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(integ, 'docs', '委派', '锁定验收.json'), '{"tasks":[]}\n', 'utf8');
  g(integ, 'add', '-A');
  g(integ, 'commit', '-q', '-m', '初始合成仓库');
  g(integ, 'push', '-q', 'origin', 'HEAD:main');
  spawnSync('git', ['clone', '-q', origin, dev], { windowsHide: true });
  g(dev, 'config', 'user.email', 'relay@example.invalid');
  g(dev, 'config', 'user.name', 'relay');

  // 替身角色：照 l11-lanes.test.ts 那个不撞车的写法（fetch+reset 重打底子再改）
  const stub = join(work, 'stub-role.mjs');
  writeFileSync(
    stub,
    [
      "import { spawnSync } from 'node:child_process';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'const opt = (n) => argv[argv.indexOf(n) + 1];',
      'const role = opt("--role-tag");',
      'const clone = opt("--clone");',
      'const g = (...a) => {',
      '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
      '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
      '};',
      'const fresh = () => { g("fetch", "-q", "origin"); g("reset", "-q", "--hard", "origin/main"); };',
      'const q = clone + "/docs/委派/队列.md";',
      '// 开发：把第 70 行（待领）改成测试待审。整合方：把第一条「测试待审」行改成已完成（哪行都办，别空转）。',
      'const editDev = () => {',
      '  const lines = readFileSync(q, "utf8").split("\\n");',
      '  const i = lines.findIndex((l) => l.startsWith("| 70 |") && l.includes("| 待领 |"));',
      '  if (i < 0) return false;',
      '  lines[i] = lines[i].replace("| 待领 |", "| 测试待审（整合方） |");',
      '  writeFileSync(q, lines.join("\\n"), "utf8");',
      '  return true;',
      '};',
      'const editInt = () => {',
      '  const lines = readFileSync(q, "utf8").split("\\n");',
      '  const i = lines.findIndex((l) => l.includes("| 测试待审（整合方） |"));',
      '  if (i < 0) return false;',
      '  lines[i] = lines[i].replace("| 测试待审（整合方） |", "| 已完成（2026-10-25） |");',
      '  writeFileSync(q, lines.join("\\n"), "utf8");',
      '  return true;',
      '};',
      'const changed = role === "developer" ? editDev() : editInt();',
      'if (!changed) { console.log("RELAY-DONE 没得改"); process.exit(0); }',
      '// 整合方先睡 6 秒：开发那棒必须在这 6 秒里也在跑，才看得出重叠',
      'if (role !== "developer") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);',
      'const apply = () => { const c = role === "developer" ? editDev() : editInt(); if (!c) return false; g("add", "-A"); g("commit", "-q", "-m", "合成：替身改状态"); return true; };',
      'fresh(); apply();',
      'let ok = false;',
      'for (let i = 0; i < 3; i++) {',
      '  const pr = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: clone, encoding: "utf8" });',
      '  if (pr.status === 0) { ok = true; break; }',
      '  fresh(); if (!apply()) break;',
      '}',
      'if (!ok) { console.error("替身：推了三次都没推上"); process.exit(1); }',
      'console.log("RELAY-DONE 改了一行");',
      '',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          integrator: {
            argv: [
              process.execPath,
              stub,
              '{prompt_file}',
              '--role-tag',
              'integrator',
              '--clone',
              integ,
            ],
            cwd: integ,
            timeoutMinutes: 5,
            quotaPatterns: ['usage_limit_reached'],
            quotaPauseMinutes: 120,
            gitIdentity: { name: 'relay-integrator', email: 'integrator@ixaeon.local' },
          },
          developer: {
            argv: [
              process.execPath,
              stub,
              '{prompt_file}',
              '--role-tag',
              'developer',
              '--clone',
              dev,
            ],
            cwd: dev,
            timeoutMinutes: 5,
            quotaPatterns: ['usage_limit_reached'],
            quotaPauseMinutes: 120,
            gitIdentity: { name: 'dev', email: 'dev@ixaeon.local' },
          },
        },
        idleSeconds: 2,
        lanes: 2,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 })}\n`,
    'utf8',
  );

  log('== 起看门人（lanes: 2，真 fetch、真建两份代码目录、真装依赖，队列是合成的）');
  const p = spawn(
    process.execPath,
    [join(REPO, 'packages', 'relay', 'bin', 'relay.mjs'), 'run', '--exit-when-idle'],
    {
      cwd: REPO,
      env: { ...process.env, IXAEON_RELAY_DIR: dataDir, IXAEON_WORKTREES: trees },
      windowsHide: true,
    },
  );
  let out = '';
  p.stdout.on('data', (d) => (out += d.toString('utf8')));
  p.stderr.on('data', (d) => (out += d.toString('utf8')));
  const code = await new Promise((done) => {
    const t = setTimeout(() => p.kill(), 420_000);
    p.on('close', (c) => {
      clearTimeout(t);
      done(c);
    });
  });
  for (const line of out.split('\n').filter((l) => /棒|子进程|看门人|没活/.test(l)))
    log(`   ${line}`);
  if (code !== 0) throw new Error(`看门人退出码 ${code}`);

  const runDev = join(trees, 'relay-run-developer');
  const runInt = join(trees, 'relay-run-integrator');
  log('== 两份代码目录 ==');
  for (const [name, dir] of [
    ['relay-run-developer', runDev],
    ['relay-run-integrator', runInt],
  ]) {
    const there = existsSync(join(dir, 'packages', 'relay', 'bin', 'relay.mjs'));
    const at = there ? g(dir, 'rev-parse', '--short', 'HEAD') : '（没建出来）';
    log(`   ${name}：${there ? '建出来了' : '没建出来'}，停在 ${at}`);
    if (!there) throw new Error(`${name} 没建出来`);
  }
  const ledger = readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  log('== 两条道各跑的棒 ==');
  for (const row of ledger) {
    log(
      `   第 ${row.turn} 棒 ${row.role} ${row.startedAt} → ${row.endedAt}（行 ${row.taskId} → ${row.statusAfter}）`,
    );
  }
  const devRow = ledger.find((r) => r.role === 'developer');
  const intRow = ledger.find((r) => r.role === 'integrator');
  if (!devRow || !intRow) throw new Error('两条道没有都跑了棒');
  if (!(Date.parse(intRow.startedAt) < Date.parse(devRow.endedAt))) {
    throw new Error('两条道没有重叠（整合方开始晚于开发结束）');
  }
  log('== 合成 origin 上的提交作者 ==');
  const authors = g(integ, 'log', '--format=%an <%ae>', 'origin/main').split('\n');
  for (const a of [...new Set(authors)]) log(`   ${a}`);
  if (!authors.some((a) => a.includes('dev@ixaeon.local'))) throw new Error('没有 dev 署名的提交');
  if (!authors.some((a) => a.includes('integrator@ixaeon.local'))) {
    throw new Error('没有 relay-integrator 署名的提交');
  }
  passed = true;
  result = `通过：两份代码目录都建出来了（停在 main 上）；两条道各跑了棒且时间重叠（整合方 ${intRow.startedAt} 早于开发结束 ${devRow.endedAt}）；合成 origin 上有 dev 和 relay-integrator 两个署名的提交`;
} catch (err) {
  passed = false;
  result = `没通过：${err instanceof Error ? err.message : String(err)}`;
} finally {
  // 摘掉两份代码目录、删临时目录（各试几回，Windows 上文件句柄放手慢）
  const trees = join(work, 'trees');
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(trees, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
log('RESULT', result);
process.exitCode = passed ? 0 : 1;
