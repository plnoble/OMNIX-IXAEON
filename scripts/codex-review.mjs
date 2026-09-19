#!/usr/bin/env node
/**
 * 委派流水线 v2：用 Codex 审一个任务分支。A 档自己合并之前必须过这一关（见 AGENTS.md）。
 *
 * 用法（在任务的工作目录里、任务分支上）：
 *   node scripts/codex-review.mjs <任务号>            审查并把结论写进 docs/委派/交付/<任务号>-Codex审查.md
 *   node scripts/codex-review.mjs <任务号> --dry-run  只打印会用哪个 Codex、审哪份委派单、上下文多大，不调用
 *
 * - Codex 命令行：环境变量 CODEX_BIN 优先；否则在 Codex 桌面版自带的
 *   %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe 里找版本最新的（桌面版一更新，目录名就变）；
 *   都没有就用 PATH 上的 codex。旧版读不懂新版写的 config.toml，所以要挑最新的。
 * - **审查要的东西全由脚本喂进去**（委派单、AGENTS.md、交付说明、完整 diff，走标准输入），
 *   不让 Codex 自己跑命令：本机 Codex 的 Windows 沙箱会报 helper_sandbox_lock_failed，
 *   不开沙箱又等于让它能改任何东西（2026-09-19 R1/R2/W1b 三单因此卡住）。
 * - 退出码：0 结论「可以合并」；1「需要修改」；2 结论不明或 Codex 出错；3 Codex 额度用完（分支先等着，稍后重跑）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
if (!id) {
  console.error('用法：node scripts/codex-review.mjs <任务号> [--dry-run]');
  process.exit(2);
}

function version(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const base = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const candidates = [];
  if (process.env.LOCALAPPDATA && existsSync(base)) {
    if (existsSync(join(base, 'codex.exe'))) candidates.push(join(base, 'codex.exe'));
    for (const d of readdirSync(base)) {
      const p = join(base, d, 'codex.exe');
      if (existsSync(p)) candidates.push(p);
    }
  }
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let best = null;
  for (const bin of candidates) {
    const v = version(bin);
    if (v && (!best || cmp(v, best.v) > 0)) best = { bin, v };
  }
  return best?.bin ?? 'codex';
}

const git = (args) =>
  spawnSync('git', args, {
    encoding: 'utf8',
    cwd: root,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });

const orderDir = join(root, 'docs', '委派');
const order = readdirSync(orderDir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.md'));
if (!order) {
  console.error(`在 docs/委派/ 下找不到 ${id}-*.md（委派单或规格）`);
  process.exit(2);
}
const orderPath = relative(root, join(orderDir, order)).replace(/\\/g, '/');
const codex = findCodex();

// 审查的上下文：委派单、AGENTS.md、交付说明、完整 diff（审查记录本身不算改动）
git(['fetch', 'origin', 'main', '--quiet']);
const range = 'origin/main...HEAD';
const exclude = [':(exclude)pnpm-lock.yaml', `:(exclude)docs/委派/交付/${id}-Codex审查.md`];
const stat = git(['diff', '--stat', range, '--', '.', ...exclude]).stdout.trim();
let diff = git(['diff', '-U12', range, '--', '.', ...exclude]).stdout;
if (!diff.trim()) {
  console.error(`分支相对 origin/main 没有改动（${range}），没什么可审。`);
  process.exit(2);
}
const MAX_DIFF = 400_000;
const truncated = diff.length > MAX_DIFF;
if (truncated) diff = diff.slice(0, MAX_DIFF);
const readIf = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
const delivery = readIf(`docs/委派/交付/${id}.md`);
const context = [
  `=== 委派单或规格：${orderPath} ===`,
  readFileSync(join(orderDir, order), 'utf8'),
  '=== AGENTS.md（仓库规则，尤其「用户的原则」「委派流水线 v2」）===',
  readIf('AGENTS.md') ?? '（没有）',
  `=== 交付说明：docs/委派/交付/${id}.md ===`,
  delivery ?? '（没有交付说明——这本身就是一个「必须改」）',
  `=== 改动文件（git diff --stat ${range}）===`,
  stat,
  `=== 完整改动（git diff -U12 ${range}）${truncated ? '：太长，只给了前 40 万字，后面的没审到，结论里要写明' : ''} ===`,
  diff,
].join('\n\n');

const prompt = [
  `你在审查一个委派任务分支。任务 ${id}。审查需要的全部内容都在下面的 <stdin> 里：委派单或规格、仓库的 AGENTS.md、执行方的交付说明、这个分支相对 origin/main 的完整改动。`,
  '**不要运行任何命令，也不要去读别的文件**（本机沙箱不可用，命令会失败）；只根据给你的这些内容审。改动里看不到、又必须知道的上下文，就在结论里写「需要人工确认：……」。',
  '对照委派单（或规格）和 AGENTS.md 检查：',
  '1. 委派单或规格里的每条契约与验收条件是否都做到了；测试是否真的覆盖了这些条件，有没有漏掉、放宽，或者只是让测试通过；',
  '2. 会出错的地方：边界情况、并发、错误处理、性能（大文件、长列表、同步阻塞主进程）；',
  '3. 隐私：有没有把真实数据、个人信息、密钥、网关地址写进代码、测试、文档；有没有把用户数据发给新的外部服务；',
  '4. 交付说明是否如实：规格要求的真机检查有没有跑、输出贴没贴；',
  '5. 违反仓库约定的地方（迁移只由整合方写、锁定的验收测试不许改、公开仓库等）。',
  '用中文回答。只列真正的问题，每条一行，写明「必须改」或「建议」、文件与行号（按 diff 里的行号）、为什么。没有问题就写「没有发现问题」。',
  '最后一行只写「结论：可以合并」（没有「必须改」的问题时）或「结论：需要修改」。',
].join('\n');

if (dryRun) {
  console.log(`Codex：${codex}（${(version(codex) ?? ['?']).join('.')}）`);
  console.log(`委派单：${orderPath}`);
  console.log(`仓库：${root}`);
  console.log(
    `上下文：${context.length} 字（diff ${diff.length} 字${truncated ? '，已截断' : ''}）；交付说明：${delivery ? '有' : '没有'}`,
  );
  process.exit(0);
}

const scratch = join(tmpdir(), `ixaeon-codex-review-${id}-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const lastMessage = join(scratch, 'last.md');
const r = spawnSync(codex, ['exec', '-s', 'read-only', '-C', root, '-o', lastMessage, prompt], {
  input: context,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 256 * 1024 * 1024,
  timeout: 45 * 60 * 1000,
});
const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const review = existsSync(lastMessage) ? readFileSync(lastMessage, 'utf8').trim() : '';
rmSync(scratch, { recursive: true, force: true });

if (/usage limit|rate limit/i.test(log) && !review) {
  console.error('Codex 额度用完：分支先等着，队列状态改「待审（Codex 额度）」，稍后重跑。');
  console.error(
    log
      .split('\n')
      .filter((l) => /limit|try again/i.test(l))
      .slice(-2)
      .join('\n'),
  );
  process.exit(3);
}
if (!review) {
  console.error(`Codex 没有给出结论（退出码 ${r.status ?? r.error?.message}）。最后几行输出：`);
  console.error(log.split('\n').slice(-15).join('\n'));
  process.exit(2);
}

const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const outDir = join(root, 'docs', '委派', '交付');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${id}-Codex审查.md`);
writeFileSync(
  outFile,
  [
    `# ${id} Codex 审查`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 分支：${branch}（${head}），对照 ${orderPath}`,
    `- Codex：${(version(codex) ?? ['?']).join('.')}；上下文由脚本喂入（不让 Codex 跑命令）${truncated ? '；diff 太长已截断' : ''}`,
    '',
    review,
    '',
  ].join('\n'),
  'utf8',
);
const last =
  review
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';
console.log(review);
console.log(`\n已写入 ${relative(root, outFile)}`);
if (last.includes('结论：可以合并')) process.exit(0);
if (last.includes('结论：需要修改')) process.exit(1);
console.error('最后一行不是约定的结论格式，按「结论不明」处理：请人工看一眼。');
process.exit(2);
