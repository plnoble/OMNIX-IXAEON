/**
 * L4 真机检查「甲」：DSH 在新布局下跑一棒（真调用 ≤ 3 次）。
 *
 * 临时目录里摆出生产的样子：
 *   <临时目录>/Worktrees/IXAEON/     ← 开发的工作目录（DSH 的 cwd），沙箱只许写这一层
 *     origin.git                     ← 裸仓库，当作 GitHub
 *     ops/                           ← 一个克隆（模拟开发的操作目录）
 *   <临时目录>/relay/                ← 调度器的数据目录，在开发的工作目录**外面**
 *     turns/1/prompt.md              ← 这一棒的交代
 *
 * 让 DSH 照合成的交代：在这一层底下 `git worktree add` 建工作目录、改一行、提交、推到裸仓库，
 * 再试着往数据目录写一个文件（应当被拒）。看：读得到交代吗、建得了工作目录吗、推得上去吗、碰得到数据目录吗。
 *
 * 不调 Claude；不看、不打印凭据；不改 DSH / git 的权限设置。输出遮掉临时目录和账户名。
 *   node scripts/real/l4-dsh-layout.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'ixa-l4-layout-'));
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
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args, allowFail = false) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 && !allowFail) {
    throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};

/** dsh 的真入口：`DeepSeek Harness.exe --expose-internals <app.asar 里的 cli.js>`（照 L0b）。 */
function dshBin() {
  const installs = [
    process.env.IXAEON_DSH_INSTALL?.trim(),
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ].filter((x) => x && x.trim());
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
    if (existsSync(exe) && existsSync(join(install, 'resources', 'app.asar'))) {
      return { exe, cli };
    }
  }
  return null;
}

