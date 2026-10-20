/**
 * L0b「丁」：Codex 沙箱**提权一次**，并回答这一单最要紧的问题——
 * 「装一次之后，还要不要每次提权」（同一个 CODEX_HOME 连跑 10 次带 / 不带提权设置；再换一个新的 CODEX_HOME 跑一次）。
 *
 * ⚠ 这个脚本会弹**一次** Windows 管理员确认（UAC）：
 *   跑 `codex sandbox setup --elevated --current-user --codex-home <一次性目录>`，
 *   会**装或更新 Codex 的沙箱账户、服务和防火墙规则**。
 *   用户点「是」才继续；点「否」就整个停下，写「用户没同意提权」（退出码 2）。只提权这一次。
 *
 * 不做什么：不跑 `codex sandbox uninstall`、不调模型、不跑 `codex exec`、不碰用户的 `~/.codex`
 * （丁-4 那条「用默认配置目录看 .sandbox-bin 加锁失败还在不在」在 l0b-codex-default-home.mjs 里）。
 * 全在 %TEMP% 以外的一次性目录里跑；输出遮掉临时目录、用户目录与账户名。
 *
 *   node scripts/real/l0b-codex-elevate.mjs              # 真跑：会弹一次 UAC
 *   node scripts/real/l0b-codex-elevate.mjs --no-elevate # 只跑不弹 UAC 的部分（重跑取证用）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  // 本机账户名本身也要遮（net user 那种表格会把账户名带进来）
  for (const name of [process.env.USERNAME, process.env.USER]) {
    if (name && name.trim() && name.trim().length >= 3)
      text = text.split(name.trim()).join('<本机账户>');
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
const noElevate = argv.includes('--no-elevate');
/** 提权已经做过（同一个 home-A），这次只补做「装完之后」的观察，不再弹 UAC。 */
const afterSetup = argv.includes('--after-setup');
let failed = false;
const fail = (why) => {
  failed = true;
  console.log('不符：' + why);
};

/** 在 %LOCALAPPDATA%\OpenAI\Codex\bin 下（顶层 + 每个子目录）找 codex.exe，全部问 --version，取最大的。 */
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
  return withVersion.at(-1);
}

/**
 * 一次性目录（都在 %TEMP% 之外）：
 * - homeA：提权 setup 用的那个 CODEX_HOME（这一单的主角）
 * - homeB：setup 之后新开的一个 CODEX_HOME，用来分辨「整台机器一次」还是「每个 CODEX_HOME 一次」
 * - copy：沙箱里跑的合成项目目录；outside：副本之外，用来试「往外写挡不挡得住」
 */
function makeDirs() {
  const scratch = join(homedir(), 'ixa-l0b-scratch');
  const dirs = {
    scratch,
    homeA: join(scratch, 'home-A'),
    homeB: join(scratch, 'home-B'),
    copy: join(scratch, 'copy'),
    outside: join(scratch, 'outside'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs.copy, 'note.txt'), '合成项目里的一个文件\n', 'utf8');
  return dirs;
}

/** 权限档：照 D2c 的配方（旧版那套 TOML 形状新版仍然解析得通）。
 * 提权那档必须显式给 `:root` 读权限，否则新版会拒：`elevated Windows sandbox requires effective ':root' read access`。 */
const profileToml = (copy, { elevated }) =>
  [
    '[permissions.ixaeon]',
    '[permissions.ixaeon.workspace_roots]',
    `"${copy.replaceAll('\\', '/')}" = true`,
    '[permissions.ixaeon.filesystem]',
    ...(elevated ? ['":root" = "read"'] : []),
    `"${copy.replaceAll('\\', '/')}/**" = "write"`,
    '[permissions.ixaeon.network]',
    'enabled = false',
    '[shell_environment_policy]',
    'inherit = "all"',
    ...(elevated ? ['', '[windows]', 'sandbox = "elevated"'] : []),
    '',
  ].join('\n');

