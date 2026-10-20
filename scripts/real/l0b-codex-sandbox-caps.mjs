/**
 * L0b「丁-3」：提权之后，补 D2c 的问题 3、4、5、8——
 * 沙箱里跑不跑得起一个合成 vitest、联网挡不挡得住、往副本外 / 经目录链接往真实依赖写挡不挡得住、沙箱里外用时差多少。
 *
 * 前置：`l0b-codex-elevate.mjs` 已经对同一个 CODEX_HOME 跑过一次提权 setup（本脚本**不提权、不弹 UAC**）。
 * 不调模型：只跑 `codex sandbox … -- node <探测脚本>`，沙箱命令不算额度。
 * 全在 %TEMP% 以外的一次性目录里跑；输出遮掉临时目录、用户目录与账户名。
 *
 *   node scripts/real/l0b-codex-sandbox-caps.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
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

const here = dirname(fileURLToPath(import.meta.url));
/** 本工作目录的 node_modules：经目录链接给合成项目用（照 D2 的做法）。 */
const repoNodeModules = resolve(here, '..', '..', 'node_modules');

function findLatestCodex() {
  const binRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const exes = [];
  for (const name of readdirSync(binRoot)) {
    const p = join(binRoot, name);
    if (name.toLowerCase() === 'codex.exe') exes.push(p);
    else {
      try {
        if (readdirSync(p).includes('codex.exe')) exes.push(join(p, 'codex.exe'));
      } catch {
        /* 不是目录 */
      }
    }
  }
  const withVersion = exes.map((p) => {
    const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
    return { p, v: m ? m[1] : '0.0.0' };
  });
  withVersion.sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
  return { exe: withVersion.at(-1).p, version: withVersion.at(-1).v };
}

const scratch = join(homedir(), 'ixa-l0b-scratch');
const home = join(scratch, 'home-A');
const copy = join(scratch, 'caps-copy');
const outside = join(scratch, 'caps-outside');
for (const d of [copy, outside]) mkdirSync(d, { recursive: true });

