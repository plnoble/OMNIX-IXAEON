/**
 * L9 验收测试的共用骨架：临时裸仓库当 origin、一份合成的「调度器所在仓库」、整合方和开发各一个克隆，
 * 以及一个替身整合方（照 JSON 计划改 `docs/` 下的文件、必要时改 `docs/` 以外的文件，提交并推 main）。
 *
 * 为什么要合成一个仓库：调度器会真的起整合方那一棒、真的 `git fetch origin main`、真的核对
 * 开棒前后的 `origin/main`。用真仓库的话，这一棒就会往公开仓库推；所以 origin 是临时裸仓库，
 * 一切都只在本机临时目录里。
 *
 * 调度器的「现在」定死在北京时间 2026-10-23 10:00（`IXAEON_RELAY_NOW`），不然晚上 9 点以后
 * 跑测试会多出一条日报，日期断言也会跟着当天变。不调真模型、不连 GitHub。
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
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = process.cwd();
export const RELAY_MAIN = join(REPO, 'packages', 'relay', 'bin', 'relay-main.ts');
/** 调度器眼里的「现在」：北京时间 2026-10-23 10:00（北京时间比 UTC 早 8 小时）。 */
export const MORNING = '2026-10-23T02:00:00.000Z';
export const TODAY = '10月23日';
export const YESTERDAY = '10月22日';

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

export interface QueueRow {
  no: string;
  task: string;
  tier?: string;
  deps?: string;
  status: string;
}

export const rowLine = (r: QueueRow): string =>
  `| ${r.no} | ${r.task} | [x](x.md) | ${r.tier ?? 'B'} | ${r.deps ?? '无'} | ${r.status} |`;

/** 合成的主表（只认第一张表头是「序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态」的表）。
 *
 * 主表后面另放一张「已完成」的表——真的队列就是这样，规划棒只能往**主表**末尾加行，
 * 不能往文末最后一张表里加。两张表的表头不一样，实现要是只认「最后一张表」就会露出来。
 */
export function queueMarkdown(rows: QueueRow[]): string {
  return [
    '# 委派队列',
    '',
    '## 可以领的',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    ...rows.map(rowLine),
    '',
    '## 已完成',
    '',
    '| 序号 | 任务 | 档位 | 结果 |',
    '| ---- | ---- | ---- | ---- |',
    '| 1 | 以前的合成任务 | A | 2026-10-22 并入 |',
    '',
  ].join('\n');
}

/** 主表的最后一行在第几行（跳过表头之前的说明、也跳过主表后面别的表）。 */
function mainTableEnd(lines: string[]): number {
  const head = lines.findIndex(
    (l) => l.includes('| 序号 |') && l.includes('委派单或规格') && l.includes('依赖'),
  );
  if (head < 0) throw new Error('合成队列里找不到主表');
  let last = head;
  while (last + 1 < lines.length && lines[last + 1]!.trim().startsWith('|')) last += 1;
  return last;
}

/** 主表末尾加几行（模拟规划棒加行；已有的行一个字节都不动）。 */
export function addRows(md: string, rows: QueueRow[]): string {
  const lines = md.split('\n');
  const last = mainTableEnd(lines);
  lines.splice(last + 1, 0, ...rows.map(rowLine));
  return lines.join('\n');
}

/** 全都做完了的队列（`queue-empty`）。 */
export const DONE_ROWS: QueueRow[] = [
  { no: '70', task: 'L8 合成的一行', tier: 'A', status: '已完成（2026-10-22）' },
];

/** 有一行被依赖挡着的队列（`all-blocked`）。 */
export const BLOCKED_ROWS: QueueRow[] = [
  ...DONE_ROWS,
  { no: '71', task: 'L9 等一个没做完的', tier: 'B', deps: 'L404', status: '待领' },
];

