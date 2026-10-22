/**
 * L5 真机检查「甲」：DSH 在沙箱里**带登录**推 GitHub（真调用 ≤ 2 次）。
 *
 * 背景（L4 丁）：DSH 的沙箱不挡联网，推不上去是 Windows 自带的 TLS（schannel）在受限令牌下拿不到
 * 客户端凭据；git 改用自带的 OpenSSL（`-c http.sslBackend=openssl`）就连得上公开仓库。
 * 这一次量带登录的推送：起 DSH 时在环境里**追加**一项 git 配置（不改任何 git 配置文件）——
 *   GIT_CONFIG_COUNT = n+1、GIT_CONFIG_KEY_<n> = http.sslBackend、GIT_CONFIG_VALUE_<n> = openssl
 * （原来的第 0…n−1 项原样保留）。这一步是脚本自己加的，不等实现（实现会加在 bin/dsh.mjs 里）。
 *
 * 剩下照 `scripts/real/l4-dsh-push.mjs`：临时目录里 `git clone --depth 1` 真仓库，让 DSH 建分支
 * `relay-probe/<时间戳>`、提交一个空提交、推上去；脚本最后**一定删掉这个远端分支**（失败重试），
 * 并用 `ls-remote` 确认远端没有 `relay-probe/*`。
 *
 * 推不上去就如实记报错（遮掉用户目录）：多半是凭据管理器在受限令牌下读不到登录态。
 * **不许**改 git 的凭据设置、不许把令牌写进任何文件或环境变量。
 *   node scripts/real/l5-dsh-push.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/plnoble/OMNIX-IXAEON.git';
const COMMIT_MSG = '接力探测：DSH 沙箱里推送（会马上删掉）';
const work = mkdtempSync(join(tmpdir(), 'ixa-l5-push-'));
const clone = join(work, 'repo');
const branch = `relay-probe/${Math.floor(Date.now() / 1000)}`;
/** `--local-config`：不注环境变量，改成把 `http.sslBackend=openssl` 写进这份工作目录的仓库级配置。 */
const localConfig = process.argv.includes('--local-config');

const mask = (s) => {
  let text = String(s);
  for (const p of [work, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  text = text.replace(/\/\/[^/\s@]+@/g, '//***@'); // URL 里的凭据片段一律遮掉
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args, allowFail = false) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (r.status !== 0 && !allowFail) throw new Error(mask(`git ${args.join(' ')}：${r.stderr}`));
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/**
 * 往环境里**追加**一项 git 配置（契约第 1 条的写法）：`GIT_CONFIG_COUNT` 原来是 n（没有就当 0），
 * 新的挂在第 n 项，原来的第 0…n−1 项原样保留。只动环境变量，不写任何配置文件。
 */
const withGitSslBackend = (env) => {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'http.sslBackend',
    [`GIT_CONFIG_VALUE_${n}`]: 'openssl',
  };
};

/** dsh 的真入口（照 L0b 的 dshBin()）：`resources/app.asar` 在真机上是文件，探到这一层。 */
function dshBin() {
  const installs = [
    process.env.IXAEON_DSH_INSTALL?.trim(),
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ].filter((x) => x && x.trim());
  for (const install of installs) {
    const exe = join(install, 'DeepSeek Harness.exe');
    const asar = join(install, 'resources', 'app.asar');
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
    if (existsSync(exe) && existsSync(asar)) return { exe, cli };
  }
  return null;
}

const dsh = dshBin();
if (!dsh) {
  log('没跑：没找到 DSH 的安装目录');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

let passed = true;
const check = (ok, what) => {
  log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) passed = false;
};

const remoteHasBranch = () =>
  git(clone, ['ls-remote', '--heads', 'origin', branch], true).out.includes(branch);

/** 远端还有没有 relay-probe/*（收尾用）。 */
const remoteProbes = () =>
  git(clone, ['ls-remote', '--heads', 'origin', 'refs/heads/relay-probe/*'], true)
    .out.split('\n')
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[1])
    .filter(Boolean);

const deleteBranch = () => {
  for (let i = 0; i < 3; i++) {
    const r = git(clone, ['push', 'origin', '--delete', branch], true);
    if (r.code === 0) return { ok: true, out: r.out };
    if (i < 2) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']);
  }
  return { ok: false, out: git(clone, ['push', 'origin', '--delete', branch], true).out };
};

try {
  log(
    `== 甲：DSH 在沙箱里带登录推 GitHub｜分支 ${branch}｜${
      localConfig ? '走仓库级配置 http.sslBackend=openssl' : '走环境变量 GIT_CONFIG_*'
    }`,
  );
  const cloned = git(work, ['clone', '--depth', '1', REPO_URL, clone], true);
  if (cloned.code !== 0) {
    log(`   克隆失败：${mask(cloned.out).slice(0, 400)}`);
    passed = false;
  } else {
    runTurn();
  }
} finally {
  const had = remoteHasBranch();
  if (had) {
    const del = deleteBranch();
    const gone = !remoteHasBranch();
    log(`   删远端分支：${del.ok && gone ? '删掉了' : '没删成'}`);
    if (!del.ok) log(`   删除报错（截 300 字）：${mask(del.out).slice(0, 300)}`);
    check(gone, '探测分支已经删掉');
  } else {
    log('   删远端分支：远端本来就没有这个分支（不用删）');
  }
  const left = remoteProbes();
  log(
    `   收尾复查：远端 relay-probe/* ${left.length === 0 ? '是空的' : `还剩 ${left.join('、')}`}`,
  );
  check(left.length === 0, '远端没有留下 relay-probe/*');
  rmSync(work, { recursive: true, force: true });
  log(passed ? 'RESULT 通过' : 'RESULT 没通过');
  process.exit(passed ? 0 : 1);
}

