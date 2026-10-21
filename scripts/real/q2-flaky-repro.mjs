/**
 * Q2 偶发失败的复现 / 复测脚本（真机）。做四件事，全部可复现：
 *   1. 把 Electron 二进制**藏起来**（`path.txt` / `dist` 改名成 `.q2bak`）——复现「二进制不在」这个条件；
 *   2. 起 **限时的占 CPU 进程**（默认 20 个、150 秒后自己退出，跑完一律杀掉）——复现「机器忙」；
 *   3. 把下载镜像指到不可达地址（`ELECTRON_MIRROR=http://127.0.0.1:9/`）——复现「装不成」；
 *   4. 按场景**连跑 N 遍**，每遍打印退出码、用时和结果行（原样，只遮临时目录与账户名）。
 *
 * 收尾一律还原：二进制、`--baseline` 临时换回的那一版文件、占 CPU 的进程。跑完会打印最终状态。
 *
 *   node scripts/real/q2-flaky-repro.mjs --restore-only
 *   node scripts/real/q2-flaky-repro.mjs --scenario bui01 --runs 3 --load 20 --binary hidden --expect pass
 *   node scripts/real/q2-flaky-repro.mjs --scenario integration --runs 2 --load 20 --binary hidden --mirror broken --baseline --expect fail
 *   node scripts/real/q2-flaky-repro.mjs --scenario integration --runs 2 --load 20 --binary hidden --mirror broken --expect pass
 *   node scripts/real/q2-flaky-repro.mjs --scenario d3d4 --runs 3
 *   node scripts/real/q2-flaky-repro.mjs --scenario b04 --runs 10
 *
 * 不用任何「跳过所有权限」的开关；不调模型；不碰用户的真实数据（测试自己用临时数据目录）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mask = (s) => {
  let text = String(s);
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
  ].filter((x) => x && x.trim())) {
    for (const variant of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(variant).join('<本机>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const scenario = arg('scenario', 'd3d4');
const runs = Number(arg('runs', '1'));
const load = Number(arg('load', '0'));
const loadSeconds = Number(arg('load-seconds', '150'));
const binary = arg('binary', 'keep'); // keep | hidden
const mirror = arg('mirror', 'ok'); // ok | broken
const baseline = flag('baseline');
const expect = arg('expect', 'any'); // pass | fail | any

/** electron 包的虚拟 store 目录（本工作目录里那个）。 */
function electronDir() {
  const pnpm = join(repo, 'node_modules', '.pnpm');
  const dirs = readdirSync(pnpm).filter((n) => /^electron@/.test(n));
  if (!dirs.length) throw new Error('找不到 node_modules/.pnpm/electron@*');
  return join(pnpm, dirs[0], 'node_modules', 'electron');
}

const el = electronDir();
const bak = { path: join(el, 'path.txt.q2bak'), dist: join(el, 'dist.q2bak') };

/** 只动**这一次真的藏起来过**的东西：没藏过就什么都不做，绝不删已经装好的二进制。
 *  第一遍把原来的 path.txt/dist 挪成备份；之后每一遍都把上一遍现场装出来的丢掉，
 *  让每一遍都真的从「二进制不在」开始。 */
let backupTaken = false;
function hideBinary() {
  if (backupTaken) {
    if (existsSync(join(el, 'path.txt'))) rmSync(join(el, 'path.txt'), { force: true });
    if (existsSync(join(el, 'dist'))) rmSync(join(el, 'dist'), { recursive: true, force: true });
    return;
  }
  // 上一次崩掉留下的备份先收拾：活的那个不在就把备份放回去，活的那个在就把过期备份删掉
  for (const [live, back] of [
    [join(el, 'path.txt'), bak.path],
    [join(el, 'dist'), bak.dist],
  ]) {
    if (!existsSync(back)) continue;
    if (existsSync(live)) rmSync(back, { recursive: true, force: true });
    else renameSync(back, live);
  }
  const renameWithRetry = (from, to) => {
    let last;
    for (let i = 0; i < 6; i++) {
      try {
        renameSync(from, to);
        return;
      } catch (e) {
        last = e;
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { timeout: 2000 });
      }
    }
    throw new Error(
      `改不了名 ${from} → ${to}：${last?.code || last?.message}（有进程还捏着它？先跑 --restore-only）`,
    );
  };
  if (existsSync(join(el, 'path.txt'))) renameWithRetry(join(el, 'path.txt'), bak.path);
  if (existsSync(join(el, 'dist'))) renameWithRetry(join(el, 'dist'), bak.dist);
  backupTaken = true;
}
function restoreBinary() {
  if (!backupTaken) {
    console.log('   （这一次没有藏过二进制，什么都不动）');
    return;
  }
  // 现场装出来的那些先清掉，再把备份放回去（备份在才动）。
  // 刚跑完的进程/杀毒有时还捏着 dist：重试几次，真删不掉就如实报出来、不装作收干净了。
  const rm = (p, opts) => {
    try {
      rmSync(p, { force: true, maxRetries: 8, retryDelay: 250, ...opts });
    } catch (e) {
      console.log(`   ⚠ 收尾没能删掉 ${p}：${e.code || e.message}（下次跑 --restore-only 再收）`);
    }
  };
  if (existsSync(join(el, 'path.txt'))) rm(join(el, 'path.txt'), {});
  if (existsSync(join(el, 'dist'))) rm(join(el, 'dist'), { recursive: true });
  if (existsSync(bak.path)) renameSync(bak.path, join(el, 'path.txt'));
  if (existsSync(bak.dist)) renameSync(bak.dist, join(el, 'dist'));
  backupTaken = false;
}
const binaryState = () =>
  `path.txt=${existsSync(join(el, 'path.txt'))} dist=${existsSync(join(el, 'dist', 'electron.exe'))}`;