/** 替身整合方：照 `--plan` 给的 JSON 改文件、提交、推 main，最后打一行 `RELAY-DONE plan <N>`。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { dirname } from 'node:path';",
  'const argv = process.argv.slice(2);',
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
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const queuePath = cwd + "/docs/委派/队列.md";',
  'let text = readFileSync(queuePath, "utf8");',
  'if (plan.deleteRow) {',
  '  text = text.split("\\n").filter((l) => !l.includes(plan.deleteRow)).join("\\n");',
  '}',
  'if (plan.editQueue) {',
  '  text = text.replace(plan.editQueue.find, plan.editQueue.replace);',
  '}',
  'if (plan.rows && plan.rows.length) {',
  '  const lines = text.split("\\n");',
  '  let head = lines.findIndex((l) => l.includes("| 序号 |") && l.includes("委派单或规格"));',
  '  if (head < 0) throw new Error("合成队列里找不到主表");',
  '  let last = head;',
  '  while (last + 1 < lines.length && lines[last + 1].trim().startsWith("|")) last += 1;',
  '  const added = plan.rows.map(',
  '    (r) =>',
  '      "| " + r.no + " | " + r.task + " | [x](x.md) | " + (r.tier ?? "B") + " | " +',
  '      (r.deps ?? "无") + " | " + r.status + " |",',
  '  );',
  '  lines.splice(last + 1, 0, ...added);',
  '  text = lines.join("\\n");',
  '}',
  'writeFileSync(queuePath, text, "utf8");',
  'for (const f of [...(plan.docs ?? []), ...(plan.code ?? [])]) {',
  '  mkdirSync(dirname(cwd + "/" + f.file), { recursive: true });',
  '  writeFileSync(cwd + "/" + f.file, f.content, "utf8");',
  '}',
  'g("add", "-A");',
  'if (g("status", "--porcelain").trim().length > 0) {',
  '  g("commit", "-q", "-m", plan.message ?? "合成：规划棒的一笔");',
  '  g("push", "-q", "origin", "HEAD:main");',
  '}',
  'const addedRows = plan.doneRows ?? (plan.rows ? plan.rows.length : 0);',
  'console.log("RELAY-DONE plan " + addedRows);',
  '',
].join('\n');

/** 假飞书：本机 http 服务（127.0.0.1 随机端口），只收正文，地址和密钥都是合成的。 */
export async function fakeFeishu(): Promise<{
  url: string;
  texts: string[];
  close(): Promise<void>;
}> {
  const texts: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { content?: { text?: string } };
      texts.push(body.content?.text ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/synthetic`,
    texts,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

export interface World {
  root: string;
  origin: string;
  sched: string;
  dev: string;
  integ: string;
  dataDir: string;
  planPath: string;
  git(cwd: string, args: string[]): { code: number; out: string };
  must(cwd: string, args: string[]): string;
  writePlan(plan: unknown): void;
  /** 在整合方的克隆里改一点东西、提交、推 main（模拟这一棒自己推上去）。 */
  commitPushInInteg(message: string, change: (dir: string) => void): void;
  run(
    args: string[],
    now?: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string }>;
  originSha(ref: string): string;
  queueAt(ref?: string): string;
  ledger(): Array<Record<string, unknown>>;
  state(): Record<string, unknown>;
}

export function makeL9World(
  opts: {
    rows?: QueueRow[];
    planPerDay?: number;
    state?: Record<string, unknown>;
    feishu?: { url: string };
  } = {},
): World {
  const rows = opts.rows ?? DONE_ROWS;
  const root = mkdtempSync(join(tmpdir(), 'ixa-l9-'));
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
    return (r.stdout ?? '').trim();
  };

  must(root, ['init', '--bare', '-b', 'main', origin]);
  // 先用 seed 克隆写初始内容、推上去，再克隆 sched / integ（否则两边的工作区是空的）
  const seed = join(root, 'seed');
  must(root, ['clone', origin, seed]);
  must(seed, ['config', 'user.email', 'relay@example.invalid']);
  must(seed, ['config', 'user.name', 'relay']);
  mkdirSync(join(seed, 'docs', '委派'), { recursive: true });
  mkdirSync(join(seed, 'packages', 'core', 'src'), { recursive: true });
  writeFileSync(join(seed, 'docs', '委派', '队列.md'), queueMarkdown(rows), 'utf8');
  writeFileSync(
    join(seed, 'docs', '三周任务单.md'),
    '# 三周任务单\n\n合成的任务单：排着两件、明确不做一件。\n',
    'utf8',
  );
  writeFileSync(join(seed, 'docs', '委派', '锁定验收.json'), '{"tasks":[]}\n', 'utf8');
  writeFileSync(join(seed, 'packages', 'core', 'src', 'existing.ts'), '// 合成的源码\n', 'utf8');
  writeFileSync(join(seed, 'AGENTS.md'), '# 合成的 AGENTS\n', 'utf8');
  must(seed, ['add', '-A']);
  must(seed, ['commit', '-q', '-m', '初始合成仓库']);
  must(seed, ['push', '-q', 'origin', 'HEAD:main']);
  for (const d of [sched, integ, dev]) {
    must(root, ['clone', origin, d]);
    must(d, ['config', 'user.email', 'relay@example.invalid']);
    must(d, ['config', 'user.name', 'relay']);
  }

  const stub = join(root, 'stub-integ.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--plan', planPath],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 120,
  });
  const config = {
    roles: {
      integrator: role(integ),
      developer: {
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: dev,
        timeoutMinutes: 5,
        quotaPatterns: [],
        quotaPauseMinutes: 120,
      },
    },
    idleSeconds: 1,
    localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
    ...(typeof opts.planPerDay === 'number' ? { planPerDay: opts.planPerDay } : {}),
  };
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify(
      { stoppedReason: null, pausedUntil: {}, turns: 0, ...(opts.state ?? {}) },
      null,
      2,
    )}\n`,
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
    must,
    writePlan: (plan) => writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
    commitPushInInteg: (message, change) => {
      change(integ);
      must(integ, ['add', '-A']);
      must(integ, ['commit', '-q', '-m', message]);
      must(integ, ['push', '-q', 'origin', 'HEAD:main']);
    },
    run: (args, now = MORNING) =>
      new Promise((done) => {
        const p = spawn(process.execPath, [findJiti(), RELAY_MAIN, ...args], {
          cwd: sched,
          // L10 起 `run` 的看门人会换一份「自己的代码」再起子进程；合成仓库里没有 packages/relay，
          // 不指到本仓库就会连着崩 3 次。`IXAEON_WORKTREES` 也落进临时目录，万一没认那个变量
          // 也不会在用户本机的 Worktrees 下面建东西。
          env: {
            ...process.env,
            IXAEON_RELAY_DIR: dataDir,
            IXAEON_RELAY_NOW: now,
            IXAEON_RELAY_CODE: REPO,
            IXAEON_WORKTREES: join(root, 'trees'),
          },
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
    queueAt: (ref = 'main') => {
      const r = spawnSync('git', ['-C', origin, 'show', `${ref}:docs/委派/队列.md`], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return (r.stdout ?? '').trim();
    },
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