/** 跑一次 `codex sandbox`（不调模型）：走不走得通、用时、错误行、stdout。 */
function runSandbox(exe, home, copy, { elevated, timeoutMs = 180_000 }) {
  writeFileSync(join(home, 'config.toml'), profileToml(copy, { elevated }), 'utf8');
  const args = ['sandbox', '-P', 'ixaeon', '-C', copy, '--', 'cmd', '/c', 'echo', 'l0b-ok'];
  if (elevated) args.unshift('-c', 'windows.sandbox="elevated"');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: home },
  });
  const seconds = Number((Number(process.hrtime.bigint() - t0) / 1e9).toFixed(2));
  const stdout = (r.stdout ?? '').trim();
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const errLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /sandbox failed|^Error|^error:|requires the elevated/.test(l)) ?? '(没有错误行)';
  return {
    status: r.status,
    seconds,
    errLine,
    stdout,
    text,
    timedOut: r.status === null,
  };
}

/** 被动机器状态（全是只读查询）：服务、沙箱账户、防火墙里带 Codex 的规则、~/.codex/.sandbox-bin。 */
function machineState() {
  const run = (cmd, args, timeout = 25_000) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  };
  const svcText = run('sc.exe', ['query', 'CodexSandboxService.OpenAI.Codex']);
  const service = /RUNNING/.test(svcText)
    ? 'RUNNING'
    : /STOPPED/.test(svcText)
      ? 'STOPPED'
      : /1060/.test(svcText)
        ? '不存在'
        : '其他';
  const userText = run('net.exe', ['user']);
  // 只取沙箱账户名本身：net user 的表格会把本机账户名一起带出来
  const accounts = [...new Set(userText.match(/CodexSandbox[A-Za-z0-9_-]*/g) ?? [])]
    .sort()
    .join('、');
  const fwText = run('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', 'name=all']);
  const fwRules = fwText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /Codex/i.test(l))
    .sort();
  const binDir = join(homedir(), '.codex', '.sandbox-bin');
  let binFiles = '(没有这个目录)';
  if (existsSync(binDir)) {
    try {
      const entries = readdirSync(binDir).map((n) => {
        try {
          const st = statSync(join(binDir, n));
          return { name: n, size: st.size, mtime: st.mtimeMs };
        } catch {
          return { name: n, size: -1, mtime: 0 };
        }
      });
      const newest = entries.sort((a, b) => b.mtime - a.mtime).slice(0, 2);
      binFiles = `${entries.length} 个文件；最新两个：${newest
        .map((e) => `${e.name} (${e.size} bytes)`)
        .join('、')}`;
    } catch {
      binFiles = '(读不了)';
    }
  }
  const svcList = run('sc.exe', ['query', 'type=', 'service', 'state=', 'all'])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /Codex/i.test(l));
  return { service, accounts, fwCount: fwRules.length, fwRules, binFiles, svcList };
}

function printState(title, s) {
  console.log(`== ${title}`);
  console.log(`   服务 CodexSandboxService.OpenAI.Codex：${s.service}`);
  console.log(`   本地账户里的 sandbox 相关名字：${s.accounts || '(没有)'}`);
  console.log(`   带 Codex 的服务条目：${s.svcList.length ? s.svcList.join('｜') : '(没有)'}`);
  console.log(
    `   防火墙里带 Codex 的规则：${s.fwCount} 条${s.fwCount ? `（示例：${s.fwRules[0]}）` : ''}`,
  );
  console.log(`   ~/.codex/.sandbox-bin：${s.binFiles}`);
}