/** 克隆好了之后：写交代、起 DSH（带那三个环境变量）、看远端。 */
function runTurn() {
  log(`   克隆好了：${mask(clone)}`);
  if (localConfig) {
    // 换一条路：由「调度器」在准备工作目录时，把 TLS 后端写进这份工作目录的**仓库级**配置。
    // 只动这份临时克隆的 .git/config，不碰用户的全局/系统设置、不碰凭据。
    git(clone, ['config', '--local', 'http.sslBackend', 'openssl']);
    log(
      `   已写仓库级配置：http.sslBackend=${git(clone, ['config', '--local', '--get', 'http.sslBackend']).out}`,
    );
  }

  const promptPath = join(work, 'prompt.md');
  writeFileSync(
    promptPath,
    [
      '你是开发 agent（名字 dev）。当前目录是一个克隆，origin 指向 GitHub 上的公开仓库。',
      '这一棒只做三件事，做完就停：',
      `1. 建一个分支：git switch -c ${branch}`,
      `2. 提交一个空提交：git commit --allow-empty -m "${COMMIT_MSG}"`,
      `3. 推上去：git push -u origin ${branch}`,
      '推不上去就如实记下报错（不要改任何凭据设置、不要换协议、不要改 git 配置、不要用别的办法绕过）。',
      '把 `git push` 那段原样的输出贴出来（成功贴推上去的那几行，失败贴 fatal 那几行）。',
      '最后一行输出：RELAY-DONE 1 <推成了还是没推成>',
      '',
    ].join('\n'),
    'utf8',
  );

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

  const base = { ...process.env };
  delete base.ELECTRON_RUN_AS_NODE;
  // --local-config 时不注环境变量（那条路已经证明走不通：DSH 会把名字里带 KEY 的变量擦掉）。
  const env = localConfig ? base : withGitSslBackend(base);
  if (!localConfig) {
    log(
      `   注给 DSH 的 git 配置：GIT_CONFIG_COUNT=${env.GIT_CONFIG_COUNT}｜KEY_0=${env.GIT_CONFIG_KEY_0}｜VALUE_0=${env.GIT_CONFIG_VALUE_0}` +
        (Number(env.GIT_CONFIG_COUNT) > 1
          ? `（原来的第 0…${Number(env.GIT_CONFIG_COUNT) - 2} 项原样保留）`
          : '（原来没有 GIT_CONFIG_COUNT）'),
    );
  }

  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [launcher, dsh.exe, dsh.cli, '--profile', 'headless', '--json', `读 ${promptPath}，照里面做。`],
    { cwd: clone, encoding: 'utf8', env, windowsHide: true, timeout: 900_000 },
  );
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  log(`   DSH 退出码 ${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`);

  const raw = `${r.stdout ?? ''}`;
  const parsed = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
  const calls = parsed.filter((j) => j && j.type === 'tool_call');
  const results = parsed.filter((j) => j && j.type === 'tool_result');
  const finals = parsed.filter((j) => j && j.type === 'final');
  const byId = new Map(results.map((x) => [x.callId, x]));
  log(
    `   JSONL 行 ${raw.split('\n').filter(Boolean).length}｜tool_call ${calls.length} 条｜最终回答 ${finals.length} 条`,
  );
  for (const c of calls) {
    const res = byId.get(c.callId);
    log(`     ▶ ${mask(String(c.input?.command ?? c.input?.file_path ?? '')).slice(0, 220)}`);
    log(`       ← ${mask(String(res?.result ?? '').replace(/\s+/g, ' ')).slice(0, 400) || '(空)'}`);
  }
  log(`   它最后说的（截 2500 字）：${mask(String(finals.at(-1)?.text ?? '')).slice(0, 2500)}`);
  if ((r.stderr ?? '').trim())
    log(`   stderr（截 400 字）：${mask((r.stderr ?? '').trim()).slice(0, 400)}`);
  log(
    `   额度字样：${/usage_limit_reached|rate_limit_exceeded|session_limit/i.test(raw) ? '出现了' : '没出现'}`,
  );

  const pushed = remoteHasBranch();
  log(`   Git 的远端分支存在吗：${pushed}`);
  if (!pushed) {
    const all = calls.map((c) => String(c.input?.command ?? '')).join('\n');
    const outs = results.map((x) => String(x.result ?? '')).join('\n');
    for (const [label, re] of [
      ['schannel 拿不到凭据', /SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle failed/],
      [
        '凭据管理器/登录态',
        /credential|Credentials|fatal: Authentication failed|terminal prompts disabled|GIT_TERMINAL_PROMPT/,
      ],
      ['还是没走到网络', /Could not resolve host|No such host|Connection was reset|timed out/],
    ]) {
      if (re.test(`${all}\n${outs}`)) log(`   卡在哪：${label}`);
    }
  }
  check(pushed, 'DSH 在沙箱里把探测分支推上了 GitHub');
}
