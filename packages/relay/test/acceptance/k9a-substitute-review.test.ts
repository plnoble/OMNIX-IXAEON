/**
 * K9a 验收测试：Codex 没额度时改用调度器配置里的替补审查（规格「验收条件」1–8）。
 *
 * 做法照 L17：临时 git 仓库（裸仓库当 origin、main 推上去），把本仓库的
 * `scripts/codex-review.mjs` 拷进去，放一份合成规格 `docs/委派/K99-合成.md`、AGENTS.md、
 * 交付说明，切一个分支改一个文件（一处明显的 bug）并提交；Codex、替补都用 `.mjs` 替身
 * （`CODEX_BIN` / `roles.reviewer.argv`），Claude 替身只用来证明它一次都没被调用。
 * `IXAEON_RELAY_DIR` 指到临时目录。
 *
 * 逐条对应：
 * - 条件 1：Codex 替身报额度用完、`roles.reviewer` 指向替补替身（它把收到的提示文件内容
 *   存下来、输出「结论：可以合并」）→ 退 0；结论文件开头含「由替补审查代审」和 label；
 *   提示文件里有和 Codex 那次同样的审查上下文（规格、AGENTS.md、交付说明、diff）。
 * - 条件 2：同上，替身输出「结论：需要修改」→ 退 1。
 * - 条件 3：设了 `CLAUDE_BIN`、`roles.integrator.argv` 也指向 Claude 替身 → Claude 替身
 *   一次都没被调用（替身会留下调用记录，断言它是空的）。
 * - 条件 4：没配 `roles.reviewer` → 退 3，输出说「Codex 额度用完、没配替补审查」；
 *   除了 Codex 没有调用任何别的东西。
 * - 条件 5：替身在自己的工作目录里新建、改动文件 → 被审的工作目录 `git status` 前后一样；
 *   跑完 `git worktree list` 里没有临时 worktree。
 * - 条件 6：替身输出没有结论行 → 退 2；替身超过 `timeoutSeconds` → 退 2，进程被结束
 *   （替身的心跳文件不再增长）。
 * - 条件 7：替身输出里有额度用完的字样（配置里的 quotaPatterns）→ 退 3。
 * - 条件 8：Codex 没撞额度 → 替身一次都没被调用（行为和原来一样）。
 *
 * 全程不调真 Codex / 真替补，不连 GitHub；临时目录由本文件收尾删掉。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const REVIEW_SCRIPT = join(REPO, 'scripts', 'codex-review.mjs');
const TASK = 'K99';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) {
    rmSync(w.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

interface Call {
  argv: string[];
  stdin?: string;
  cwd?: string;
  prompt?: string;
}

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface World {
  root: string;
  repo: string;
  dataDir: string;
  codexStub: string;
  reviewerStub: string;
  claudeStub: string;
  reviewFile: string;
  heartbeatFile: string;
  run(): Result;
  review(): string;
  codexCalls(): Call[];
  reviewerCalls(): Call[];
  claudeCalls(): Call[];
  heartbeats(): number;
  worktrees(): string[];
  git(args: string[]): string;
}

type CodexMode = 'ok' | 'quota';
type ReviewerMode = 'merge' | 'changes' | 'other' | 'quota' | 'modify' | 'sleep';

/** Codex 替身：`--version` 打版本；其余把参数、标准输入记一行，再按模式打输出。 */
function codexStubSource(logPath: string, mode: CodexMode): string {
  return [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const MODE = ${JSON.stringify(mode)};`,
    'const argv = process.argv.slice(2);',
    "if (argv.includes('--version')) { console.log('codex-cli 9.9.9 (synthetic)'); process.exit(0); }",
    "const stdin = readFileSync(0, 'utf8');",
    'appendFileSync(LOG, JSON.stringify({ argv, stdin }) + "\\n", "utf8");',
    "if (MODE === 'ok') {",
    "  const i = argv.indexOf('-o');",
    "  if (i >= 0) writeFileSync(argv[i + 1], '没有发现问题\\n结论：可以合并\\n', 'utf8');",
    "  console.log('合成 Codex：审完了');",
    '  process.exit(0);',
    '}',
    "console.log('usage limit reached');",
    'process.exit(1);',
  ].join('\n');
}

/**
 * 替补替身：读 `{prompt_file}` 指向的提示文件（存一份下来），再按模式打输出。
 * `modify` 在自己 cwd 里新建、改动文件；`sleep` 每 150ms 往心跳文件写一个字，等着被杀。
 */
function reviewerStubSource(
  logPath: string,
  promptCopy: string,
  heartbeatFile: string,
  mode: ReviewerMode,
): string {
  return [
    "import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const COPY = ${JSON.stringify(promptCopy)};`,
    `const HEART = ${JSON.stringify(heartbeatFile)};`,
    `const MODE = ${JSON.stringify(mode)};`,
    'const argv = process.argv.slice(2);',
    "if (argv.includes('--version')) { console.log('dsh 9.9.9 (synthetic)'); process.exit(0); }",
    'const hit = argv.map((a) => /读 (.*?)，照/.exec(a)).find(Boolean);',
    'const promptPath = hit ? hit[1] : argv[argv.length - 1];',
    "let prompt = '';",
    'try { prompt = readFileSync(promptPath, "utf8"); } catch {}',
    'try { copyFileSync(promptPath, COPY); } catch {}',
    'appendFileSync(LOG, JSON.stringify({ argv, cwd: process.cwd(), prompt }) + "\\n", "utf8");',
    "if (MODE === 'merge') { console.log('没有发现问题\\n结论：可以合并'); process.exit(0); }",
    "else if (MODE === 'changes') { console.log('有一处要改\\n结论：需要修改'); process.exit(0); }",
    "else if (MODE === 'other') { console.log('没有发现问题\\n就这样吧'); process.exit(0); }",
    "else if (MODE === 'quota') { console.log('合成额度字样'); process.exit(0); }",
    "else if (MODE === 'modify') {",
    "  writeFileSync('替补新建.txt', '替身在临时副本里新建的\\n', 'utf8');",
    "  appendFileSync('合成.txt', '替补改的一行\\n', 'utf8');",
    "  console.log('没有发现问题\\n结论：可以合并');",
    '  process.exit(0);',
    '}',
    "else if (MODE === 'sleep') {",
    "  const timer = setInterval(() => appendFileSync(HEART, 'x'), 150);",
    '  setTimeout(() => { clearInterval(timer); process.exit(0); }, 30000);',
    "  console.log('还在慢慢审');",
    '}',
    "else { console.log('没有发现问题\\n结论：可以合并'); process.exit(0); }",
  ].join('\n');
}

