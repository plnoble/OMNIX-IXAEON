#!/usr/bin/env node
/**
 * 委派流水线 v2：用 Codex 审一个任务分支。A 档自己合并之前必须过这一关（见 AGENTS.md）。
 *
 * 用法（在任务的工作目录里、任务分支上）：
 *   node scripts/codex-review.mjs <任务号>            审查并把结论写进 docs/委派/交付/<任务号>-Codex审查.md
 *   node scripts/codex-review.mjs <任务号> --dry-run  只打印会用哪个 Codex、审哪份委派单、上下文多大，不调用
 *   node scripts/codex-review.mjs <任务号>b --base <第一支的分支>
 *       一个任务拆成两支交时审第二支：只看第二支相对第一支的改动；规格用第一支的（找不到
 *       <任务号>b-*.md 时自动用 <任务号>-*.md，不用另写一份）
 *
 * - Codex 命令行：环境变量 CODEX_BIN 优先；否则在 Codex 桌面版自带的
 *   %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe 里找版本最新的（桌面版一更新，目录名就变）；
 *   都没有就用 PATH 上的 codex。旧版读不懂新版写的 config.toml，所以要挑最新的。
 * - **审查要的东西全由脚本喂进去**（委派单、AGENTS.md、交付说明、完整 diff，走标准输入），
 *   不让 Codex 自己跑命令：本机 Codex 的 Windows 沙箱会报 helper_sandbox_lock_failed，
 *   不开沙箱又等于让它能改任何东西（2026-09-19 R1/R2/W1b 三单因此卡住）。
 * - 退出码：0 结论「可以合并」；1「需要修改」；2 结论不明或审查者出错；3 Codex 额度用完、
 *   又没配替补审查（或者替补也撞额度）——分支先等着，稍后重跑。
 * - Codex 额度用完时改用调度器配置里的**替补审查**（K9a，不再找 Claude）：`<数据目录>/config.json`
 *   的 `roles.reviewer`（`{ argv, label, timeoutSeconds? }`；argv 写法和 roles.developer 一样，
 *   含 `{prompt_file}` 占位）。同一份上下文和 prompt 写进提示文件，结论写同一个文件，开头注明
 *   是替补审查代审；替补在一个临时、只读用途的 git worktree 里跑，跑完删掉。
 *   数据目录 = IXAEON_RELAY_DIR，否则 ~/.ixaeon/relay。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
const baseAt = flags.indexOf('--base');
const base = baseAt >= 0 ? flags[baseAt + 1] : null;
if (!id || (baseAt >= 0 && !base)) {
  console.error('用法：node scripts/codex-review.mjs <任务号> [--dry-run] [--base <第一支的分支>]');
  process.exit(2);
}

/**
 * 起一个审查命令行。`CODEX_BIN` / 替补 argv[0] 指向 `.mjs` / `.js` 替身时经
 * `process.execPath` 起（本机没有对应的可执行文件也能用测试替身）。
 */
const runBin = (bin, args, options) => {
  const script = /\.(?:mjs|js)$/i.test(bin);
  return spawnSync(script ? process.execPath : bin, script ? [bin, ...args] : args, {
    windowsHide: true,
    ...options,
  });
};

/** 只杀自己拉起的那一棵（照 packages/relay/src/run-turn.ts）。 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* 已经退了 */
  }
}

/**
 * 从替补的输出里取出给人看的审查文字：DSH `--json` 的 `final.text`、整行 JSON 的
 * `result` 字段，普通文字照原样；工具调用、工具结果、思考这些 JSON 事件不算。
 */
function reviewTextOf(stdout) {
  const chunks = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        if (j.type === 'final' && typeof j.text === 'string') {
          chunks.push(j.text);
          continue;
        }
        if (j.type === 'result' && typeof j.result === 'string') {
          chunks.push(j.result);
          continue;
        }
        if (typeof j.type === 'string') continue;
      } catch {
        /* 不是 JSON 就当普通文字 */
      }
    }
    chunks.push(raw);
  }
  return chunks.join('\n').trim();
}

