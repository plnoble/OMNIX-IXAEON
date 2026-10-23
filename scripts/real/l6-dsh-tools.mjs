/**
 * L6 真机检查「甲」：DSH 里的 git / gh / codex 连不连得上（真调用 ≤ 2 次里的 1 次）。
 *
 * 起 DSH 时在环境里追加 `GIT_CONFIG_PARAMETERS`（git 用它传 `-c` 设置；名字里不带被 DSH 擦的
 * `KEY`/`TOKEN`/`SECRET`/`PASSWORD`）——原来有值就放在前面、用空格隔开。让它在一个临时目录里跑：
 *   git ls-remote <公开仓库> main ｜ git clone --depth 1 再 git fetch ｜ gh auth status ｜ codex login status
 * 都**不调模型、不推送**（ls-remote/clone/fetch 只读；两个 status 只是查登录状态）。
 *
 * 输出遮掉临时目录、账户名，以及任何像令牌的东西。看 `GIT_CONFIG_PARAMETERS` 有没有被 DSH 擦掉。
 *   node scripts/real/l6-dsh-tools.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/plnoble/OMNIX-IXAEON.git';
const work = mkdtempSync(join(tmpdir(), 'ixa-l6-tools-'));
const probe = join(work, 'probe');

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
  // 令牌样子的东西一律遮掉（gh / github pat，以及 token/secret/password 后面跟的长串）
  text = text.replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '<令牌>');
  text = text.replace(/(token|secret|password)["'\s:=]{1,4}[^\s"',]{8,}/gi, '$1=<敏感值>');
  text = text.replace(/\/\/[^/\s@]+@/g, '//***@');
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

/** `GIT_CONFIG_PARAMETERS`：原来有值就放前面、空格隔开（契约第 1 条）。 */
const withGitConfigParameters = (env) => {
  const prev = env.GIT_CONFIG_PARAMETERS?.trim();
  return {
    ...env,
    GIT_CONFIG_PARAMETERS: prev ? `${prev} 'http.sslBackend=openssl'` : `'http.sslBackend=openssl'`,
  };
};

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

mkdirSync(probe, { recursive: true });
log('== 甲：DSH 里的 git / gh / codex 连不连得上（只读，不推）');

const promptPath = join(work, 'prompt.md');
writeFileSync(
  promptPath,
  [
    '你是开发 agent（名字 dev）。这一棒**只读探测**：不要改任何文件、不要提交、不要推送。',
    '当前目录就是一个可以干活的地方。请一条一条跑下面五条，每条把**退出码和原样输出**报出来：',
    `1. \`git ls-remote ${REPO_URL} main\``,
    `2. \`git clone --depth 1 ${REPO_URL} probe-clone\`，成功后再 \`git -C probe-clone fetch --depth 1 origin main\``,
    '3. `gh auth status`',
    '4. `codex login status`',
    '5. `Write-Output "GIT_CONFIG_PARAMETERS=$env:GIT_CONFIG_PARAMETERS"`（看这个变量有没有传进来）',
    '不要换别的办法绕过、不要改 git 配置、不要登录任何东西、不要 push。',
    '最后一行输出：RELAY-DONE 1 <git/gh/codex 各通不通的一句话>',
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
const env = withGitConfigParameters(base);
log(`   注给 DSH 的：GIT_CONFIG_PARAMETERS=${env.GIT_CONFIG_PARAMETERS}`);
log(`   （原来的值：${base.GIT_CONFIG_PARAMETERS ?? '（没有）'}）`);

const started = Date.now();
const r = spawnSync(
  process.execPath,
  [launcher, dsh.exe, dsh.cli, '--profile', 'headless', '--json', `读 ${promptPath}，照里面做。`],
  { cwd: probe, encoding: 'utf8', env, windowsHide: true, timeout: 900_000 },
);
log(
  `   DSH 退出码 ${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
);

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

const joined = (re) =>
  calls
    .filter((c) => re.test(String(c.input?.command ?? '')))
    .map((c) => String(byId.get(c.callId)?.result ?? ''))
    .join('\n');

for (const c of calls) {
  log(`     ▶ ${mask(String(c.input?.command ?? c.input?.file_path ?? '')).slice(0, 200)}`);
  log(
    `       ← ${mask(String(byId.get(c.callId)?.result ?? '').replace(/\s+/g, ' ')).slice(0, 500) || '(空)'}`,
  );
}
log(`   它最后说的（截 2000 字）：${mask(String(finals.at(-1)?.text ?? '')).slice(0, 2000)}`);
log(
  `   额度字样：${/usage_limit_reached|rate_limit_exceeded|session_limit/i.test(raw) ? '出现了' : '没出现'}`,
);
log(`   注意：这一条量的是只读连通性；没用额度相关的判断做门槛`);

const lsRemote = joined(/ls-remote/i);
const cloned = joined(/clone --depth/i);
const fetched = joined(/fetch --depth/i);
const gh = joined(/gh auth status/i);
const codex = joined(/codex login status/i);
const envShow = joined(/GIT_CONFIG_PARAMETERS/i);

const said = (out) =>
  out.match(/\[exit code:\s*(\d+)\]/)?.[1] ??
  out.match(/(?:CLONE_|FETCH_)?EXITCODE=(\d+)/)?.[1] ??
  '(输出里没有退出码)';
log('  —— 逐条结论 ——');
log(`   git ls-remote：读到 sha=${/[0-9a-f]{40}/i.test(lsRemote)}｜退出码 ${said(lsRemote)}`);
log(`   git clone：成功=${cloned !== '' && !/fatal/i.test(cloned)}｜退出码 ${said(cloned)}`);
log(`   git fetch：成功=${fetched !== '' && !/fatal/i.test(fetched)}｜退出码 ${said(fetched)}`);
log(`   gh auth status：退出码 ${said(gh)}`);
log(`   codex login status：退出码 ${said(codex)}`);
log(
  `   GIT_CONFIG_PARAMETERS 到没到子进程：${/GIT_CONFIG_PARAMETERS=.*openssl/.test(envShow) ? '到了' : '没到（或被擦）'}`,
);

rmSync(work, { recursive: true, force: true });
process.exit(0);