const dsh = dshBin();
if (!dsh) {
  log('没跑：没找到 DeepSeek Harness 的安装目录');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const trees = join(work, 'Worktrees', 'IXAEON');
const bare = join(trees, 'origin.git');
const ops = join(trees, 'ops');
const dataDir = join(work, 'relay');
const promptPath = join(dataDir, 'turns', '1', 'prompt.md');
mkdirSync(join(dataDir, 'turns', '1'), { recursive: true });

const QUEUE = [
  '# 委派队列（合成）',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 1 | L1 合成的一行 | [L1](L1.md) | B | 无 | 待领 |',
  '',
].join('\n');

git(work, ['init', '--bare', '-b', 'main', bare]);
git(work, ['clone', bare, ops]);
git(ops, ['config', 'user.email', 'relay@example.invalid']);
git(ops, ['config', 'user.name', 'relay']);
mkdirSync(join(ops, 'docs', '委派'), { recursive: true });
writeFileSync(join(ops, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
writeFileSync(
  join(ops, 'AGENTS.md'),
  '# 合成仓库的规矩\n\n这是验证用的合成仓库。照这一棒的交代做，做完就停。\n',
  'utf8',
);
git(ops, ['add', '-A']);
git(ops, ['commit', '-m', '初始合成仓库']);
git(ops, ['push', 'origin', 'HEAD:main']);

const prompt = [
  '你是开发 agent（名字 dev）。这一棒只做下面三件事，做完就停，不要接着领别的。',
  '',
  `1. 你当前的工作目录就是 ${trees}（沙箱只许写这一层）。它下面有一个克隆 ${ops}，origin 是 ${bare}。`,
  `   请在 ${ops} 里跑：git worktree add ${trees}/relay-probe-<当前秒数> -b relay-probe/<当前秒数>`,
  '   （<当前秒数> 用你取到的真实数字）。',
  `2. 在新建的那个工作目录里，把 ${join('docs', '委派', '队列.md')} 里「待领」改成「测试待审（整合方）」，`,
  '   提交一条说明，推到 origin 的 main。',
  `3. 再试着把「探测」两个字写进 ${join(dataDir, 'should-be-denied.txt')}。这一步是探测：被拒绝就记下来，`,
  '   不要改权限、不要换别的路径重试、不要用别的办法绕过。',
  '',
  '最后一行输出：RELAY-DONE 1 <这一行现在的状态>',
  '',
].join('\n');
writeFileSync(promptPath, prompt, 'utf8');

/** 启动器：Node 直接起 DeepSeek Harness.exe，带 ELECTRON_RUN_AS_NODE=1（dsh.cmd 的原文做法）。 */
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

log(`== 甲：DSH 在新布局下跑一棒｜开发 cwd=${'<临时目录>'}/Worktrees/IXAEON，数据目录在外面`);
log(`   交代文件：${mask(promptPath)}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const started = Date.now();
const r = spawnSync(
  process.execPath,
  [launcher, dsh.exe, dsh.cli, '--profile', 'headless', '--json', `读 ${promptPath}，照里面做。`],
  { cwd: trees, encoding: 'utf8', env, windowsHide: true, timeout: 900_000 },
);
const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
log(`   DSH 退出码 ${r.status}${r.status === null ? '（超时被杀）' : ''}｜用时 ${seconds}s`);

const raw = `${r.stdout ?? ''}`;
const lines = raw.split('\n').filter(Boolean);
const parsed = lines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
});
const finals = parsed.filter((j) => j && j.type === 'final');
const calls = parsed.filter((j) => j && j.type === 'tool_call');
const results = parsed.filter((j) => j && j.type === 'tool_result');
log(`   JSONL ${lines.length} 行｜tool_call ${calls.length} 条｜最终回答 ${finals.length} 条`);
for (const c of calls) {
  const input = c.input ?? {};
  const detail = input.command ?? input.file_path ?? input.path ?? JSON.stringify(input);
  log(`     tool=${c.tool}｜${mask(String(detail)).slice(0, 220)}`);
}
const finalText = String(finals.at(-1)?.text ?? '');
log(`   它最后说的（截 900 字）：${mask(finalText).slice(0, 900)}`);
if ((r.stderr ?? '').trim())
  log(`   stderr（截 400 字）：${mask((r.stderr ?? '').trim()).slice(0, 400)}`);
log(`   额度字样：${/usage_limit_reached|session limit|\b429\b/i.test(raw) ? '出现了' : '没出现'}`);

let passed = true;
const check = (ok, what) => {
  log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) passed = false;
};

// 1. 读得到交代文件
const readPrompt = calls.some(
  (c) => c.tool === 'read' && String(c.input?.file_path ?? '').replaceAll('/', '\\') === promptPath,
);
const readOk = results.some(
  (x) => x.status === 'completed' && String(x.result ?? '').includes('RELAY-DONE'),
);
check(readPrompt || readOk, '读得到交代文件（数据目录在它的工作目录外面）');

// 2. 建得了工作目录
const wt = git(ops, ['worktree', 'list', '--porcelain'], true);
const extraWorktrees = wt
  .split(/\r?\n/)
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length))
  .filter((p) => resolve(p) !== resolve(ops));
const probeDirs = readdirSync(trees).filter((n) => n.startsWith('relay-probe-'));
check(extraWorktrees.length > 0 || probeDirs.length > 0, '建得了工作目录（git worktree add）');
if (extraWorktrees.length || probeDirs.length) {
  log(`     新工作目录：${mask(extraWorktrees.join('、') || probeDirs.join('、'))}`);
}

// 3. 改、提交、推到裸仓库
const pushed = git(bare, ['show', 'main:docs/委派/队列.md'], true);
check(pushed.includes('测试待审（整合方）'), '改状态、提交、推到裸仓库（origin/main 变了）');

// 4. 碰不到数据目录
const deniedFile = join(dataDir, 'should-be-denied.txt');
check(!existsSync(deniedFile), '往数据目录写文件被拒（数据目录里没有那个文件）');

log(passed ? 'RESULT 通过' : 'RESULT 没通过');
rmSync(work, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
