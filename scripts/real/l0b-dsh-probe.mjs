/**
 * L0b「甲」：DSH（DeepSeek Harness）那一列，补 L0 没测成的部分——最小真调用、结果字段、用量、
 * 能不能关在一个目录里（目录里建文件 / 往目录外建文件）、按会话号接着上一轮、
 * 和 Claude 同时跑会不会打架、跑前跑后 ~/.dsh 下哪些文件变了（只比时间与大小）。
 *
 * 硬规矩：不把 DSH 设成「完全放开、从不询问」（不设 DSH_PERMISSION_MODE=danger-full-access，
 * 也不改 profile 里的 permission 预设）；全在一次性目录里跑合成任务；不打印任何凭据文件。
 *
 *   node scripts/real/l0b-dsh-probe.mjs --probe help
 *   node scripts/real/l0b-dsh-probe.mjs --probe tiny --watch
 *   node scripts/real/l0b-dsh-probe.mjs --probe write-inside
 *   node scripts/real/l0b-dsh-probe.mjs --probe write-outside
 *   node scripts/real/l0b-dsh-probe.mjs --probe resume --session <sessionId>
 *   node scripts/real/l0b-dsh-probe.mjs --probe concurrent          # DSH 与 Claude 同时跑
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const probe = arg('probe', 'help');
const session = arg('session');

/** dsh 的真入口：安装目录里的 dsh.cmd 就是「DeepSeek Harness.exe --expose-internals <asar 里的 cli.js>」，
 * 这里照它的原文直接起进程（绕开 .cmd 引号与中文参数被代码页吃掉的问题）。 */
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
    // cli.js 在 app.asar 里面，Node 的 existsSync 看不见（Electron 自己能解析 asar），所以只查 exe + resources 目录
    if (existsSync(exe) && existsSync(join(install, 'resources', 'app.asar'))) {
      return { exe, prefix: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  }
  throw new Error('没找到 dsh：安装目录里没有 App 可执行 + app.asar');
}

function makeWorkdirs() {
  const base = mkdtempSync(join(tmpdir(), 'ixa-l0b-dsh-'));
  const work = join(base, 'work');
  const outside = join(base, 'outside');
  for (const d of [work, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(work, 'note.txt'), '合成项目里的一个文件\n', 'utf8');
  return { base, work, outside };
}

const listTree = (dir) => {
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
};

/** ~/.dsh 下的文件（只比修改时间与大小，不读内容）。 */
function snapshotDsh() {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > 4) return;
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
        if (name === 'node_modules' || name === 'cache' || name === 'sessions') continue;
        walk(p, depth + 1);
      } else {
        out.set(p, `${Math.round(st.mtimeMs)}/${st.size}`);
      }
    }
  };
  walk(join(homedir(), '.dsh'), 0);
  return out;
}

const dsh = dshBin();
const { base, work, outside } = makeWorkdirs();

const tasks = {
  help: null,
  tiny: '只回三个字母：OK',
  'write-inside': '在当前目录建 inside.txt，里面只写 OK',
  'write-outside': `把 OK 写到 ${join(outside, 'outside.txt')} 这个文件里`,
  resume: '我上一条说的是哪三个字母？只回那三个字母',
  concurrent: '只回三个字母：OK',
};
if (!(probe in tasks)) throw new Error(`不认识的 probe：${probe}`);

if (probe === 'help') {
  const r = spawnSync(dsh.exe, [...dsh.prefix, '--profile', 'headless', '--help'], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, ...dsh.env },
  });
  console.log(`dsh 0.2.1-rc.2（安装目录的 dsh.cmd → App 可执行 + app.asar 里的 cli.js）`);
  console.log(mask(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()));
  process.exit(r.status === 0 ? 0 : 1);
}

const args = ['--profile', 'headless', '--json'];
if (session) args.push('--session-id', session);
args.push(tasks[probe]);

/** Claude 的命令行入口（并发那一组要用）。 */
function claudeExe() {
  return join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
}

const before = flag('watch') || probe === 'concurrent' ? snapshotDsh() : null;
const runOne = (label, cmd, cmdArgs, cwd, env = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      resolve({
        label,
        code,
        seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
        out,
        err,
      });
    });
  });

const show = (r) => {
  console.log(`== ${r.label}：exit=${r.code}｜用时 ${r.seconds}s`);
  const lines = mask(`${r.out}${r.err ? `\n[stderr]\n${r.err}` : ''}`)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const jsonLines = lines.filter((l) => l.startsWith('{'));
  const other = lines.filter((l) => !l.startsWith('{'));
  console.log(`   非 JSON 行（最多 8 行）：`);
  for (const l of other.slice(0, 8)) console.log(`     ${l.slice(0, 300)}`);
  console.log(`   JSON 事件 ${jsonLines.length} 条，最后 6 条（每条截 400 字）：`);
  for (const l of jsonLines.slice(-6)) console.log(`     ${l.slice(0, 400)}`);
  const sessionId = (mask(r.out).match(/"session(?:Id|_id)"\s*:\s*"([^"]+)"/) ?? [])[1];
  console.log(`   会话号（如果有）：${sessionId ?? '(输出里没找到)'}`);
  return sessionId;
};

let lastSession = null;
if (probe === 'concurrent') {
  console.log(`== DSH 与 Claude 同时跑（两个都只回三个字母）`);
  const [d, c] = await Promise.all([
    runOne('DSH', dsh.exe, [...dsh.prefix, ...args], work, dsh.env),
    runOne('Claude', claudeExe(), ['-p', '只回三个字母：OK', '--output-format', 'json'], work),
  ]);
  show(d);
  show(c);
} else {
  const r = await runOne('DSH', dsh.exe, [...dsh.prefix, ...args], work, dsh.env);
  lastSession = show(r);
}

if (probe === 'write-inside' || probe === 'write-outside') {
  console.log(`== 落盘取证`);
  console.log(`   工作目录：${listTree(work).join('、') || '(空)'}`);
  console.log(`   目录外：${listTree(outside).join('、') || '(空)'}`);
}
if (probe === 'write-inside' || probe === 'write-outside') {
  console.log(`   备用：这次用的临时目录根 ${base}`);
}
if (before) {
  const after = snapshotDsh();
  const changed = [...after.entries()].filter(([p, v]) => before.get(p) !== v);
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  console.log(`== ~/.dsh 下变了 / 新增 / 少了什么（只比时间与大小）`);
  console.log(`   变了 ${changed.length} 个：`);
  for (const [p, v] of changed.slice(0, 20)) console.log(`     ${p} → ${v}`);
  console.log(`   新增 ${added.length} 个：${added.slice(0, 10).join('、')}`);
  console.log(`   少了 ${removed.length} 个：${removed.slice(0, 10).join('、')}`);
}
if (lastSession) console.log(`（下次要接着这一轮：--probe resume --session ${lastSession}）`);
process.exit(0);
