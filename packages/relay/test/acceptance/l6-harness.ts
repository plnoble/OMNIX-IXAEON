/**
 * L6 验收测试的共用骨架：临时裸仓库当 origin、一份合成的「调度器所在仓库」、开发的工作目录、整合方的克隆，
 * 以及一个替身角色（照计划做提交、打 `RELAY-PUSH` 行、可把收到的交代抄出来）。
 *
 * 为什么调度器跑在一份**合成**仓库里（而不是本仓库）：
 * 契约第 4 条要求「`dir` 是调度器所在仓库的工作目录」（`--git-common-dir` 和主检出的一样），
 * 所以开发的目录必须是那个仓库的工作目录；而 `bin/relay.mjs` 会强制 `cwd=仓库根`——那样开发的
 * `origin` 就是**真的 GitHub**，测试会真的往公开仓库推。所以这里用 jiti 直接起 `relay-main.ts`，
 * 把 `cwd` 设在临时合成仓库上：`origin` 是本地裸仓库，一个字都出不了本机。
 *
 * 不调真模型、不连 GitHub。临时目录由调用方（测试文件）收尾删掉。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = process.cwd();
export const RELAY_MAIN = join(REPO, 'packages', 'relay', 'bin', 'relay-main.ts');
/** 调度器眼里的「现在」定死在北京时间上午 10 点：晚上 9 点以后跑测试会多出一条日报。 */
export const MORNING = '2026-10-22T02:00:00.000Z';