const copyFwd = copy.replaceAll('\\', '/');
writeFileSync(
  join(home, 'config.toml'),
  [
    '[permissions.ixaeon]',
    '[permissions.ixaeon.workspace_roots]',
    `"${copyFwd}" = true`,
    '[permissions.ixaeon.filesystem]',
    '":root" = "read"',
    `"${copyFwd}/**" = "write"`,
    '[permissions.ixaeon.network]',
    'enabled = false',
    '[shell_environment_policy]',
    'inherit = "all"',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n'),
  'utf8',
);

// 合成项目：一个 vitest 测试 + 一个探测脚本 + 只读的目录链接
writeFileSync(
  join(copy, 'package.json'),
  '{\n  "name": "l0b-caps",\n  "type": "module"\n}\n',
  'utf8',
);
writeFileSync(
  join(copy, 'synth.test.js'),
  [
    "import { expect, test } from 'vitest';",
    "test('合成用例：2+2', () => {",
    '  expect(2 + 2).toBe(4);',
    '});',
    '',
  ].join('\n'),
  'utf8',
);
const junction = join(copy, 'node_modules');
if (!existsSync(junction)) symlinkSync(repoNodeModules, junction, 'junction');

writeFileSync(
  join(copy, 'probe.mjs'),
  `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
mkdirSync(join(process.argv[4], 'tmp'), { recursive: true });

const outsideDir = process.argv[2];
const localPort = Number(process.argv[3]);
const outsideMode = process.argv.includes('--outside');
const tag = outsideMode ? '外面' : '沙箱里';
const say = (s) => console.log('[' + tag + '] ' + s);

const tryWrite = (label, p) => {
  try {
    writeFileSync(p, 'l0b-probe ' + tag + '\\n', 'utf8');
    say(label + '：写成了 → ' + p);
  } catch (e) {
    say(label + '：被拒（' + (e.code || e.message) + '）');
  }
};

tryWrite('副本里写文件（应当成）', join(process.argv[4], outsideMode ? 'inside-outside.txt' : 'inside.txt'));
tryWrite('往副本外写文件', join(outsideDir, outsideMode ? 'hit-outside.txt' : 'hit.txt'));
if (!outsideMode) tryWrite('经目录链接往真实依赖写', join(process.argv[4], 'node_modules', '__l0b_probe.txt'));

const tryConnect = (label, host, port) =>
  new Promise((r) => {
    const s = connect({ host, port });
    const t = setTimeout(() => { say(label + '：连不上（超时）'); s.destroy(); r(); }, 3000);
    s.on('connect', () => { clearTimeout(t); say(label + '：连上了'); s.destroy(); r(); });
    s.on('error', (e) => { clearTimeout(t); say(label + '：被拒（' + (e.code || e.message) + '）'); r(); });
  });

await tryConnect('连本机端口 ' + localPort, '127.0.0.1', localPort);
await tryConnect('连外网 1.1.1.1:443', '1.1.1.1', 443);

const t0 = Date.now();
let acc = 0;
for (let i = 0; i < 6_000_000; i++) acc += (i * 31) % 7;
say('固定 CPU 活（600 万次循环）：' + (Date.now() - t0) + 'ms（acc=' + (acc > 0) + '）');

const v = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'], {
  cwd: process.argv[4],
  encoding: 'utf8',
  timeout: 120000,
  // vite 默认往系统临时目录里建东西；沙箱只许写副本，所以把临时目录也指到副本里（第一次试过不指，EPERM）
  env: { ...process.env, TEMP: join(process.argv[4], 'tmp'), TMP: join(process.argv[4], 'tmp') },
});
say('跑 vitest 的退出码：' + v.status);
const lines = ((v.stdout || '') + (v.stderr || '')).split('\\n').map((l) => l.trim()).filter(Boolean);
for (const l of lines.slice(-8)) say('  vitest｜' + l);
`,
  'utf8',
);

const codex = findLatestCodex();
const local = createServer((s) => s.end('l0b'));
await new Promise((r) => local.listen(0, '127.0.0.1', r));
const port = local.address().port;
console.log(`== 探测环境`);
console.log(`   codex ${codex.version}｜合成项目副本：${copy}`);
console.log(`   目录链接：copy/node_modules → 本工作目录的 node_modules（${repoNodeModules}）`);
console.log(`   本机监听端口（只在外面听，用来试沙箱能不能连进来）：${port}`);

console.log(`== A) 沙箱里跑（带提权设置，不提权、不弹 UAC、不调模型）`);
const t0 = Date.now();
const ins = spawnSync(
  codex.exe,
  [
    '-c',
    'windows.sandbox="elevated"',
    'sandbox',
    '-P',
    'ixaeon',
    '-C',
    copy,
    '--',
    'node',
    join(copy, 'probe.mjs'),
    outside,
    String(port),
    copy,
  ],
  {
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: home },
  },
);
const inSeconds = Number(((Date.now() - t0) / 1000).toFixed(2));
console.log(
  `   exit=${ins.status}${ins.status === null ? '（超时被杀）' : ''}｜整条命令用时 ${inSeconds}s`,
);
for (const l of mask(`${ins.stdout ?? ''}${ins.stderr ?? ''}`)
  .split('\n')
  .map((l) => l.trimEnd())) {
  if (l.trim()) console.log(`   ${l}`);
}

console.log(`== B) 同样的脚本在沙箱外跑一遍（对照）`);
const t1 = Date.now();
const outs = spawnSync(
  process.execPath,
  [join(copy, 'probe.mjs'), outside, String(port), copy, '--outside'],
  {
    encoding: 'utf8',
    timeout: 300_000,
    cwd: copy,
  },
);
const outSeconds = Number(((Date.now() - t1) / 1000).toFixed(2));
console.log(`   exit=${outs.status}｜整条命令用时 ${outSeconds}s`);
for (const l of mask(`${outs.stdout ?? ''}${outs.stderr ?? ''}`)
  .split('\n')
  .map((l) => l.trimEnd())) {
  if (l.trim()) console.log(`   ${l}`);
}

console.log(`== C) 落盘取证（沙箱里那次写没写出来）`);
for (const p of [
  join(copy, 'inside.txt'),
  join(outside, 'hit.txt'),
  join(repoNodeModules, '__l0b_probe.txt'),
  join(copy, 'inside-outside.txt'),
  join(outside, 'hit-outside.txt'),
]) {
  let info = '不存在';
  if (existsSync(p)) {
    const st = statSync(p);
    info = `存在（${st.size} bytes）`;
  }
  console.log(`   ${info}｜${p}`);
}
rmSync(join(repoNodeModules, '__l0b_probe.txt'), { force: true });

console.log(`== D) 小结`);
const vitestExit = (text) => (text.match(/跑 vitest 的退出码：(-?\d+)/) ?? [])[1] ?? '(没跑到)';
console.log(
  `   沙箱里那次：exit=${ins.status}、用时 ${inSeconds}s，其中 vitest 退出码 ${vitestExit(ins.stdout ?? '')}`,
);
console.log(
  `   沙箱外那次：exit=${outs.status}、用时 ${outSeconds}s，其中 vitest 退出码 ${vitestExit(outs.stdout ?? '')}`,
);
local.close();
process.exit(ins.status === 0 ? 0 : 1);