/** 走 PowerShell 弹一次 UAC 跑 setup，输出与退出码落进日志文件。 */
function elevateSetup(exe, home, dirs) {
  const log = join(dirs.scratch, 'setup-elevated.log');
  const batch = join(dirs.scratch, 'setup-elevated.cmd');
  const ps1 = join(dirs.scratch, 'setup-elevated.ps1');
  writeFileSync(
    batch,
    [
      '@echo off',
      `set "CODEX_HOME=${home}"`,
      `"${exe}" sandbox setup --elevated --current-user --codex-home "${home}" 1> "${log}" 2>&1`,
      'echo SETUP_EXITCODE=%ERRORLEVEL%',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(
    ps1,
    [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $p = Start-Process -FilePath '${batch}' -Verb RunAs -PassThru`,
      '  if (-not $p.WaitForExit(600000)) { Write-Output "RESULT=TIMEOUT"; exit 3 }',
      '  Write-Output ("RESULT=EXITED EXITCODE=" + $p.ExitCode)',
      '} catch {',
      '  Write-Output ("RESULT=DENIED " + $_.Exception.Message)',
      '  exit 2',
      '}',
      '',
    ].join('\r\n'),
    'utf8',
  );
  const ps = existsSync(join(process.env.PROGRAMFILES ?? '', 'PowerShell', '7', 'pwsh.exe'))
    ? join(process.env.PROGRAMFILES, 'PowerShell', '7', 'pwsh.exe')
    : 'powershell.exe';
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    encoding: 'utf8',
    timeout: 720_000,
    windowsHide: false,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  let setupLog = '(没有日志)';
  if (existsSync(log)) {
    setupLog =
      spawnSync('cmd', ['/c', 'type', log], { encoding: 'utf8', timeout: 30_000 }).stdout ?? '';
  }
  return { out, setupLog: setupLog.trim(), status: r.status };
}

const codex = findLatestCodex();
const dirs = makeDirs();
const { exe, version } = codex;
console.log(`== 0) 用哪个 codex / 目录在哪`);
console.log(`   codex ${version} · ${exe}`);
console.log(`   一次性目录根（%TEMP% 以外）：${dirs.scratch}`);
console.log(`   CODEX_HOME（提权装的那个）：${dirs.homeA}`);
console.log(`   新开的 CODEX_HOME：${dirs.homeB}`);
console.log(`   合成项目副本：${dirs.copy}`);

const before = machineState();
printState('1) 提权之前（只读）', before);

// 参数形状先确认一遍：不带 --elevated 只会报「currently requires --elevated」，不会动机器
if (!afterSetup) {
  const shape = spawnSync(exe, ['sandbox', 'setup', '--current-user', '--codex-home', dirs.homeA], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: dirs.homeA },
  });
  const shapeText = `${shape.stdout ?? ''}${shape.stderr ?? ''}`.trim();
  console.log(`== 2) 先确认参数形状（不带 --elevated，不会动机器）`);
  console.log(`   exit=${shape.status}｜${shapeText.split('\n').find((l) => l.trim()) ?? ''}`);
  if (!/requires --elevated/.test(shapeText))
    fail('不带 --elevated 时没报「currently requires --elevated」');

  console.log(
    `== 3) 提权一次：codex sandbox setup --elevated --current-user --codex-home <home-A>`,
  );
  console.log(
    `   ${noElevate ? '（--no-elevate：这一步跳过，不弹 UAC）' : '会在屏幕上弹一次 Windows 管理员确认，请点「是」'}`,
  );
  if (!noElevate) {
    const elevation = elevateSetup(exe, dirs.homeA, dirs);
    console.log(`   PowerShell 结果：${elevation.out || '(没有输出)'}`);
    console.log(`   setup 自己的输出（原样，遮罩后）：`);
    for (const line of elevation.setupLog.split('\n')) console.log(`     ${line}`);
    if (/RESULT=DENIED/.test(elevation.out)) {
      console.log('RESULT 用户没同意提权：UAC 被取消，后面的提权相关观察全部跳过');
      console.log('（甲、乙、丙 不受影响，照规格继续做）');
      process.exit(2);
    }
  }
} else {
  console.log('== 2/3) 跳过：这一步的提权已经在前面那次跑过（--after-setup，不再弹 UAC）');
}

const after = machineState();
printState(`4) 提权之后（只读）${afterSetup ? '· 复核' : ''}`, after);
console.log(
  `   对比：服务 ${before.service} → ${after.service}｜账户 「${before.accounts}」→「${after.accounts}」`,
);
console.log(
  `   对比：防火墙 Codex 规则 ${before.fwCount} 条 → ${after.fwCount} 条｜.sandbox-bin：「${before.binFiles}」→「${after.binFiles}」`,
);
console.log(`   对比：带 Codex 的服务条目 ${before.svcList.length} → ${after.svcList.length}`);

if (noElevate) {
  console.log('RESULT 只做只读观察（--no-elevate），没弹 UAC');
  process.exit(failed ? 1 : 0);
}

console.log(`== 5) 装完之后，沙箱起不起得来（带提权设置，空命令，不调模型）`);
const first = runSandbox(exe, dirs.homeA, dirs.copy, { elevated: true });
console.log(`   exit=${first.status}｜${first.seconds}s｜${first.errLine}`);
console.log(`   stdout：${first.stdout || '(空)'}`);
if (first.status !== 0) {
  fail(`提权装完之后沙箱仍然起不来：${first.errLine}`);
  console.log('RESULT 卡住：提权装了但沙箱还是起不来，后面的问题没有数据（详见交付说明）');
  process.exit(1);
}

const loop = (label, elevated) => {
  console.log(`== ${label}`);
  const list = [];
  const t0 = Date.now();
  for (let i = 1; i <= 10; i++) {
    const r = runSandbox(exe, dirs.homeA, dirs.copy, { elevated });
    list.push(r);
    console.log(
      `   #${i} exit=${r.status}${r.timedOut ? '（超时被杀）' : ''}｜${r.seconds}s｜${
        r.errLine === '(没有错误行)' ? `没有错误行，stdout=${r.stdout || '(空)'}` : r.errLine
      }`,
    );
  }
  console.log(`   10 次总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return list;
};

