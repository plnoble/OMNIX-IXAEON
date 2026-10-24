/**
 * L17 验收测试：Codex 额度用完时改用 Claude 代审（规格「验收条件」1–9）。
 *
 * 做法照规格：临时 git 仓库（带一个裸仓库当 `origin`，`main` 推上去），把本仓库的
 * `scripts/codex-review.mjs` 拷进去，放一份合成规格 `docs/委派/L99-合成.md` 和一个
 * `AGENTS.md`，切一个分支改一个文件、提交；用 `node scripts/codex-review.mjs L99` 跑。
 * Codex、Claude 都用 `.mjs` 替身（经 `CODEX_BIN` / `CLAUDE_BIN`），替身把收到的参数、
 * 标准输入、`cwd` 写进一个文件。`IXAEON_RELAY_DIR` 指到临时目录。
 *
 * 逐条对应：
 * - 条件 1：Codex 替身正常给结论（写 `-o` 文件）→ 退 0；审查记录开头 `# L99 Codex 审查`；
 *   Claude 替身没被调用。
 * - 条件 2：Codex 打 `usage limit reached`、不写 `-o`；Claude 打 JSON、结果「结论：可以合并」
 *   → 退 0；记录第一行是 `# L99 审查（Codex 额度用完，由 Claude 代审）`，含审查者、花费、
 *   结论；标准错误含 `改用 Claude 代审`。
 * - 条件 3：同条件 2，Claude 结论最后一行是「结论：需要修改」→ 退 1；最后一行别的话 → 退 2。
 * - 条件 4：Claude 替身收到的参数正好是契约第 4 条那一串（`-p` 后和 Codex 收到的 prompt 一样）；
 *   标准输入和 Codex 收到的一样；`cwd` 不是那个临时仓库、也不在它里面；参数里没有
 *   `FORBIDDEN_SWITCHES` 的任何一项。
 * - 条件 5：Claude 打 `is_error: true` 的会话额度 JSON → 退 3，标准错误含 `Claude 也没额度了`；
 *   审查记录没写。
 * - 条件 6：Claude 打不是 JSON 的一句话、退出码 1 → 退 2，标准错误含 `Claude 没有给出结论`。
 * - 条件 7：不设 `CLAUDE_BIN`，`<IXAEON_RELAY_DIR>/config.json` 的 `roles.integrator.argv[0]`
 *   指向 Claude 替身 → 用它（结果同条件 2）；`quotaPatterns` 写 `["自定义额度字样"]`、Claude 打出
 *   这几个字且没有 `result` → 退 3。
 * - 条件 8：不设 `CLAUDE_BIN`、数据目录没有 `config.json` → 退 3，标准错误含 `也没找到可用的 Claude`。
 * - 条件 9：Codex 别的失败（不含额度字样、不写 `-o`）→ 退 2，Claude 替身没被调用。
 *
 * 全程不调真 Codex / 真 Claude、不连 GitHub；临时目录由本文件收尾删掉。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_SWITCHES, isInside } from '../../src/index.js';

const REPO = process.cwd();
const REVIEW_SCRIPT = join(REPO, 'scripts', 'codex-review.mjs');
const TASK = 'L99';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

interface Call {
  argv: string[];
  script: string;
  cwd: string;
  cwdEmpty: boolean;
  stdin: string;
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
  claudeStub: string;
  claudeVia: 'env' | 'config' | 'none';
  reviewFile: string;
  run(): Result;
  review(): string;
  codexCalls(): Call[];
  claudeCalls(): Call[];
  git(args: string[]): string;
}

type CodexMode = 'ok' | 'quota' | 'other';
type ClaudeMode = 'merge' | 'changes' | 'other' | 'quota' | 'not-json' | 'custom-quota';

/** Codex 替身：`--version` 打版本；其余把参数/标准输入/cwd 记一行，再按模式打输出。 */
function codexStubSource(logPath: string, mode: CodexMode): string {
  return [
    "import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const MODE = ${JSON.stringify(mode)};`,
    'const argv = process.argv.slice(2);',
    "if (argv.includes('--version')) { console.log('codex-cli 9.9.9 (synthetic)'); process.exit(0); }",
    "const stdin = readFileSync(0, 'utf8');",
    'appendFileSync(LOG, JSON.stringify({ argv, script: process.argv[1], cwd: process.cwd(), cwdEmpty: existsSync(process.cwd()) && readdirSync(process.cwd()).length === 0, stdin }) + "\\n", "utf8");',
    "if (MODE === 'ok') {",
    "  const i = argv.indexOf('-o');",
    "  if (i >= 0) writeFileSync(argv[i + 1], '没有发现问题\\n结论：可以合并\\n', 'utf8');",
    "  console.log('合成 Codex：审完了');",
    '  process.exit(0);',
    '}',
    "if (MODE === 'quota') { console.log('usage limit reached'); process.exit(1); }",
    "console.log('合成 Codex：别的失败');",
    'process.exit(1);',
  ].join('\n');
}

