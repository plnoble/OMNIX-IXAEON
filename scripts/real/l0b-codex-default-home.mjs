/**
 * L0b「丁-4」：提权装完之后，**用户自己的 `~/.codex`**（默认配置目录）跑一次
 * `codex exec -s workspace-write`（只回一句话、不改文件），看 L0 报过的
 * `helper_sandbox_lock_failed: lock sandbox bin dir …\.codex\.sandbox-bin failed` 还在不在。
 *
 * 只看、不修：不改用户的 `~/.codex`（这一步是用默认目录跑，Codex 自己会往它状态文件里写东西，那是它本来的行为）。
 * 这一条会真调一次模型（规格允许：Codex 不超过 4 次）。
 *
 *   node scripts/real/l0b-codex-default-home.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
  const r = spawnSync(p, ['--version'], { encoding: 'utf8', windowsHide: true });
  const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return { p, v: m ? m[1] : '0.0.0' };
});
withVersion.sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
const { p: exe, v: version } = withVersion.at(-1);

const binDir = join(homedir(), '.codex', '.sandbox-bin');
const snapshot = () => {
  try {
    return readdirSync(binDir)
      .map((n) => {
        try {
          const st = statSync(join(binDir, n));
          return `${n} (${st.size} bytes, ${new Date(st.mtimeMs).toISOString()})`;
        } catch {
          return n;
        }
      })
      .join('、');
  } catch {
    return '(读不到这个目录)';
  }
};

const work = join(homedir(), 'ixa-l0b-scratch', 'exec-default-home');
mkdirSync(work, { recursive: true });

console.log(`== 用哪个 codex：${version}`);
console.log(`== 跑之前 ~/.codex/.sandbox-bin：${mask(snapshot())}`);
console.log(`== 跑 codex exec -s workspace-write（默认配置目录，一次真调用）`);
const t0 = Date.now();
const r = spawnSync(
  exe,
  ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '只回三个字母：OK'],
  { encoding: 'utf8', timeout: 600_000, windowsHide: true, cwd: work },
);
const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
console.log(`   exit=${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`);
const interesting = text
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('{'))
  .slice(0, 20);
console.log(`   非 JSON 的输出行：`);
for (const l of interesting) console.log(`     ${l}`);
console.log(`   和 .sandbox-bin 加锁有关的行：`);
const lockLines = text
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /sandbox-bin|helper_sandbox_lock|沙箱|sandbox/i.test(l))
  .slice(0, 10);
for (const l of lockLines.length ? lockLines : ['（没有）'])
  console.log(`     ${mask(l).slice(0, 400)}`);
const lastJson = text
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('{'))
  .slice(-2);
console.log(`   最后两条 JSON 事件（截断到 300 字）：`);
for (const l of lastJson) console.log(`     ${mask(l).slice(0, 300)}`);
console.log(`== 跑之后 ~/.codex/.sandbox-bin：${mask(snapshot())}`);
const stillFails = /helper_sandbox_lock_failed|lock sandbox bin dir/.test(text);
console.log(
  `RESULT ${r.status === 0 ? '这次成功了' : `退出码 ${r.status}`}：L0 报过的「.sandbox-bin 加锁失败」${
    stillFails ? '还在' : '这次没出现'
  }`,
);
process.exit(r.status === 0 ? 0 : 1);
