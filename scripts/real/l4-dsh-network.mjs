/**
 * L4 真机检查「丁」（一）：DSH 的沙箱里能不能联网（真调用 ≤ 3 次里的 1 次）。
 *
 * 背景：真机检查乙里 DSH 推 GitHub 失败在 `schannel: AcquireCredentialsHandle failed:
 * SEC_E_NO_CREDENTIALS`，报错里还夹着「No such host is known」。DSH 源码里写着它的 Windows 沙箱是
 * WRITE_RESTRICTED 令牌，**只管写入、不管读和联网**（见 DSH 包 dsh-sandbox-windows-acl 的
 * 「Known boundaries」注释）。所以这里分开量两件事：
 *   1. DNS 通不通（`Resolve-DnsName github.com`）
 *   2. 不用凭据的公开 HTTPS 通不通（`git ls-remote` 公开仓库）
 * 两件都成 → 乙的失败不是「沙箱不给联网」，而是拿不到本机凭据；只读探测，不推任何分支、不改文件。
 *
 *   node scripts/real/l4-dsh-network.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/plnoble/OMNIX-IXAEON.git';
const work = mkdtempSync(join(tmpdir(), 'ixa-l4-net-'));
const clone = join(work, 'repo');

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
  return text.replace(/\/\/[^/\s@]+@/g, '//***@');
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args, allowFail = false) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (r.status !== 0 && !allowFail) throw new Error(mask(`git ${args.join(' ')}：${r.stderr}`));
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/** dsh 的真入口（照 L0b 的 dshBin()）：起 DeepSeek Harness.exe，带 ELECTRON_RUN_AS_NODE=1。 */
function dshBin() {
  const installs = [
    process.env.IXAEON_DSH_INSTALL?.trim(),
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ].filter((x) => x && x.trim());
  for (const install of installs) {
    const exe = join(install, 'DeepSeek Harness.exe');
    // `resources/app.asar` 在真机上是文件，cli.js 在它里面——探到这一层就够（照 bin/dsh.mjs）。
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

// 先由脚本自己（不在沙箱里）量一份对照值：公开 HTTPS 通不通、远端 main 是哪个 sha。
const reference = git(work, ['ls-remote', REPO_URL, 'refs/heads/main'], true);
const mainSha = reference.out.split(/\s+/)[0] ?? '';
git(work, ['clone', '--depth', '1', REPO_URL, clone], true);

log('== 丁：DSH 的沙箱里能不能联网（只读探测）');
log(
  `   对照（脚本自己在沙箱外量）：ls-remote 退出码 ${reference.code}｜origin/main=${mainSha.slice(0, 7)}`,
);

const promptPath = join(work, 'prompt.md');
writeFileSync(
  promptPath,
  [
    '你是开发 agent（名字 dev）。这一棒**只做只读探测，不要改任何文件、不要提交、不要推任何分支**。',
    '当前目录是一个克隆。请一条一条跑下面三条命令，把每条的原样输出（成功了什么、失败了哪一行）报出来：',
    '1. `Resolve-DnsName github.com | Select-Object -First 3`（看 DNS 通不通）',
    `2. \`git ls-remote ${REPO_URL} HEAD\`（公开 HTTPS，不需要任何凭据）`,
    `3. \`git ls-remote -c http.sslBackend=openssl ${REPO_URL} refs/heads/main\`（换掉 schannel，再试一次；只做这一次单进程参数，不要写进 git 配置）`,
    '4. `curl.exe -sS -o NUL -w "%{http_code}" --max-time 30 https://github.com`（看 TLS 到底通不通）',
    '四条都跑完再回答，每条把**原样那一行**贴出来（成功贴结果，失败贴 fatal 那行）。',
    '不要改任何配置、不要试别的绕法、不要推任何东西。最后一行输出：RELAY-DONE 1 <联网通不通的一句话结论>',
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

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
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
log(
  `   JSONL 行 ${raw.split('\n').filter(Boolean).length}｜tool_call ${calls.length} 条｜最终回答 ${finals.length} 条`,
);
// 一条条把「命令 → 原样输出」对上，客观留证（不靠模型自述）
const byId = new Map(results.map((x) => [x.callId, x]));
for (const c of calls) {
  const cmd = String(c.input?.command ?? c.input?.file_path ?? JSON.stringify(c.input ?? {}));
  const res = byId.get(c.callId);
  const out = String(res?.result ?? res?.output ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  log(`     ▶ ${mask(cmd).slice(0, 220)}`);
  log(`       ← ${mask(out).slice(0, 400) || '(空)'}`);
}
const finalText = String(finals.at(-1)?.text ?? '');
log(`   它最后说的（截 3500 字）：${mask(finalText).slice(0, 3500)}`);
log(
  `   额度字样：${/usage_limit_reached|session_limit|rate_limit_exceeded/i.test(raw) ? '出现了' : '没出现'}`,
);

let passed = true;
const check = (ok, what) => {
  log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) passed = false;
};

/** 第 n 条 pwsh 调用的原样输出（用来做客观判断，不看模型自述）。 */
const pwshOut = (n) => {
  const list = calls.filter((c) => c.tool === 'pwsh');
  const c = list[n - 1];
  const res = c ? byId.get(c.callId) : undefined;
  return String(res?.result ?? res?.output ?? '');
};

// 1. DNS
check(/\d+\.\d+\.\d+\.\d+/.test(pwshOut(1)), 'DNS 解析出了地址');
// 2. 公开 HTTPS（默认 schannel 后端）
const schannel = pwshOut(2);
check(
  /SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle failed/.test(schannel),
  '公开 HTTPS（schannel 后端）失败在拿不到凭据（不是网络不通）',
);
// 3. 换成 openssl 后端那一次
const openssl = pwshOut(3);
const opened = /[0-9a-f]{40}/i.test(openssl) || /^\s*[0-9a-f]{7,}/im.test(openssl);
log(
  `       换 openssl 后端那次：${opened ? '读到了 sha' : '仍然失败'}｜${mask(openssl).slice(0, 240)}`,
);
// 4. curl 那一次（原始 HTTP 状态码）
const curl = pwshOut(4);
log(`       curl 那次：${mask(curl).slice(0, 240)}`);
check(!/fatal|error/i.test(curl) || /\d{3}/.test(curl), 'curl 拿到了 HTTP 状态码（TLS 本身通）');
check(git(clone, ['status', '--porcelain'], true).out === '', '没改文件（工作区干净）');

log(passed ? 'RESULT 通过' : 'RESULT 没通过');
rmSync(work, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
