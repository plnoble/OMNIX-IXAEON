/**
 * L0b「丙」：Codex 按会话号续（补 L0 的第 5 问）——
 * 第一次 `codex exec` 让它记住一个合成的词，第二次 `codex exec resume <thread_id>` 问它那个词，
 * 看能不能记得（L0 那次用 `resume --last` 续错了会话）。
 *
 * 这一条会真调两次模型（规格允许：Codex 不超过 4 次）。
 * 用**默认配置目录**（`codex exec` 的登录凭据在那里；不复制、不读任何凭据文件），
 * 工作目录是一次性的临时目录、内容是合成的。
 *
 *   node scripts/real/l0b-codex-resume.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
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
const exe = withVersion.at(-1).p;

const word = 'zq7k';
const work = join(homedir(), 'ixa-l0b-scratch', 'resume-work');
mkdirSync(work, { recursive: true });

const run = (label, args) => {
  const t0 = Date.now();
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
    cwd: work,
  });
  const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  console.log(
    `== ${label}：exit=${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`,
  );
  const lines = mask(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of lines.slice(0, 4)) console.log(`   ${l.slice(0, 300)}`);
  const agentTexts = [...text.matchAll(/"type":"agent_message","text":"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => m[1],
  );
  console.log(
    `   模型说的话：${agentTexts.length ? agentTexts.map((t) => JSON.stringify(t)).join('、') : '(没有)'}`,
  );
  return { status: r.status, text, agentTexts };
};

console.log(`== 用哪个 codex：${withVersion.at(-1).v}｜工作目录：${work}`);
console.log(`== 第一次：让它记住一个合成的词`);
const first = run('exec（第一次）', [
  'exec',
  '--json',
  '--skip-git-repo-check',
  `记住这个合成的词：${word}。只回三个字母：OK`,
]);
const threadId =
  (first.text.match(/"thread_id"\s*:\s*"([^"]+)"/) ?? [])[1] ??
  (first.text.match(/"threadId"\s*:\s*"([^"]+)"/) ?? [])[1] ??
  (first.text.match(/"session_id"\s*:\s*"([^"]+)"/) ?? [])[1];
console.log(`   拿到的会话号：${threadId ?? '(没找到)'}`);
console.log(`   第一次输出里的 JSON 事件类型：`);
const types = [...first.text.matchAll(/"type":"([a-z_.]+)"/g)].map((m) => m[1]);
for (const t of [...new Set(types)]) console.log(`     ${t}`);

if (!threadId) {
  console.log('RESULT 没拿到会话号，第二次没法按号续（把第一次的原样输出贴进交付说明）');
  process.exit(1);
}

console.log(`== 第二次：按会话号续，问它那个词`);
const second = run('exec resume <thread_id>（第二次）', [
  'exec',
  '--json',
  '--skip-git-repo-check',
  'resume',
  threadId,
  `我刚才让你记住的那个合成的词是什么？只回那个词`,
]);

const remembered = second.agentTexts.some((t) => t.includes(word));
console.log(
  `RESULT ${remembered ? '通过' : '没通过'}：按会话号续的那次${remembered ? '记得' : '没记得'}第一次给的那个词（${word}）`,
);
process.exit(remembered ? 0 : 1);
