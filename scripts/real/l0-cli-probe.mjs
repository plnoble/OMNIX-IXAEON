/**
 * L0 命令行后台实验：一次探一个命令行（claude / dsh / codex），每次最多一次真调用。
 *
 *   node scripts/real/l0-cli-probe.mjs --cli claude --probe tiny
 *   node scripts/real/l0-cli-probe.mjs --cli dsh --probe tiny --watch
 *   node scripts/real/l0-cli-probe.mjs --cli codex --probe write-inside
 *   node scripts/real/l0-cli-probe.mjs --cli claude --probe resume --session <id>
 *
 * probe：version / tiny / write-inside / write-outside / resume
 * --watch：调用前后比 ~/.claude、~/.dsh、~/.codex 下文件的修改时间与大小（只比时间大小，不读内容）
 *
 * 硬规矩（规格 L0）：不装软件、不登录、不改配置、不用「跳过所有权限」的开关；
 * 全在一次性目录里跑合成任务；输出遮掉临时目录、用户目录与账户名。
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
import { join } from 'node:path';

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

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const cli = arg('cli');
const probe = arg('probe', 'tiny');
const session = arg('session');
if (!cli)
  throw new Error(
    '用法：--cli <claude|dsh|codex> --probe <version|tiny|write-inside|write-outside|resume>',
  );

/** 找 claude 的真入口（npm 全局里的原生二进制，绕开 .cmd 引号问题）。 */
function claudeBin() {
  const p = join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  if (!existsSync(p))
    throw new Error(
      '没找到 claude.exe（%APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin）',
    );
  return { exe: p, prefix: [], env: {} };
}

/** 找 dsh：安装目录里的 App 可执行 + asar 里的 cli.js，用 ELECTRON_RUN_AS_NODE 跑（与 dsh.cmd 同一路径）。 */
function dshBin() {
  const installRoots = [
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ].filter((p) => existsSync(p));
  for (const install of installRoots) {
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
    // cli.js 在 app.asar 里面，Node 的 existsSync 看不见（Electron 自己能解析 asar），所以只查 exe + resources 目录
    if (existsSync(exe) && existsSync(join(install, 'resources', 'app.asar'))) {
      return {
        exe,
        prefix: ['--expose-internals', cli],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
  }
  throw new Error(
    '没找到 dsh：安装目录里没有 App 可执行 + app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
  );
}

/** 找最新版 codex（顶层 + 子目录都问 --version，取最大）。 */
function codexBin() {
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
  const withVersion = exes.map((exe) => {
    const r = spawnSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
    return { exe, version: m ? m[1] : '0.0.0' };
  });
  withVersion.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return { exe: withVersion.at(-1).exe, prefix: [], env: {} };
}

const bins = { claude: claudeBin, dsh: dshBin, codex: codexBin };
const bin = bins[cli]();

/** 一次性工作目录：work（项目里）、outside（项目外）。 */
function makeWorkdirs() {
  const base = mkdtempSync(join(tmpdir(), `ixa-l0-${cli}-`));
  const work = join(base, 'work');
  const outside = join(base, 'outside');
  for (const d of [work, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(work, 'note.txt'), '合成项目里的一个文件\n', 'utf8');
  return { base, work, outside };
}

/** 各 CLI 的「只回一句话」参数。 */
function buildArgs(p, work, outside, sessionId) {
  if (cli === 'claude') {
    if (p === 'version') return { args: ['--version'], cwd: work };
    if (p === 'tiny')
      return { args: ['-p', '只回三个字母：OK', '--output-format', 'json'], cwd: work };
    if (p === 'write-inside')
      return {
        args: ['-p', '在当前目录建 inside.txt，里面只写 OK', '--output-format', 'json'],
        cwd: work,
      };
    if (p === 'write-outside')
      return {
        args: [
          '-p',
          `把 OK 写到 ${join(outside, 'outside.txt')} 这个文件里`,
          '--output-format',
          'json',
        ],
        cwd: work,
      };
    if (p === 'resume')
      return {
        args: [
          '-p',
          '我上一条说的是哪个三个字母？只回那三个字母',
          '--resume',
          sessionId,
          '--output-format',
          'json',
        ],
        cwd: work,
      };
  }
  if (cli === 'dsh') {
    if (p === 'version') return { args: ['--version'], cwd: work };
    if (p === 'tiny')
      return { args: ['--profile', 'headless', '--json', '只回三个字母：OK'], cwd: work };
    if (p === 'write-inside')
      return {
        args: ['--profile', 'headless', '--json', '在当前目录建 inside.txt，里面只写 OK'],
        cwd: work,
      };
    if (p === 'write-outside')
      return {
        args: [
          '--profile',
          'headless',
          '--json',
          `把 OK 写到 ${join(outside, 'outside.txt')} 这个文件里`,
        ],
        cwd: work,
      };
    if (p === 'resume')
      return {
        args: [
          '--profile',
          'headless',
          '--json',
          '--session-id',
          sessionId,
          '我上一条说的是哪个三个字母？只回那三个字母',
        ],
        cwd: work,
      };
  }
  if (cli === 'codex') {
    if (p === 'version') return { args: ['--version'], cwd: work };
    if (p === 'tiny')
      return { args: ['exec', '--json', '--skip-git-repo-check', '只回三个字母：OK'], cwd: work };
    if (p === 'write-inside')
      return {
        args: ['exec', '--json', '--skip-git-repo-check', '在当前目录建 inside.txt，里面只写 OK'],
        cwd: work,
      };
    if (p === 'write-outside')
      return {
        args: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          `把 OK 写到 ${join(outside, 'outside.txt')} 这个文件里`,
        ],
        cwd: work,
      };
    if (p === 'write-outside-strict')
      return {
        args: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '-s',
          'workspace-write',
          `把 OK 写到 ${join(outside, 'outside.txt')} 这个文件里`,
        ],
        cwd: work,
      };
    if (p === 'resume')
      return {
        args: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          'resume',
          '--last',
          '我上一条说的是哪个三个字母？只回那三个字母',
        ],
        cwd: work,
      };
  }
  throw new Error(`不认识的 probe：${cli}/${p}`);
}