/** Claude 替身：`--version` 打版本；其余把参数/标准输入/cwd 记一行，再按模式打输出。 */
function claudeStubSource(logPath: string, mode: ClaudeMode): string {
  return [
    "import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';",
    `const LOG = ${JSON.stringify(logPath)};`,
    `const MODE = ${JSON.stringify(mode)};`,
    'const argv = process.argv.slice(2);',
    "if (argv.includes('--version')) { console.log('9.8.7 (Claude Code synthetic)'); process.exit(0); }",
    "const stdin = readFileSync(0, 'utf8');",
    'appendFileSync(LOG, JSON.stringify({ argv, script: process.argv[1], cwd: process.cwd(), cwdEmpty: existsSync(process.cwd()) && readdirSync(process.cwd()).length === 0, stdin }) + "\\n", "utf8");',
    "if (MODE === 'merge') {",
    "  console.log(JSON.stringify({ type: 'result', is_error: false, result: '没有发现问题\\n结论：可以合并', total_cost_usd: 0.12 }));",
    '  process.exit(0);',
    '}',
    "if (MODE === 'changes') {",
    "  console.log(JSON.stringify({ type: 'result', is_error: false, result: '有一处要改\\n结论：需要修改', total_cost_usd: 0.12 }));",
    '  process.exit(0);',
    '}',
    "if (MODE === 'other') {",
    "  console.log(JSON.stringify({ type: 'result', is_error: false, result: '没有发现问题\\n就这样吧', total_cost_usd: 0.12 }));",
    '  process.exit(0);',
    '}',
    "if (MODE === 'quota') {",
    "  console.log(JSON.stringify({ type: 'result', is_error: true, result: \"You've hit your session limit · resets 3:10am (Asia/Shanghai)\", api_error: 'usage_limit_reached' }));",
    '  process.exit(0);',
    '}',
    "if (MODE === 'custom-quota') { console.log('自定义额度字样'); process.exit(0); }",
    "console.log('这不是 JSON 的一段话');",
    'process.exit(1);',
  ].join('\n');
}

const mustGit = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${cwd}）：${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
};

/**
 * 合成一个临时仓库 + 一份数据目录 + 两个替身。
 * `claudeVia`：`env` = 设 `CLAUDE_BIN`；`config` = 写进 `config.json`；`none` = 两处都没有。
 */