const integrationFile = 'apps/desktop/test/integration/d3-d4-conversation-context.test.ts';
const git = (args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
};

const COMMANDS = {
  bui01: [
    process.execPath,
    [
      'apps/desktop/node_modules/playwright/cli.js',
      'test',
      '-c',
      'apps/desktop/test/review/playwright.recheck-20260907.config.ts',
      '-g',
      'BUI01',
    ],
  ],
  integration: [
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', integrationFile],
  ],
  d3d4: [
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project',
      'acceptance',
      'apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts',
      'apps/desktop/test/acceptance/d4-landing-report.test.ts',
    ],
  ],
  b04: [
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'apps/desktop/test/review/vitest.recheck-20260907.config.ts',
      '-t',
      'B04',
    ],
  ],
};

const RESULT_LINE =
  /Tests {2}|Test Files {2}|^ *ok \d|^ *\d+ passed|^ *\d+ failed|Electron failed to install correctly|timed out|Timeout|❯ /;

if (flag('restore-only')) {
  // 上一次跑到一半留下的备份也收掉（手动收尾用）
  backupTaken = existsSync(bak.path) || existsSync(bak.dist);
  restoreBinary();
  console.log(`还原完成：${mask(binaryState())}`);
  process.exit(0);
}
if (!COMMANDS[scenario]) throw new Error(`不认识的 scenario：${scenario}`);

const hogs = [];
const runOne = (label) => {
  // 每遍开跑前重新把二进制藏起来：这样每一遍都是**冷**的「二进制不在」，
  // 不会出现「第一遍装好了、后两遍其实是热的」这种假证据。
  if (binary === 'hidden') hideBinary();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (mirror === 'broken') env.ELECTRON_MIRROR = 'http://127.0.0.1:9/';
  const t0 = Date.now();
  const r = spawnSync(COMMANDS[scenario][0], COMMANDS[scenario][1], {
    cwd: repo,
    encoding: 'utf8',
    env,
    timeout: 600_000,
    windowsHide: true,
  });
  const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const text = mask(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => RESULT_LINE.test(l))
    .slice(0, 4);
  console.log(
    `--- ${label}：exit=${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`,
  );
  for (const l of lines.length ? lines : ['(没有可摘的结果行)']) console.log(`      ${l}`);
  return r.status;
};

console.log(
  `== 场景 ${scenario}｜跑 ${runs} 遍｜机器忙：${load ? `${load} 个占 CPU 进程（${loadSeconds}s 上限）` : '不加'}｜二进制：${binary}｜镜像：${mirror}｜基线：${baseline ? '是' : '否'}`,
);
console.log(`   仓库：${mask(repo)}｜electron 包：${mask(el)}｜跑之前 ${mask(binaryState())}`);

const codes = [];
try {
  // --baseline 要临时换回 origin/main 那一版文件：先确认那个文件没有被别的改动动过，
  // 免得把未提交的改动覆盖掉（规格也要求保留他人的未提交改动）。
  if (baseline) {
    const dirty = spawnSync('git', ['status', '--porcelain', '--', integrationFile], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    if ((dirty.stdout ?? '').trim()) {
      throw new Error(
        `${integrationFile} 有未提交的改动，--baseline 会覆盖它，拒绝执行：${dirty.stdout.trim()}`,
      );
    }
    git(['checkout', 'origin/main', '--', integrationFile]);
    console.log('   已把 integration 的文件临时换回 origin/main 那一版（治之前）');
  }
  for (let i = 0; i < load; i++) {
    const js = `const t=Date.now(); while(Date.now()-t < ${loadSeconds * 1000}){ Math.sqrt(Math.random()) }`;
    hogs.push(
      spawn(process.execPath, ['-e', js], { stdio: 'ignore', windowsHide: true, detached: false }),
    );
  }
  if (load) {
    await new Promise((r) => setTimeout(r, 4000));
    console.log(`   占 CPU 的进程已起 ${hogs.length} 个`);
  }
  for (let i = 1; i <= runs; i++) codes.push(runOne(`第 ${i} 遍`));
} finally {
  for (const h of hogs) {
    try {
      h.kill();
    } catch {
      /* 已经退了 */
    }
  }
  if (baseline) git(['checkout', 'HEAD', '--', integrationFile]);
  restoreBinary();
  console.log(
    `   收尾：占 CPU 的进程已停${baseline ? '、文件已还原' : ''}、二进制已还原 → ${mask(binaryState())}`,
  );
}

const ok = codes.filter((c) => c === 0).length;
const failed = codes.length - ok;
console.log(`== 小结：${ok} 遍成功 / ${failed} 遍失败（共 ${codes.length} 遍）`);
if (expect === 'pass' && failed) process.exit(1);
if (expect === 'fail' && ok) process.exit(1);
process.exit(0);