/** 配置目录快照：只看路径、修改时间、大小（不读内容）。 */
function snapshotConfigs() {
  const roots = [join(homedir(), '.claude'), join(homedir(), '.dsh'), join(homedir(), '.codex')];
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st = null;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === 'sessions' || name === 'cache') continue;
        walk(p, depth + 1);
      } else {
        out.set(p, `${st.mtimeMs}/${st.size}`);
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

const { base, work, outside } = makeWorkdirs();
const call = buildArgs(probe, work, outside, session);
const before = flag('watch') ? snapshotConfigs() : null;

const t0 = process.hrtime.bigint();
const r = spawnSync(bin.exe, [...bin.prefix, ...call.args], {
  encoding: 'utf8',
  cwd: call.cwd,
  timeout: 300_000,
  windowsHide: true,
  env: { ...process.env, ...bin.env },
});
const seconds = Number((Number(process.hrtime.bigint() - t0) / 1e9).toFixed(2));
const stdout = r.stdout ?? '';
const stderr = r.stderr ?? '';

console.log(`== ${cli} / ${probe} ==`);
console.log(`命令行：${bin.exe} ${[...bin.prefix, ...call.args].join(' ')}`);
console.log(`cwd：${call.cwd}`);
console.log(`退出码：${r.status}｜用时：${seconds}s`);
console.log(`--- stdout（${stdout.length} 字节）---`);
console.log(stdout.trim().slice(0, 12000) || '（空）');
console.log(`--- stderr（${stderr.length} 字节）---`);
console.log(stderr.trim().slice(0, 4000) || '（空）');

// 结构化输出与用量字段
const lines = stdout
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
let jsonCount = 0;
const usageSamples = [];
let sessionIdSeen = null;
let resultLine = null;
let denials = null;
for (const line of lines) {
  try {
    const v = JSON.parse(line);
    jsonCount++;
    if (typeof v.result === 'string') resultLine = v.result;
    if (Array.isArray(v.permission_denials)) denials = v.permission_denials;
    const pick = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of [
        'usage',
        'total_cost_usd',
        'cost_usd',
        'session_id',
        'sessionId',
        'tokens',
      ]) {
        if (o[k] !== undefined && k !== 'session_id' && k !== 'sessionId')
          usageSamples.push({ [k]: o[k] });
      }
      if (typeof o.session_id === 'string') sessionIdSeen = o.session_id;
      if (typeof o.sessionId === 'string') sessionIdSeen = o.sessionId;
    };
    pick(v);
    for (const v2 of Object.values(v)) pick(v2);
  } catch {
    /* 不是 JSON 的那行就算了 */
  }
}
if (resultLine !== null) console.log(`最终回答：${JSON.stringify(resultLine)}`);
if (denials !== null)
  console.log(`被拒的权限请求（permission_denials）：${JSON.stringify(denials).slice(0, 600)}`);
console.log(`可解析的 JSON 行：${jsonCount} / ${lines.length}`);
console.log(
  `用量/会话字段：${usageSamples.length ? JSON.stringify(usageSamples).slice(0, 800) : '（没找到 usage / cost / session 字段）'}`,
);
if (sessionIdSeen) console.log(`session id：${sessionIdSeen}`);

// 文件计数（写文件那一类探针）
const count = (d) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
console.log(`work 目录里的文件：${count(work).join('、') || '（空）'}`);
console.log(`outside 目录里的文件：${count(outside).join('、') || '（空）'}`);

if (before) {
  const after = snapshotConfigs();
  const changed = [];
  for (const [p, v] of after)
    if (!before.has(p) || before.get(p) !== v)
      changed.push(`${p} → ${before.get(p) ?? '新增'} ⇒ ${v}`);
  for (const p of before.keys()) if (!after.has(p)) changed.push(`${p} → 被删`);
  console.log(
    `配置快照：调用前 ${before.size} 个文件，调用后 ${after.size} 个；变化的：${changed.length ? changed.join('；') : '没有'}`,
  );
}

const ok = r.status === 0;
console.log(
  `RESULT ${ok ? '通过（这一次调用正常退出；' + cli + '/' + probe + '）' : `没通过：退出码 ${r.status}（见上面的 stderr）`}`,
);
rmSync(base, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