function makeWorld(opts: {
  codex: CodexMode;
  claude?: ClaudeMode;
  claudeVia?: 'env' | 'config' | 'none';
  quotaPatterns?: string[];
}): World {
  const root = mkdtempSync(join(tmpdir(), 'ixa-l17-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const dataDir = join(root, 'relay');
  const codexStub = join(root, 'codex-stub.mjs');
  const claudeStub = join(root, 'claude-stub.mjs');
  const codexLog = join(root, 'codex-calls.jsonl');
  const claudeLog = join(root, 'claude-calls.jsonl');
  const claudeVia = opts.claudeVia ?? 'env';
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, 'stubs'), { recursive: true });

  mustGit(root, ['init', '--bare', '-b', 'main', origin]);
  mustGit(root, ['clone', '-q', origin, repo]);
  mustGit(repo, ['config', 'user.email', 'relay@example.invalid']);
  mustGit(repo, ['config', 'user.name', 'relay']);
  mkdirSync(join(repo, 'docs', '委派', '交付'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, 'docs', '委派', 'L99-合成.md'),
    [
      '# 规格 L99：合成的一页',
      '',
      '## 验收条件',
      '',
      '1. 合成条件一：这个临时仓库只是给 codex-review.mjs 喂上下文用的。',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(repo, 'AGENTS.md'), '# 合成 AGENTS.md\n\n合成规则，不读真的。\n', 'utf8');
  copyFileSync(REVIEW_SCRIPT, join(repo, 'scripts', 'codex-review.mjs'));
  writeFileSync(join(repo, '合成.txt'), '原始一行\n', 'utf8');
  mustGit(repo, ['add', '-A']);
  mustGit(repo, ['commit', '-q', '-m', '初始合成仓库']);
  mustGit(repo, ['push', '-q', 'origin', 'HEAD:main']);
  mustGit(repo, ['switch', '-q', '-c', 'dev/L99']);
  writeFileSync(join(repo, '合成.txt'), '改了一行\n', 'utf8');
  mustGit(repo, ['add', '-A']);
  mustGit(repo, ['commit', '-q', '-m', '合成：一处改动']);

  writeFileSync(codexStub, codexStubSource(codexLog, opts.codex), 'utf8');
  writeFileSync(claudeStub, claudeStubSource(claudeLog, opts.claude ?? 'merge'), 'utf8');

  if (claudeVia === 'config') {
    writeFileSync(
      join(dataDir, 'config.json'),
      `${JSON.stringify(
        {
          roles: {
            integrator: {
              argv: [claudeStub],
              ...(opts.quotaPatterns ? { quotaPatterns: opts.quotaPatterns } : {}),
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const calls = (logPath: string): Call[] => {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  };

  const reviewFile = join(repo, 'docs', '委派', '交付', 'L99-Codex审查.md');

  const world: World = {
    root,
    repo,
    dataDir,
    codexStub,
    claudeStub,
    claudeVia,
    reviewFile,
    git: (args) => mustGit(repo, args),
    run: () => {
      const env = { ...process.env, CODEX_BIN: codexStub, IXAEON_RELAY_DIR: dataDir };
      delete env.CLAUDE_BIN;
      if (claudeVia === 'env') env.CLAUDE_BIN = claudeStub;
      const r = spawnSync(
        process.execPath,
        [join(repo, 'scripts', 'codex-review.mjs'), TASK],
        { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
      );
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    review: () => (existsSync(reviewFile) ? readFileSync(reviewFile, 'utf8') : ''),
    codexCalls: () => calls(codexLog),
    claudeCalls: () => calls(claudeLog),
  };
  worlds.push(world);
  return world;
}

const firstLine = (text: string): string => (text.split(/\r?\n/)[0] ?? '').trim();

describe('条件 1：Codex 正常给结论 → 退 0、记录是 Codex 审查、不叫 Claude', () => {
  it('`.mjs` 替身照样当 Codex 起；`-o` 文件里的结论原样进记录', () => {
    const w = makeWorld({ codex: 'ok', claude: 'merge' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const text = w.review();
    expect(firstLine(text)).toBe('# L99 Codex 审查');
    expect(text).toContain('结论：可以合并');
    expect(w.claudeCalls()).toHaveLength(0);
    expect(w.codexCalls()).toHaveLength(1);
  }, 60_000);
});

describe('条件 2：Codex 额度用完 → 换 Claude 代审，结论可以合并', () => {
  it('退 0；记录第一行写着 Claude 代审，含审查者、花费、结论；标准错误说明换了谁', () => {
    const w = makeWorld({ codex: 'quota', claude: 'merge' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const text = w.review();
    expect(firstLine(text)).toBe('# L99 审查（Codex 额度用完，由 Claude 代审）');
    expect(text).toContain('- 审查者：Claude（9.8.7）');
    expect(text).toContain('- 花费：0.12 美元');
    expect(text).toContain('结论：可以合并');
    expect(r.stderr).toContain('改用 Claude 代审');
    // 记录里不写本机路径（Claude 的路径只打在标准错误）
    expect(text).not.toContain(w.claudeStub);
  }, 60_000);
});

describe('条件 3：Claude 的结论照样按最后一行的约定认', () => {
  it('「结论：需要修改」→ 退 1，记录写着', () => {
    const w = makeWorld({ codex: 'quota', claude: 'changes' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(1);
    expect(w.review()).toContain('结论：需要修改');
  }, 60_000);

  it('最后一行别的话 → 退 2（确实走到了 Claude）', () => {
    const w = makeWorld({ codex: 'quota', claude: 'other' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(2);
    expect(w.claudeCalls()).toHaveLength(1);
  }, 60_000);
});

describe('条件 4：Claude 收到的参数、上下文、工作目录照契约', () => {
  it('参数正好那一串、stdin 与 Codex 一样、cwd 在仓库外且是新的空临时目录、无禁用开关', () => {
    const w = makeWorld({ codex: 'quota', claude: 'merge' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const codex = w.codexCalls()[0]!;
    const claude = w.claudeCalls()[0]!;
    const prompt = codex.argv.at(-1) ?? '';

    expect(claude.script).toBe(w.claudeStub);
    expect(claude.argv).toEqual([
      '--restricted',
      '--tools',
      '',
      '--output-format',
      'json',
      '-p',
      prompt,
    ]);
    expect(claude.stdin).toBe(codex.stdin);
    expect(codex.stdin.length).toBeGreaterThan(0);

    // 工作目录是新建的空临时目录，审完删掉；不是临时仓库、也不在它里面
    expect(claude.cwdEmpty).toBe(true);
    expect(isInside(claude.cwd, w.repo)).toBe(false);
    expect(existsSync(claude.cwd)).toBe(false);

    for (const sw of FORBIDDEN_SWITCHES) {
      expect(claude.argv.some((a) => a.includes(sw))).toBe(false);
    }
  }, 60_000);
});

describe('条件 5：Claude 也没额度 → 退 3、不写记录', () => {
  it('`is_error: true` 的会话额度 JSON；标准错误含「Claude 也没额度了」', () => {
    const w = makeWorld({ codex: 'quota', claude: 'quota' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(3);
    expect(r.stderr).toContain('Claude 也没额度了');
    expect(w.claudeCalls()).toHaveLength(1);
    expect(w.review()).toBe('');
  }, 60_000);
});

describe('条件 6：Claude 没给出结论 → 退 2', () => {
  it('不是 JSON 的一句话、退出码 1；标准错误含「Claude 没有给出结论」', () => {
    const w = makeWorld({ codex: 'quota', claude: 'not-json' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain('Claude 没有给出结论');
    expect(w.claudeCalls()).toHaveLength(1);
  }, 60_000);
});

describe('条件 7：没设 CLAUDE_BIN 时从调度器配置里找', () => {
  it('`roles.integrator.argv[0]` 指向替身 → 用它，结果同条件 2', () => {
    const w = makeWorld({ codex: 'quota', claude: 'merge', claudeVia: 'config' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(firstLine(w.review())).toBe('# L99 审查（Codex 额度用完，由 Claude 代审）');
    expect(w.claudeCalls()).toHaveLength(1);
    expect(w.claudeCalls()[0]!.script).toBe(w.claudeStub);
  }, 60_000);

  it('配置里的 `quotaPatterns` 当额度字样用 → 退 3', () => {
    const w = makeWorld({
      codex: 'quota',
      claude: 'custom-quota',
      claudeVia: 'config',
      quotaPatterns: ['自定义额度字样'],
    });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(3);
    expect(r.stderr).toContain('Claude 也没额度了');
    expect(w.claudeCalls()).toHaveLength(1);
    expect(w.review()).toBe('');
  }, 60_000);
});

describe('条件 8：找不到 Claude → 退 3', () => {
  it('没有 CLAUDE_BIN、数据目录也没有 config.json；标准错误含「也没找到可用的 Claude」', () => {
    const w = makeWorld({ codex: 'quota', claudeVia: 'none' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(3);
    expect(r.stderr).toContain('Codex 额度用完');
    expect(r.stderr).toContain('也没找到可用的 Claude');
    expect(w.review()).toBe('');
  }, 60_000);
});

describe('条件 9：Codex 别的失败不换 Claude', () => {
  it('不含额度字样、不写 `-o` → 退 2，Claude 替身没被调用', () => {
    const w = makeWorld({ codex: 'other', claude: 'merge' });
    const r = w.run();
    expect(r.status, r.stderr || r.stdout).toBe(2);
    expect(r.stderr).toContain('合成 Codex：别的失败');
    expect(w.claudeCalls()).toHaveLength(0);
    expect(w.review()).toBe('');
  }, 60_000);
});