/** 最后一个「结论：可以合并 / 需要修改」行：0 / 1；认不出返回 null。 */
function conclusionOf(text) {
  for (const raw of text.split('\n').reverse()) {
    const line = raw.trim();
    if (line.includes('结论：可以合并')) return 0;
    if (line.includes('结论：需要修改')) return 1;
  }
  return null;
}

/** 异步起替补审查（要能在超时的时候杀掉整棵进程树，spawnSync 做不到）。 */
function runReviewer(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const script = /\.(?:mjs|js)$/i.test(argv[0]);
    const child = spawn(
      script ? process.execPath : argv[0],
      script ? [argv[0], ...argv.slice(1)] : argv.slice(1),
      {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, out, err, timedOut, error: error ?? null });
    };
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      err += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // 进程树万一没杀干净（taskkill 失败、进程卡在不可中断状态），别让脚本一直等。
      killTimer = setTimeout(() => finish(null, 'timeout-kill'), 5000);
    }, timeoutMs);
    child.on('close', (code) => finish(code));
    child.on('error', (e) => finish(null, e.message));
  });
}

function version(bin) {
  const r = runBin(bin, ['--version'], { encoding: 'utf8' });
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
const orderOf = (taskId) =>
  readdirSync(orderDir).find((f) => f.startsWith(`${taskId}-`) && f.endsWith('.md'));
// 拆出来的第二支（U3b / G1eb）没有自己的规格：往前退字母，用第一支的（U3 / G1e / G1）
const findOrder = (taskId) => {
  for (let t = taskId; t.length > 0; t = t.slice(0, -1)) {
    const hit = orderOf(t);
    if (hit) return hit;
    if (!/[a-z]$/.test(t)) return undefined;
  }
  return undefined;
};
const order = findOrder(id);
if (!order) {
  console.error(`在 docs/委派/ 下找不到 ${id}-*.md（委派单或规格）`);
  process.exit(2);
}
const orderPath = relative(root, join(orderDir, order)).replace(/\\/g, '/');
const codex = findCodex();

// 审查兜底（K9a）：Codex 额度用完时用调度器配置里的替补审查（roles.reviewer）。
// 数据目录的规矩和 packages/relay/src/datadir.ts 一样：IXAEON_RELAY_DIR，否则 ~/.ixaeon/relay。
// 配置读不到、不是 JSON、没有这个字段，都当作没有；只取额度字样（沿用 L17）和替补两样。
function readRelayConfig() {
  const envDir = process.env.IXAEON_RELAY_DIR?.trim();
  const dataDir = envDir ? resolve(envDir) : join(homedir(), '.ixaeon', 'relay');
  try {
    return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}
const relayConfig = readRelayConfig();
const integrator = relayConfig?.roles?.integrator;
const quotaPatterns = Array.isArray(integrator?.quotaPatterns)
  ? integrator.quotaPatterns.filter((p) => typeof p === 'string' && p.length > 0)
  : ['usage_limit_reached', 'session limit'];
const reviewer = relayConfig?.roles?.reviewer;
const reviewerArgv =
  Array.isArray(reviewer?.argv) &&
  reviewer.argv.length > 0 &&
  reviewer.argv.every((a) => typeof a === 'string' && a.length > 0)
    ? reviewer.argv
    : null;
const reviewerLabel =
  typeof reviewer?.label === 'string' && reviewer.label.trim()
    ? reviewer.label.trim()
    : '（没写标签）';
const reviewerTimeoutSeconds =
  typeof reviewer?.timeoutSeconds === 'number' &&
  Number.isFinite(reviewer.timeoutSeconds) &&
  reviewer.timeoutSeconds > 0
    ? reviewer.timeoutSeconds
    : 1200;

// 审查的上下文：委派单、AGENTS.md、交付说明、完整 diff（审查记录本身不算改动）
git(['fetch', 'origin', 'main', '--quiet']);
// 第二支只看它自己的改动：相对第一支的分支，不是相对 main（不然第一支的改动又算一遍）
const range = `${base ?? 'origin/main'}...HEAD`;
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
  `你在审查一个委派任务分支。任务 ${id}。审查需要的全部内容都在下面的 <stdin> 里：委派单或规格、仓库的 AGENTS.md、执行方的交付说明、这个分支相对 ${base ?? 'origin/main'} 的完整改动${base ? `（这是任务拆出来的第二支，第一支 ${base} 另外审，这里只看第二支自己的改动）` : ''}。`,
  '**不要运行任何命令，也不要去读别的文件**（本机沙箱不可用，命令会失败）；只根据给你的这些内容审。改动里看不到、又必须知道的上下文，就在结论里写「需要人工确认：……」。',
  '**只读审查**：不许改任何文件、不许提交、不许推送；只根据给你的这些内容写结论。',
  '对照委派单（或规格）和 AGENTS.md 检查：',
  '1. 委派单或规格里的每条契约与验收条件是否都做到了；测试是否真的覆盖了这些条件，有没有漏掉、放宽，或者只是让测试通过；',
  '2. 会出错的地方：边界情况、并发、错误处理、性能（大文件、长列表、同步阻塞主进程）；',
  '3. 隐私：有没有把真实数据、个人信息、密钥、网关地址写进代码、测试、文档；有没有把用户数据发给新的外部服务；',
  '4. 交付说明是否如实：规格要求的真机检查有没有跑、输出贴没贴；',
  '5. 违反仓库约定的地方（迁移只由整合方写、已经在 main 上的锁定验收测试不许改、公开仓库等）。这个分支自己新写、还没并入 main 的验收测试，执行方按审查意见补条件、改严并重新锁定是允许的，不算违反；删条件、放宽才算。',
  '「必须改」只用于：规格的契约或验收条件没做到；现实里会出错的问题；隐私；交付说明不实；违反仓库约定。规格没有要求的加固、只有在刻意构造的条件下才会发生的情况，写成「建议」，不要写成「必须改」。',
  '用中文回答。只列真正的问题，每条一行，写明「必须改」或「建议」、文件与行号（按 diff 里的行号）、为什么。没有问题就写「没有发现问题」。',
  '最后一行只写「结论：可以合并」（没有「必须改」的问题时）或「结论：需要修改」。',
].join('\n');

if (dryRun) {
  console.log(`Codex：${codex}（${(version(codex) ?? ['?']).join('.')}）`);
  console.log(`替补审查：${reviewerArgv ? reviewerLabel : '没配（Codex 额度用完会退 3）'}`);
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
const r = runBin(codex, ['exec', '-s', 'read-only', '-C', root, '-o', lastMessage, prompt], {
  input: context,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  timeout: 45 * 60 * 1000,
});
const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
let review = existsSync(lastMessage) ? readFileSync(lastMessage, 'utf8').trim() : '';
rmSync(scratch, { recursive: true, force: true });

let viaSubstitute = false;
if (/usage limit|rate limit/i.test(log) && !review) {
  if (!reviewerArgv) {
    console.error(
      'Codex 额度用完、没配替补审查：分支先等着，队列状态改「待审（Codex 额度）」，稍后重跑。',
    );
    const tail = log
      .split('\n')
      .filter((l) => /limit|try again/i.test(l))
      .slice(-2);
    if (tail.length > 0) console.error(tail.join('\n'));
    process.exit(3);
  }

  console.error(`Codex 额度用完，改用替补审查（${reviewerLabel}）`);
  const scratch = mkdtempSync(join(tmpdir(), `ixaeon-substitute-review-${id}-`));
  const worktree = join(scratch, 'worktree');
  const promptFile = join(worktree, '.ixaeon-review-prompt.md');
  try {
    const added = git(['worktree', 'add', '--detach', worktree, 'HEAD']);
    if (added.status !== 0) {
      console.error(
        `替补审查：建临时 worktree 失败（${added.stderr?.trim() || added.stdout?.trim() || '未知错误'}）。`,
      );
      process.exitCode = 2;
    } else {
      // 提示文件放在临时 worktree 里：替补的沙箱只保证读得到自己的 cwd；被审的工作目录不碰。
      writeFileSync(promptFile, `${prompt}\n\n${context}`, 'utf8');
      const argv = reviewerArgv.map((a) =>
        a.split('{prompt_file}').join(promptFile).split('{relay_root}').join(root),
      );
      const sr = await runReviewer(argv, worktree, reviewerTimeoutSeconds * 1000);
      const hay = `${sr.out}\n${sr.err}`;
      if (sr.timedOut) {
        console.error(
          `替补审查超时（${reviewerTimeoutSeconds} 秒），已结束它：分支先等着，队列状态改「待审（Codex 额度）」，稍后重跑。`,
        );
        console.error(hay.split('\n').filter(Boolean).slice(-5).join('\n'));
        process.exitCode = 2;
      } else if (quotaPatterns.some((p) => hay.toLowerCase().includes(p.toLowerCase()))) {
        console.error(
          '替补审查也撞额度了：分支先等着，队列状态改「待审（Codex 额度）」，稍后重跑。',
        );
        process.exitCode = 3;
      } else if (sr.error) {
        console.error(`替补审查起不来（${sr.error}）。`);
        process.exitCode = 2;
      } else {
        review = reviewTextOf(sr.out);
        if (!review || conclusionOf(review) === null) {
          console.error(`替补审查没有给出结论（退出码 ${sr.code ?? 'null'}）。最后几行输出：`);
          console.error(hay.split('\n').filter(Boolean).slice(-15).join('\n'));
          process.exitCode = 2;
        } else {
          viaSubstitute = true;
        }
      }
    }
  } finally {
    // 替补改了、新建了什么，都只在临时副本里；连 worktree 一起删掉（被审的工作目录一个字不动）。
    git(['worktree', 'remove', '--force', worktree]);
    rmSync(scratch, { recursive: true, force: true });
    git(['worktree', 'prune']);
  }
  if (process.exitCode) process.exit(process.exitCode);
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
const meta = viaSubstitute
  ? [
      `- 时间：${new Date().toISOString()}`,
      `- 分支：${branch}（${head}），对照 ${orderPath}`,
      `- 审查者：替补审查（${reviewerLabel}）；上下文由脚本喂入（不让审查者跑命令）；在临时 worktree 里跑，被审的工作目录没动${truncated ? '；diff 太长已截断' : ''}`,
    ]
  : [
      `- 时间：${new Date().toISOString()}`,
      `- 分支：${branch}（${head}），对照 ${orderPath}`,
      `- Codex：${(version(codex) ?? ['?']).join('.')}；上下文由脚本喂入（不让 Codex 跑命令）${truncated ? '；diff 太长已截断' : ''}`,
    ];
writeFileSync(
  outFile,
  [
    viaSubstitute
      ? `# ${id} 审查（Codex 额度用完，由替补审查代审（${reviewerLabel}））`
      : `# ${id} Codex 审查`,
    '',
    ...meta,
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
// 替补按契约认「输出里最后一个结论行」；Codex 照旧只认最后一行。
const verdict = viaSubstitute
  ? conclusionOf(review)
  : last.includes('结论：可以合并')
    ? 0
    : last.includes('结论：需要修改')
      ? 1
      : null;
if (verdict === 0) process.exit(0);
if (verdict === 1) process.exit(1);
console.error('最后一行不是约定的结论格式，按「结论不明」处理：请人工看一眼。');
process.exit(2);