export function findJiti(): string {
  const candidates: string[] = [];
  const pnpm = join(REPO, 'node_modules', '.pnpm');
  try {
    for (const dir of readdirSync(pnpm)) {
      if (dir.startsWith('jiti@')) {
        candidates.push(join(pnpm, dir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
      }
    }
  } catch {
    /* 没有 .pnpm 就看下一个 */
  }
  candidates.push(join(REPO, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('找不到 jiti 的 CLI');
  return found;
}

/** 契约第 3 条那段原文（逐字）。测试按段核对，免得被 markdown 的反引号影响。 */
export const PUSH_PARA = [
  '这一棒的推送由调度器替你做：你只提交，不要 git push。',
  '要推的，在最后一行之前每条写一行：RELAY-PUSH <工作目录的绝对路径> <本地分支> <远端分支>',
  '远端分支只能是 main 或者以 dev/ 开头。',
];

/** 替身角色：照 `--plan` 给的 JSON 做提交、打 RELAY-PUSH 行、可把交代抄出来。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const promptFile = argv[0];',
  'const plan = JSON.parse(readFileSync(argv[argv.indexOf("--plan") + 1], "utf8"));',
  'const cwd = process.cwd();',
  'const g = (...a) => {',
  '  const r = spawnSync("git", a, { cwd, encoding: "utf8" });',
  '  if (r.status !== 0) {',
  '    console.error("git " + a.join(" ") + " 失败：" + (r.stderr || r.stdout));',
  '    process.exit(1);',
  '  }',
  '  return r.stdout ?? "";',
  '};',
  'for (const c of plan.commits ?? []) {',
  '  if (c.branch) {',
  '    const sw = spawnSync("git", ["switch", c.branch], { cwd, encoding: "utf8" });',
  '    if (sw.status !== 0) spawnSync("git", ["switch", "-c", c.branch], { cwd, encoding: "utf8" });',
  '  }',
  '  writeFileSync(cwd + "/" + c.file, c.content, "utf8");',
  '  g("add", "-A");',
  '  g("commit", "-q", "-m", c.message ?? "合成：开发提交");',
  '}',
  'if (plan.copyPrompt) copyFileSync(promptFile, plan.copyPrompt);',
  'for (const p of plan.pushes ?? []) console.log(p);',
  'console.log("RELAY-DONE " + (plan.taskId ?? "70") + " " + (plan.doneStatus ?? "测试待审（整合方）"));',
  '',
].join('\n');

export interface World {
  root: string;
  origin: string;
  sched: string;
  dev: string;
  integ: string;
  dataDir: string;
  planPath: string;
  git(cwd: string, args: string[]): { code: number; out: string };
  writePlan(plan: unknown): void;
  run(
    args: string[],
    now?: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string }>;
  originSha(ref: string): string;
  originBranches(): string[];
  ledger(): Array<Record<string, unknown>>;
  state(): Record<string, unknown>;
}

const queueOf = (status: string) =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    `| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | ${status} |`,
    '',
  ].join('\n');

export function makeWorld(opts: {
  queueStatus?: string;
  devPushByRelay?: boolean;
  feishu?: { url: string };
}): World {
  const root = mkdtempSync(join(tmpdir(), 'ixa-l6-'));
  const origin = join(root, 'origin.git');
  const sched = join(root, 'sched');
  const dev = join(root, 'dev');
  const integ = join(root, 'integ');
  const dataDir = join(root, 'relay');
  const planPath = join(root, 'plan.json');
  mkdirSync(dataDir, { recursive: true });

  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };
  const must = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  };

  must(root, ['init', '--bare', '-b', 'main', origin]);
  // 先用一个 seed 克隆把初始提交推上去，再克隆 sched / integ——这样两份的工作区里都有队列那份文件
  // （否则 integ 是空克隆，工作区里连 docs/ 都没有）。
  const seed = join(root, 'seed');
  must(root, ['clone', origin, seed]);
  must(seed, ['config', 'user.email', 'relay@example.invalid']);
  must(seed, ['config', 'user.name', 'relay']);
  mkdirSync(join(seed, 'docs', '委派'), { recursive: true });
  writeFileSync(join(seed, 'docs', '委派', '队列.md'), queueOf(opts.queueStatus ?? '待领'), 'utf8');
  writeFileSync(join(seed, 'docs', '委派', '锁定验收.json'), '{"tasks":[]}\n', 'utf8');
  must(seed, ['add', '-A']);
  must(seed, ['commit', '-q', '-m', '初始合成仓库']);
  must(seed, ['push', '-q', 'origin', 'HEAD:main']);
  for (const d of [sched, integ]) {
    must(root, ['clone', origin, d]);
    must(d, ['config', 'user.email', 'relay@example.invalid']);
    must(d, ['config', 'user.name', 'relay']);
  }
  // 开发的工作目录：调度器所在那份仓库的工作目录（--git-common-dir 和它一样），分支 relay-dev 停在 origin/main
  must(sched, ['worktree', 'add', '-b', 'relay-dev', dev]);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string, pushByRelay?: boolean) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--plan', planPath],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 120,
    ...(pushByRelay ? { pushByRelay: true } : {}),
  });
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: { integrator: role(integ), developer: role(dev, opts.devPushByRelay ?? true) },
        idleSeconds: 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
    'utf8',
  );
  if (opts.feishu) {
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: opts.feishu.url, secret: 'synthetic-secret-not-real' })}\n`,
      'utf8',
    );
  }

  return {
    root,
    origin,
    sched,
    dev,
    integ,
    dataDir,
    planPath,
    git,
    writePlan: (plan) => writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
    run: (args, now = MORNING) =>
      new Promise((done) => {
        const p = spawn(process.execPath, [findJiti(), RELAY_MAIN, ...args], {
          cwd: sched,
          env: { ...process.env, IXAEON_RELAY_DIR: dataDir, IXAEON_RELAY_NOW: now },
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        const timer = setTimeout(() => p.kill(), 110_000);
        p.on('close', (status) => {
          clearTimeout(timer);
          done({ status, stdout, stderr });
        });
      }),
    originSha: (ref) => {
      const r = spawnSync('git', ['-C', origin, 'rev-parse', ref], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return (r.stdout ?? '').trim();
    },
    originBranches: () =>
      spawnSync('git', ['-C', origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .stdout.split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ledger: () => {
      const p = join(dataDir, 'ledger.jsonl');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    state: () =>
      JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>,
  };
}
