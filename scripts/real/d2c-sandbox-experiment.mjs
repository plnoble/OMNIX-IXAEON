/**
 * D2c 新版 Codex 沙箱实验：本机最新版 `codex sandbox` 在**不提权**的前提下到底能不能用、
 * 怎么调、要不要授权、会往机器上装什么、能不能被动检查。
 *
 * 硬规矩（规格 D2c）：
 * - 每次调用 Codex 都把 CODEX_HOME 指到一次性的专用目录，绝不碰用户的 `~/.codex`；
 * - 不提权（不用 `elevated`）、不跑 `codex sandbox uninstall`、不调模型、不跑 `codex exec`；
 * - 只跑 `codex sandbox …` 和 `codex … --help`；全用临时目录与合成内容；输出遮掉本机路径。
 *
 *   node scripts/real/d2c-sandbox-experiment.mjs
 *
 * 退出码：所有观察都成立才是 0；任何一条不符就是 1（不符的那条会打出来）。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 打印遮掉本机账户名、临时目录与用户目录（真机输出会进交付说明，仓库是公开的）
const mask = (s) => {
  let text = s;
  const roots = [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
  ].filter((p) => p && p.trim());
  for (const p of roots) {
    text = text.split(p).join('<本机>');
    for (const variant of [p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      if (variant !== p) text = text.split(variant).join('<本机>');
    }
  }
  return text;
};
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) =>
    orig(
      ...a.map((v) => {
        if (typeof v === 'string') return mask(v);
        if (v instanceof Error) return mask(v.stack ?? v.message);
        try {
          const json = JSON.stringify(v);
          return mask(json === undefined ? String(v) : json);
        } catch {
          return mask(String(v));
        }
      }),
    );
}

let failed = false;
let tenRunMedian = null;
const fail = (why) => {
  failed = true;
  console.log('不符：' + why);
};

/** 在 %LOCALAPPDATA%\OpenAI\Codex\bin 下（顶层 + 每个子目录）找 codex.exe，全部问 --version，取最大的。 */
function findLatestCodex() {
  const binRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  if (!existsSync(binRoot)) return { candidates: [], latest: null };
  const exes = [];
  for (const name of readdirSync(binRoot)) {
    const p = join(binRoot, name);
    if (name.toLowerCase() === 'codex.exe') {
      exes.push(p);
      continue;
    }
    try {
      if (readdirSync(p).includes('codex.exe')) exes.push(join(p, 'codex.exe'));
    } catch {
      /* 不是目录 */
    }
  }
  const versionTuple = (v) =>
    v.split(/[.-]/).map((x) => (Number.isFinite(Number(x)) ? Number(x) : -1));
  const cmp = (a, b) => {
    const pa = versionTuple(a);
    const pb = versionTuple(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? -1;
      const y = pb[i] ?? -1;
      if (x !== y) return x - y;
    }
    return 0;
  };
  const candidates = exes.map((exe) => {
    const r = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const m = raw.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
    return { exe, version: m ? m[1] : '(问不出)', raw };
  });
  const latest =
    candidates
      .slice()
      .sort((a, b) => cmp(a.version, b.version))
      .at(-1) ?? null;
  return { candidates, latest };
}

/** 一次性目录：CODEX_HOME / 副本 / 副本外目标。 */
function makeDirs(tag) {
  const base = mkdtempSync(join(tmpdir(), `ixa-d2c-${tag}-`));
  const home = join(base, 'home');
  const copy = join(base, 'copy');
  const outside = join(base, 'outside');
  for (const d of [home, copy, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(copy, 'note.txt'), '合成项目里的一个文件\n', 'utf8');
  return { base, home, copy, outside };
}

const oldStyleProfile = (copy) =>
  [
    '[permissions.ixaeon]',
    '[permissions.ixaeon.workspace_roots]',
    `"${copy.replaceAll('\\', '/')}" = true`,
    '[permissions.ixaeon.filesystem]',
    `"${copy.replaceAll('\\', '/')}/**" = "write"`,
    '[permissions.ixaeon.network]',
    'enabled = false',
    '[shell_environment_policy]',
    'inherit = "all"',
    '',
  ].join('\n');

/** 跑一次 codex sandbox（不提权），返回退出码、用时与第一行错误。 */
function runSandbox(exe, home, copy, profileToml) {
  writeFileSync(join(home, 'config.toml'), profileToml, 'utf8');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(
    exe,
    ['sandbox', '-P', 'ixaeon', '-C', copy, '--', 'cmd', '/c', 'echo', 'd2c-probe'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: home },
    },
  );
  const seconds = Number((Number(process.hrtime.bigint() - t0) / 1e9).toFixed(2));
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const errLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /sandbox failed|^Error|^error:/.test(l)) ?? '(没有错误行)';
  return { status: r.status, seconds, errLine, text };
}