/** Claude 替身：只要被调用就记一行；正常会打一句「可以合并」，让误用看起来像成功。 */
function claudeStubSource(logPath: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    `const LOG = ${JSON.stringify(logPath)};`,
    "if (process.argv.includes('--version')) { console.log('9.8.7 (Claude Code synthetic)'); process.exit(0); }",
    'appendFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n", "utf8");',
    "console.log(JSON.stringify({ type: 'result', is_error: false, result: '没有发现问题\\n结论：可以合并' }));",
  ].join('\n');
}

const mustGit = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${cwd}）：${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
};

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/**
 * 合成一个临时仓库 + 一份 relay 数据目录 + 三个替身。
 * `reviewer: null` = 不配 roles.reviewer；`claudeEnv` = 设 CLAUDE_BIN。
 */
function makeWorld(opts: {
  codex: CodexMode;
  reviewer?: ReviewerMode | null;
  label?: string;
  timeoutSeconds?: number;
  claudeEnv?: boolean;
}): World {
  const root = mkdtempSync(join(tmpdir(), 'ixa-k9a-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const dataDir = join(root, 'relay');
  const codexStub = join(root, 'codex-stub.mjs');
  const reviewerStub = join(root, 'reviewer-stub.mjs');
  const claudeStub = join(root, 'claude-stub.mjs');
  const codexLog = join(root, 'codex-calls.jsonl');
  const reviewerLog = join(root, 'reviewer-calls.jsonl');
  const claudeLog = join(root, 'claude-calls.jsonl');
  const promptCopy = join(root, 'reviewer-prompt.md');
  const heartbeatFile = join(root, 'reviewer-heartbeat.txt');
  mkdirSync(dataDir, { recursive: true });

  mustGit(root, ['init', '--bare', '-b', 'main', origin]);
  mustGit(root, ['clone', '-q', origin, repo]);
  mustGit(repo, ['config', 'user.email', 'relay@example.invalid']);
  mustGit(repo, ['config', 'user.name', 'relay']);
  // 中文路径不在 status 里转成八进制转义，断言才看得见（Windows 上的 git 默认会转）
  mustGit(repo, ['config', 'core.quotepath', 'false']);
  mkdirSync(join(repo, 'docs', '委派', '交付'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, 'docs', '委派', 'K99-合成.md'),
    [
      '# 规格 K99：合成的审查对象',
      '',
      '## 验收条件',
      '',
      '1. 合成规格正文：只给 codex-review.mjs 喂上下文。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(repo, 'AGENTS.md'),
    '# 合成 AGENTS.md\n\n合成规则正文：已经在 main 上的锁定验收测试不许改。\n',
    'utf8',
  );
  writeFileSync(
    join(repo, 'docs', '委派', '交付', 'K99.md'),
    '# K99 合成交付\n\n合成交付说明正文。\n',
    'utf8',
  );
  copyFileSync(REVIEW_SCRIPT, join(repo, 'scripts', 'codex-review.mjs'));
  writeFileSync(join(repo, '合成.txt'), '原始一行\n', 'utf8');
  mustGit(repo, ['add', '-A']);
  mustGit(repo, ['commit', '-q', '-m', '初始合成仓库']);
  mustGit(repo, ['push', '-q', 'origin', 'HEAD:main']);
  mustGit(repo, ['switch', '-q', '-c', 'dev/K99']);
  writeFileSync(join(repo, '合成.txt'), '原始一行\n明显的 bug：return a - b;\n', 'utf8');
  mustGit(repo, ['add', '-A']);
  mustGit(repo, ['commit', '-q', '-m', '合成：一处明显的 bug']);

  writeFileSync(codexStub, codexStubSource(codexLog, opts.codex), 'utf8');
  writeFileSync(
    reviewerStub,
    reviewerStubSource(reviewerLog, promptCopy, heartbeatFile, opts.reviewer ?? 'merge'),
    'utf8',
  );
  writeFileSync(claudeStub, claudeStubSource(claudeLog), 'utf8');

  const roles: Record<string, unknown> = {
    integrator: { argv: [claudeStub], quotaPatterns: ['合成额度字样'] },
  };
  if (opts.reviewer !== null) {
    roles.reviewer = {
      argv: [reviewerStub, '读 {prompt_file}，照里面做。'],
      label: opts.label ?? '合成替补审查',
      ...(opts.timeoutSeconds === undefined ? {} : { timeoutSeconds: opts.timeoutSeconds }),
    };
  }
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify({ roles }, null, 2)}\n`, 'utf8');

  const readCalls = (p: string): Call[] => {
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  };
  const reviewFile = join(repo, 'docs', '委派', '交付', 'K99-Codex审查.md');

  const world: World = {
    root,
    repo,
    dataDir,
    codexStub,
    reviewerStub,
    claudeStub,
    reviewFile,
    heartbeatFile,
    run: () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_BIN: codexStub,
        IXAEON_RELAY_DIR: dataDir,
      };
      delete env.CLAUDE_BIN;
      if (opts.claudeEnv) env.CLAUDE_BIN = claudeStub;
      const r = spawnSync(process.execPath, [join(repo, 'scripts', 'codex-review.mjs'), TASK], {
        cwd: repo,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    review: () => (existsSync(reviewFile) ? readFileSync(reviewFile, 'utf8') : ''),
    codexCalls: () => readCalls(codexLog),
    reviewerCalls: () => readCalls(reviewerLog),
    claudeCalls: () => readCalls(claudeLog),
    heartbeats: () => (existsSync(heartbeatFile) ? readFileSync(heartbeatFile, 'utf8').length : 0),
    worktrees: () =>
      mustGit(repo, ['worktree', 'list', '--porcelain'])
        .split(/\r?\n/)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length)),
    git: (args) => mustGit(repo, args),
  };
  worlds.push(world);
  return world;
}

const firstLine = (text: string): string => (text.split(/\r?\n/)[0] ?? '').trim();

describe('条件 1：Codex 额度用完 → 替补审查代审，结论可以合并', () => {
  it('退 0；开头有「由替补审查代审」和 label；提示文件里有同一份审查上下文', () => {
    const w = makeWorld({
      codex: 'quota',
      reviewer: 'merge',
      label: 'DSH + 合成网关/合成模型',
    });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);

    expect(w.reviewerCalls()).toHaveLength(1);
    expect(w.claudeCalls()).toHaveLength(0);

    const text = w.review();
    const head = firstLine(text);
    expect(head).toContain('由替补审查代审');
    expect(head).toContain('DSH + 合成网关/合成模型');
    expect(text).toContain('结论：可以合并');

    const codex = w.codexCalls()[0]!;
    const reviewer = w.reviewerCalls()[0]!;
    // 同一份审查上下文：替身收到的提示文件里就有 Codex 那次的标准输入全文
    expect(reviewer.prompt).toContain(codex.stdin ?? '');
    for (const marker of [
      '合成规格正文',
      '合成规则正文',
      '合成交付说明正文',
      '明显的 bug',
      '审查一个委派任务分支',
      // 规格「约束」：提示词里写明只读
      '不许改任何文件、不许提交、不许推送',
    ]) {
      expect(reviewer.prompt).toContain(marker);
    }
    // 记录里不写替身的路径、也不写临时目录
    expect(text).not.toContain(w.reviewerStub);
    expect(text).not.toContain(w.root);
  }, 60_000);
});

describe('条件 2：替补输出「结论：需要修改」→ 退 1', () => {
  it('结论文件里写着需要修改，证据是真走到了替补', () => {
    const w = makeWorld({ codex: 'quota', reviewer: 'changes' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(1);
    expect(w.review()).toContain('结论：需要修改');
    expect(w.reviewerCalls()).toHaveLength(1);
  }, 60_000);
});

describe('条件 3：设了 CLAUDE_BIN、整合方 argv 也指向 Claude → 一次都不调用', () => {
  it('替补给出结论，Claude 替身的调用记录是空的', () => {
    const w = makeWorld({ codex: 'quota', reviewer: 'merge', claudeEnv: true });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.reviewerCalls()).toHaveLength(1);
    expect(w.claudeCalls()).toHaveLength(0);
  }, 60_000);
});

describe('条件 4：没配 roles.reviewer → 退 3，不调用别的东西', () => {
  it('标准错误说「Codex 额度用完、没配替补审查」；Claude/替补都没被调用', () => {
    const w = makeWorld({ codex: 'quota', reviewer: null });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(3);
    expect(r.stderr).toContain('Codex 额度用完、没配替补审查');
    expect(w.codexCalls()).toHaveLength(1);
    expect(w.claudeCalls()).toHaveLength(0);
    expect(w.reviewerCalls()).toHaveLength(0);
    expect(w.review()).toBe('');
  }, 60_000);
});

describe('条件 5：替补只动临时 worktree', () => {
  it('被审的工作目录没有多出替补改的东西；跑完没有残留的 worktree', () => {
    const w = makeWorld({ codex: 'quota', reviewer: 'modify' });
    // 结论文件是脚本自己写的（规格要求写进仓库），不算替补动的；其余状态前后必须一样。
    const withoutReview = (status: string): string =>
      status
        .split(/\r?\n/)
        .filter((line) => line && !line.includes('K99-Codex审查.md'))
        .join('\n');
    const before = w.git(['status', '--porcelain']);
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const after = w.git(['status', '--porcelain']);
    expect(withoutReview(after)).toBe(withoutReview(before));
    expect(after).toContain('K99-Codex审查.md');
    expect(after).not.toContain('替补新建.txt');
    expect(after).not.toContain('合成.txt');
    const paths = w.worktrees().map(norm);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(norm(w.repo));
  }, 60_000);
});

describe('条件 6：没有结论行 / 超时 → 退 2', () => {
  it('替身输出没有结论行 → 退 2', () => {
    const w = makeWorld({ codex: 'quota', reviewer: 'other' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain('替补审查没有给出结论');
    expect(w.reviewerCalls()).toHaveLength(1);
  }, 60_000);

  it('超过 timeoutSeconds → 退 2，进程被结束，worktree 清掉', async () => {
    const w = makeWorld({ codex: 'quota', reviewer: 'sleep', timeoutSeconds: 1 });
    const started = Date.now();
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain('替补审查超时');
    expect(Date.now() - started).toBeLessThan(10_000);

    // 进程被结束以后心跳不该再涨
    await new Promise((resolve) => setTimeout(resolve, 400));
    const first = w.heartbeats();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(first).toBeGreaterThan(0);
    expect(w.heartbeats()).toBe(first);
    expect(w.worktrees()).toHaveLength(1);
  }, 60_000);
});

describe('条件 7：替补也撞额度 → 退 3', () => {
  it('输出里有配置里的额度字样；不写结论文件', () => {
    const w = makeWorld({ codex: 'quota', reviewer: 'quota' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(3);
    expect(r.stderr).toContain('替补审查也撞额度');
    expect(w.review()).toBe('');
    expect(w.worktrees()).toHaveLength(1);
  }, 60_000);
});

describe('条件 8：Codex 没撞额度 → 替补一次都没被调用', () => {
  it('行为和原来一样：退 0，记录是 Codex 审查', () => {
    const w = makeWorld({ codex: 'ok', reviewer: 'merge' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(w.reviewerCalls()).toHaveLength(0);
    expect(w.claudeCalls()).toHaveLength(0);
    expect(firstLine(w.review())).toBe('# K99 Codex 审查');
  }, 60_000);
});
