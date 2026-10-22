/**
 * L2 真机检查「丙」：真的 DSH（DeepSeek Harness）当开发跑一棒（真调用 ≤ 2 次）。
 *
 * 临时裸仓库 + 整合方/开发各一个克隆，合成队列一行「待领」，任务是合成的：
 * 「把这一行的状态改成测试待审（整合方）、提交、推送」。开发用真 DSH，整合方用替身。
 *
 * dsh.cmd 是批处理，Node 不经 shell 起不了：这里写一个小启动器（直接起 DeepSeek Harness.exe、
 * 带 ELECTRON_RUN_AS_NODE=1），当开发角色 argv[0]（照 scripts/real/l0b-dsh-probe.mjs 的 dshBin()）。
 * 接进正式配置是下一单的事，这一单只在真机脚本里用。
 *
 * DSH 默认权限是「目录内可写、要审批时问」：后台没人答，它卡住或者被拒都如实记下来，不改权限设置。
 *   node scripts/real/l2-dsh-turn.mjs                     # 照规格：裸仓库在临时目录里，两个克隆
 *   node scripts/real/l2-dsh-turn.mjs --origin-inside     # 裸仓库放进开发的工作目录（看沙箱内能不能推）
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repo, 'packages', 'relay', 'bin', 'relay.mjs');
const inside = process.argv.includes('--origin-inside');
const work = mkdtempSync(join(tmpdir(), 'ixa-l2-dsh-'));
const mask = (s) => {
  let text = String(s);
  for (const p of [work, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    for (const v of [p, p.replaceAll('\\', '/')]) text = text.split(v).join('<临时目录>');
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args, allowFail = false) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 && !allowFail) {
    throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};

/** dsh 的真入口：`DeepSeek Harness.exe --expose-internals <app.asar 里的 cli.js>`（照 L0b）。 */
function dshBin() {
  const installs = [
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ];
  for (const install of installs) {
    const exe = join(install, 'DeepSeek Harness.exe');
    const cli = join(
      install,
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    );
    if (existsSync(exe) && existsSync(join(install, 'resources', 'app.asar'))) {
      return { exe, cli };
    }
  }
  return null;
}

const dsh = dshBin();
if (!dsh) {
  log('没跑：没找到 DeepSeek Harness 的安装目录');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const TASK = 'L71 把这一行的状态改成测试待审（整合方）、提交、推送';
const QUEUE = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  `| 71 | ${TASK} | [L71](L71.md) | B | 无 | 待领 |`,
  '',
].join('\n');
const AGENTS =
  '# 合成仓库的规矩\n\n这是验证用的合成仓库。照这一棒的交代做：只改队列里那一行，提交、推送。\n';