const withSetting = loop(
  '6) 同一个 CODEX_HOME 连跑 10 次（带提权设置）——弹不弹窗、成不成、用时',
  true,
);
const withoutSetting = loop(
  '7) 同一个 CODEX_HOME 连跑 10 次（不带提权设置，看默认走哪条路）',
  false,
);

console.log(
  `== 8) 换一个新的 CODEX_HOME（home-B），跑一次（带提权设置）——提权是整台机器一次，还是每个 HOME 一次`,
);
const fresh = runSandbox(exe, dirs.homeB, dirs.copy, { elevated: true });
console.log(`   exit=${fresh.status}｜${fresh.seconds}s｜${fresh.errLine}`);
console.log(`   stdout：${fresh.stdout || '(空)'}`);

const stats = (list) => {
  const ok = list.filter((r) => r.status === 0).length;
  const secs = list.map((r) => r.seconds).sort((a, b) => a - b);
  const median =
    secs.length % 2
      ? secs[(secs.length - 1) / 2]
      : Number(((secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2).toFixed(2));
  return { ok, total: list.length, median, min: secs[0], max: secs.at(-1) };
};
const sw = stats(withSetting);
const so = stats(withoutSetting);
const slow = [...withSetting, ...withoutSetting].filter((r) => r.seconds > 5).length;
console.log(`== 9) 小结`);
console.log(`   带提权设置：${sw.ok}/${sw.total} 成功，中位 ${sw.median}s（${sw.min}–${sw.max}s）`);
console.log(
  `   不带提权设置：${so.ok}/${so.total} 成功，中位 ${so.median}s（${so.min}–${so.max}s）`,
);
console.log(`   超过 5 秒的调用（有弹窗/卡住的样子）：${slow} 次`);
console.log(`   新 CODEX_HOME（home-B）第一次：exit=${fresh.status}`);
console.log(
  `   提权后机器状态：服务 ${after.service}、账户「${after.accounts}」、防火墙 ${after.fwCount} 条 Codex 规则`,
);

const needEveryTime = fresh.status !== 0;
console.log(
  `RESULT ${failed ? '不完全成立' : '通过'}：一次提权 setup 之后，同一个 CODEX_HOME ${
    sw.ok === sw.total ? '不带任何提权动作就能连跑 10 次' : `只成功 ${sw.ok}/10`
  }${needEveryTime ? '；换一个新的 CODEX_HOME 又起不来（意味着每个 HOME 都要装一次）' : '；换一个新的 CODEX_HOME 也能直接跑（意味着装一次是整台机器一次）'}`,
);
process.exit(failed ? 1 : 0);
