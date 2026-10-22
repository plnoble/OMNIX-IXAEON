/**
 * L4 真机检查「丁」（三）：沙箱里换成 OpenSSL 的 TLS 后端，HTTPS 能不能通（真调用 ≤ 3 次里的 1 次）。
 *
 * 前两次已经量清：DNS 通；git 和 curl 都在 Windows schannel 的 `SEC_E_NO_CREDENTIALS` 上断掉
 * （DSH 的受限令牌拿不到 TLS 客户端凭据）。这一次只问一件事：**绕开 schannel（改用 git 自带的
 * OpenSSL 后端）之后，HTTPS 读公开仓库成不成**——成的话，「开发推不上去」就有了一条不改权限的解法。
 * 只读：不推分支、不改配置（`-c` 是单次进程参数，`GIT_SSL_BACKEND` 只在那一行进程里设）。
 *
 *   node scripts/real/l4-dsh-openssl.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_URL = 'https://github.com/plnoble/OMNIX-IXAEON.git';
const work = mkdtempSync(join(tmpdir(), 'ixa-l4-ssl-'));
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
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
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

git(work, ['clone', '--depth', '1', REPO_URL, clone]);
log('== 丁（三）：沙箱里用 OpenSSL 后端读公开仓库');
log(
  `   对照（沙箱外）：git -c http.sslBackend=openssl ls-remote → 退出码 ${git(work, ['-c', 'http.sslBackend=openssl', 'ls-remote', REPO_URL, 'HEAD']).code}`,
);

const promptPath = join(work, 'prompt.md');
writeFileSync(
  promptPath,
  [
    '你是开发 agent（名字 dev）。这一棒**只读**：不要改任何文件/配置、不要提交、不要推任何分支。',
    '前面发现：默认后端（schannel）连 HTTPS 会报 `SEC_E_NO_CREDENTIALS`。现在只问一件事：',
    '换成 git 自带的 OpenSSL 后端，HTTPS 还能不能读公开仓库。请一条一条跑：',
    `1. \`git -c http.sslBackend=openssl ls-remote ${REPO_URL} HEAD\``,
    `2. \`git -c http.sslBackend=openssl ls-remote ${REPO_URL} refs/heads/main\``,
    `3. \`$env:GIT_SSL_BACKEND="openssl"; git ls-remote ${REPO_URL} HEAD\`（环境变量那种写法）`,
    '每条把**原样的那几行**贴出来（成功贴 sha，失败贴 fatal 行）。不要换别的绕法、不要试端口或 IP。',
    '最后一行输出：RELAY-DONE 1 <OpenSSL 后端成不成的一句话结论>',
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
const r = spawnSync(
  process.execPath,
  [launcher, dsh.exe, dsh.cli, '--profile', 'headless', '--json', `读 ${promptPath}，照里面做。`],
  { cwd: clone, encoding: 'utf8', env, windowsHide: true, timeout: 900_000 },
);
log(`   DSH 退出码 ${r.status}${r.status === null ? '（超时被杀）' : ''}`);

const parsed = `${r.stdout ?? ''}`
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
for (const c of calls) {
  const res = byId.get(c.callId);
  log(`     ▶ ${mask(String(c.input?.command ?? '')).slice(0, 200)}`);
  log(`       ← ${mask(String(res?.result ?? '').replace(/\s+/g, ' ')).slice(0, 300) || '(空)'}`);
}
log(`   它最后说的：${mask(String(finals.at(-1)?.text ?? '')).slice(0, 2000)}`);
log(
  `   额度字样：${/usage_limit_reached|rate_limit_exceeded/i.test(`${r.stdout ?? ''}`) ? '出现了' : '没出现'}`,
);

const outs = calls
  .filter((c) => c.tool === 'pwsh')
  .map((c) => String(byId.get(c.callId)?.result ?? ''));
const gotSha = outs.some((o) => /[0-9a-f]{40}/i.test(o));
log(`  ${gotSha ? '✓' : '✗'} 沙箱里用 OpenSSL 后端读到了公开仓库的 sha`);
log(
  `  ${outs.every((o) => !/SEC_E_NO_CREDENTIALS/.test(o)) ? '✓' : '✗'} 这一次没有再出现 schannel 的凭据报错`,
);
log(`  ${git(clone, ['status', '--porcelain']).out === '' ? '✓' : '✗'} 没改文件（工作区干净）`);

rmSync(work, { recursive: true, force: true });
process.exit(gotSha ? 0 : 1);