const configUser = (cwd) => {
  git(cwd, ['config', 'user.email', 'relay@example.invalid']);
  git(cwd, ['config', 'user.name', 'relay']);
};
const writeSeed = (cwd) => {
  mkdirSync(join(cwd, 'docs', '委派'), { recursive: true });
  writeFileSync(join(cwd, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
  writeFileSync(join(cwd, 'AGENTS.md'), AGENTS, 'utf8');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', '初始合成仓库']);
};

const integ = join(work, 'integ');
const dev = join(work, 'dev');
const dataDir = join(work, 'relay');
mkdirSync(dataDir, { recursive: true });

if (inside) {
  // 裸仓库放进开发的工作目录：DSH 的默认沙箱只许写工作目录里面，这样才看得出它能不能推。
  const seed = join(work, 'seed.git');
  git(work, ['init', '--bare', '-b', 'main', seed]);
  git(work, ['clone', seed, dev]);
  configUser(dev);
  writeSeed(dev);
  git(dev, ['push', seed, 'main:main']);
  git(dev, ['init', '--bare', '-b', 'main', '.origin.git']);
  git(dev, ['push', '.origin.git', 'main:main']);
  git(dev, ['remote', 'set-url', 'origin', './.origin.git']);
  appendFileSync(join(dev, '.git', 'info', 'exclude'), '\n.origin.git/\n', 'utf8');
  git(work, ['clone', join(dev, '.origin.git'), integ]);
  configUser(integ);
} else {
  const bare = join(work, 'origin.git');
  git(work, ['init', '--bare', '-b', 'main', bare]);
  git(work, ['clone', bare, integ]);
  configUser(integ);
  writeSeed(integ);
  git(integ, ['push', 'origin', 'HEAD:main']);
  git(work, ['clone', bare, dev]);
  configUser(dev);
}

/** 启动器：Node 直接起 DeepSeek Harness.exe，带 ELECTRON_RUN_AS_NODE=1（dsh.cmd 的原文做法）。 */
const launcher = join(work, 'dsh-launcher.mjs');
writeFileSync(
  launcher,
  [
    "import { spawn } from 'node:child_process';",
    'const [exe, cli, ...rest] = process.argv.slice(2);',
    "const child = spawn(exe, ['--expose-internals', cli, ...rest], {",
    '  stdio: "inherit",',
    '  windowsHide: true,',
    '  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },',
    '});',
    'child.on("error", (e) => { console.error(String(e)); process.exit(1); });',
    'child.on("close", (c) => process.exit(c ?? 1));',
    '',
  ].join('\n'),
  'utf8',
);

/** 整合方替身：这一棒轮不到它。 */
const stub = join(work, 'stub-role.mjs');
writeFileSync(stub, 'console.log("RELAY-DONE 71 待领");\n', 'utf8');

const quotaPatterns = ['usage_limit_reached', 'session limit'];
writeFileSync(
  join(dataDir, 'config.json'),
  `${JSON.stringify(
    {
      roles: {
        integrator: {
          argv: [process.execPath, stub, '{prompt_file}'],
          cwd: integ,
          timeoutMinutes: 5,
          quotaPatterns: [],
          quotaPauseMinutes: 10,
        },
        developer: {
          argv: [
            process.execPath,
            launcher,
            dsh.exe,
            dsh.cli,
            '--profile',
            'headless',
            '--json',
            '读 {prompt_file}，照里面做。',
          ],
          cwd: dev,
          timeoutMinutes: 10,
          quotaPatterns,
          quotaPauseMinutes: 120,
        },
      },
      idleSeconds: 5,
      localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
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

const repoDirtyBefore = spawnSync('git', ['status', '--porcelain'], {
  cwd: repo,
  encoding: 'utf8',
}).stdout;

log(
  `== 丙：真 DSH 当开发跑一棒｜${inside ? '裸仓库在开发的工作目录里' : '照规格：裸仓库在临时目录里'}`,
);
const relayEnv = {
  ...process.env,
  IXAEON_RELAY_DIR: dataDir,
  IXAEON_RELAY_NOW: '2026-10-22T02:00:00.000Z',
};
delete relayEnv.ELECTRON_RUN_AS_NODE; // 宿主带进来的这个会让 Electron 当普通 node 跑
const r = spawnSync(process.execPath, [CLI, 'once'], {
  cwd: repo,
  encoding: 'utf8',
  env: relayEnv,
  windowsHide: true,
  timeout: 900_000,
});
log(`   relay once 退出码 ${r.status}`);
log(mask((r.stdout ?? '').trim()));
if ((r.stderr ?? '').trim()) log(`   stderr：${mask((r.stderr ?? '').trim()).slice(0, 600)}`);

let passed = true;
const check = (ok, what) => {
  log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) passed = false;
};

const ledgerPath = join(dataDir, 'ledger.jsonl');
const rows = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const row = rows[0];
log(`   记账：${row ? mask(JSON.stringify(row)) : '(没有)'}`);

const stdoutPath = join(dataDir, 'turns', '1', 'stdout.txt');
if (existsSync(stdoutPath)) {
  const raw = readFileSync(stdoutPath, 'utf8');
  const finals = raw
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((j) => j && j.type === 'final');
  const last = String(finals.at(-1)?.text ?? raw);
  log(`   DSH 的 final 行 ${finals.length} 条；最后一条（截 600 字）：${mask(last).slice(0, 600)}`);
  if (row?.quotaHit) {
    const hit = quotaPatterns.find((p) => raw.toLowerCase().includes(p.toLowerCase()));
    log(`   撞额度的字样：${hit ?? '(没找到，可能是别的字段)'}`);
  }
}

const mainQueue = git(integ, ['show', 'origin/main:docs/委派/队列.md'], true);
const status = /^\|\s*71\s*\|.*\|\s*([^|]+?)\s*\|\s*$/m.exec(mainQueue)?.[1] ?? '';
log(`   origin/main 上这一行现在是：${status || '(读不到)'}`);

check(status.startsWith('测试待审'), 'origin/main 上这一行变成了测试待审（整合方）');
check(!!row, '记了一行账');
check(
  !!row && String(row.doneLine ?? '').startsWith('RELAY-DONE 71'),
  'doneLine 从 final.text 里认出来了',
);
check(rows.length === 1 && row?.violations?.length === 0 && !row?.timedOut, '这一棒没越界、没超时');

const repoDirtyAfter = spawnSync('git', ['status', '--porcelain'], {
  cwd: repo,
  encoding: 'utf8',
}).stdout;
check(repoDirtyBefore === repoDirtyAfter, '仓库（临时目录以外）什么都没写');
check(git(dev, ['status', '--porcelain']) === '', '开发克隆的工作区是干净的');

log(passed ? 'RESULT 通过' : 'RESULT 没通过');
rmSync(work, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