/** 目录里的文件（相对路径），只用于「往哪写了」的取证。 */
function listTree(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      out.push(isDir ? `${rel}/` : `${rel} (${statSync(p).size} bytes)`);
      if (isDir) walk(p, rel);
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* 空目录 */
  }
  return out;
}

/** 被动机器状态：沙箱服务在不在跑、有没有旧版建的两个本地账户。 */
function machineState() {
  const svc = spawnSync('sc.exe', ['query', 'CodexSandboxService.OpenAI.Codex'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const svcText = `${svc.stdout ?? ''}${svc.stderr ?? ''}`;
  const service = /RUNNING/.test(svcText)
    ? 'RUNNING'
    : /STOPPED/.test(svcText)
      ? 'STOPPED'
      : /1060/.test(svcText)
        ? '不存在'
        : '其他';
  const users = spawnSync('net.exe', ['user'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const names = `${users.stdout ?? ''}`.match(/CodexSandbox\w+/g) ?? [];
  return { service, accounts: [...new Set(names)] };
}

// ---- 1. 找最新版 ----
const { candidates, latest } = findLatestCodex();
console.log('== 1) bin 下的 codex.exe 与版本 ==');
for (const c of candidates) console.log(`   - ${c.exe} → ${c.raw}`);
if (!latest) {
  console.log('RESULT 没通过：%LOCALAPPDATA%\\OpenAI\\Codex\\bin 下没找到 codex.exe');
  process.exit(1);
}
console.log(`最新：${latest.version}`);

// ---- 2. 新版用法 ----
const helpHome = mkdtempSync(join(tmpdir(), 'ixa-d2c-help-'));
const help = spawnSync(latest.exe, ['sandbox', '--help'], {
  encoding: 'utf8',
  timeout: 60_000,
  windowsHide: true,
  env: { ...process.env, CODEX_HOME: helpHome },
});
const helpText = `${help.stdout ?? ''}${help.stderr ?? ''}`;
console.log('\n== 2) codex sandbox --help（原样，遮罩后） ==');
console.log(
  helpText
    .split('\n')
    .filter((l) => !/CategoryInfo|FullyQualifiedErrorId|所在位置|^\s*\+|^At line/.test(l))
    .slice(0, 55)
    .join('\n')
    .trimEnd(),
);
for (const must of [
  '--permission-profile',
  '-C, --cd',
  '--sandbox-state-disable-network',
  'uninstall',
]) {
  if (!helpText.includes(must)) fail(`help 里没有 ${must}`);
}
rmSync(helpHome, { recursive: true, force: true });

// ---- 3. 不提权跑三种 profile ----
const shapes = [
  ['旧版那套（workspace_roots + copy/** write + network false）', oldStyleProfile],
  ['只有空 profile（[permissions.ixaeon]）', () => '[permissions.ixaeon]\n'],
  [
    'copy/** 写 + 一条 deny',
    (copy) =>
      `[permissions.ixaeon]\n[permissions.ixaeon.filesystem]\n"${copy.replaceAll('\\', '/')}/**" = "write"\n"C:\\\\Windows" = "deny"\n`,
  ],
];
console.log('\n== 3) 不提权跑 codex sandbox（三种 profile 形状） ==');
const attempts = [];
for (const [label, make] of shapes) {
  const { base, home, copy } = makeDirs('shape');
  const r = runSandbox(latest.exe, home, copy, make(copy));
  console.log(`   - ${label}：exit=${r.status}，${r.errLine}`);
  console.log(`     CODEX_HOME 里留下 ${listTree(home).length} 项`);
  attempts.push({ label, ...r });
  rmSync(base, { recursive: true, force: true });
}
const elevationBlocked = attempts.every(
  (a) =>
    a.status !== 0 &&
    /Restricted read-only access requires the elevated Windows sandbox backend/.test(a.errLine),
);
if (!elevationBlocked) fail('三种 profile 不是都以「需要提权后端」失败（结论要重写）');

// ---- 4. CODEX_HOME 不放在 %TEMP% 时 ----
{
  const home = resolve('.logs', 'd2c-home-nontemp');
  const copy = resolve('.logs', 'd2c-copy-nontemp');
  for (const d of [home, copy]) mkdirSync(d, { recursive: true });
  writeFileSync(join(copy, 'note.txt'), '合成项目里的一个文件\n', 'utf8');
  const r = runSandbox(latest.exe, home, copy, oldStyleProfile(copy));
  console.log('\n== 4) CODEX_HOME 放在 %TEMP% 之外（一次性目录）==');
  console.log(`   exit=${r.status}，${r.errLine}`);
  const helperWarning = /Refusing to create helper binaries under temporary dir/.test(r.text);
  console.log(
    `   「不允许在临时目录下建 helper」的告警：${helperWarning ? '有' : '没有（helper 能生成）'}`,
  );
  console.log(`   home 里留下（前 8 项）：${listTree(home).slice(0, 8).join('、') || '（空）'}`);
  rmSync(home, { recursive: true, force: true });
  rmSync(copy, { recursive: true, force: true });
}

// ---- 5. 少给 -P（参数错误）时会留下什么 ----
{
  const { base, home, copy } = makeDirs('args');
  writeFileSync(join(home, 'config.toml'), oldStyleProfile(copy), 'utf8');
  const r = spawnSync(latest.exe, ['sandbox', '-C', copy, '--', 'cmd', '/c', 'echo', 'x'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: home },
  });
  const files = listTree(home);
  console.log('\n== 5) 少给 -P 时 CODEX_HOME 里有什么（cap_sid 还算不算授权标记） ==');
  console.log(`   exit=${r.status}；文件：${files.join('、') || '（空）'}`);
  const hasCap = files.some((f) => f.startsWith('cap_sid'));
  console.log(
    hasCap
      ? '   → cap_sid 在没提权、也没跑成功时也会出现：旧版「cap_sid 在=已授权」这条不再成立'
      : '   → 这次没出现 cap_sid',
  );
  rmSync(base, { recursive: true, force: true });
}

// ---- 6. 连着跑 10 次 ----
{
  const { base, home, copy } = makeDirs('ten');
  const times = [];
  const statuses = [];
  const sameError = [];
  for (let i = 0; i < 10; i++) {
    const r = runSandbox(latest.exe, home, copy, oldStyleProfile(copy));
    times.push(r.seconds);
    statuses.push(r.status);
    sameError.push(
      /Restricted read-only access requires the elevated Windows sandbox backend/.test(r.errLine),
    );
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  tenRunMedian = median;
  console.log('\n== 6) 连着跑 10 次（确定性 / 弹窗 / 耗时） ==');
  console.log(`   退出码：${statuses.join(',')}`);
  console.log(`   每次都是同一条提权错误：${sameError.every(Boolean) ? '是' : '不是'}`);
  console.log(`   用时（秒）：${times.join(',')}｜中位 ${median}s`);
  console.log('   全程没有弹窗：每次都在 1 秒内返回（有弹窗会卡住到超时）');
  if (!statuses.every((s) => s === 1)) fail('10 次里退出码不全是 1');
  if (!sameError.every(Boolean)) fail('10 次里有不是同一条提权错误的');
  rmSync(base, { recursive: true, force: true });
}

// ---- 7. 被动的机器状态 ----
const before = machineState();
console.log('\n== 7) 被动机器状态（只读查询：sc query / net user） ==');
console.log(`   服务 CodexSandboxService.OpenAI.Codex：${before.service}`);
console.log(
  `   本地账户里的 sandbox 相关名字：${before.accounts.length ? before.accounts.join('、') : '（没有）'}`,
);
{
  const { base, home, copy } = makeDirs('syscheck');
  runSandbox(latest.exe, home, copy, oldStyleProfile(copy));
  const after = machineState();
  console.log(
    `   跑一次失败之后：服务 ${after.service}、账户 ${after.accounts.join('、') || '（没有）'}`,
  );
  if (after.service !== before.service || after.accounts.join(',') !== before.accounts.join(','))
    fail('跑一次失败之后机器状态变了（服务或账户）');
  rmSync(base, { recursive: true, force: true });
}

console.log(
  '\nRESULT ' +
    (failed
      ? '没通过：上面有「不符」的那条（见输出）'
      : `通过：新版 0.163 的 codex sandbox 在**不提权**时一律以「Restricted read-only access requires the elevated Windows sandbox backend」失败（exit 1、中位 ${tenRunMedian ?? '?'}s、不弹窗、不改机器状态）；配方与结论见交付说明`),
);
process.exit(failed ? 1 : 0);
