/**
 * L1b 验收测试（二）：只许一个调度器、命令与记账（规格条件 11，以及条件 5 里「记账那一行字段齐全」、
 * 条件 9 里「越界之后 once 什么都不跑、resume 之后才接着」，对应规格第 9、10 条）。
 *
 * 逐条对应：
 * - 条件 11：锁文件里的进程还活着 → 第二个拒绝启动；进程不在了 → 能启动。
 * - 条件 5：`relay once` 跑完往 ledger.jsonl 追加一行，字段齐全（turn/role/kind/taskId/开始结束时间/
 *   exitCode/timedOut/quotaHit/statusBefore/statusAfter/doneLine/violations）。
 * - 条件 9：这一棒越界 → state.json 里写上是哪一条、之后 `once` 什么都不跑；`relay resume` 之后才接着。
 * - 规格第 10 条：`relay run` 有活就跑、没活就停（测试用 `--exit-when-idle`，见规格末尾整合方的补充）。
 *
 * 命令都是起真的 CLI（`packages/relay/bin/relay.mjs`），配置里的角色是替身脚本；数据目录用
 * `IXAEON_RELAY_DIR` 指到临时目录。
 *
 * 2026-10-21 整合方从开发写的 l1-config-and-lock.test.ts 里拆出来（锁和命令归 L1b），并改了：
 * 起始的合成仓库先推上去（原来没推，origin/main 不存在）；开发替身在它自己的克隆里提交（和真的一样，
 * 调度器得自己拉一下才看得到新状态）；「进行中」那一行给的是 developer-continue（原来写成了 claim）；
 * 锁的测试用另一个活着的进程（不用测试自己的进程号）；补了 `relay run`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, type RelayConfig } from '../../src/index.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');

const dirs: string[] = [];
const kids: Array<{ kill: () => void }> = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l1b-cmd-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};

const QUEUE_RUNNING = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 59 | L0b 补完三个命令行的实验 | [L0b](L0b.md) | B | 无 | 待复审（整合方） |',
  '| 60 | L1 接力调度器核心 | [L1](L1.md) | A | 无 | 进行中（dev） |',
  '',
].join('\n');

const QUEUE_ONE_TODO = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 70 | L7 合成的一行 | [L7](L7.md) | A | 无 | 待领 |',
  '| 71 | L8 早就做完的 | [L8](L8.md) | A | 无 | 已完成（2026-10-20） |',
  '',
].join('\n');

/** 替身：先拉一下，按 --mode 改队列或者并一笔，提交、推，最后一行打 RELAY-DONE。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const promptFile = argv[0];',
  'const mode = argv[argv.indexOf("--mode") + 1];',
  'const clone = argv[argv.indexOf("--clone") + 1];',
  'const g = (...a) => spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const queuePath = clone + "/docs/委派/队列.md";',
  'const prompt = readFileSync(promptFile, "utf8");',
  'const taskId = (prompt.match(/序号[^0-9]{0,4}(\\d+)/) ?? [])[1] ?? "?";',
  'const setStatus = (from, to) => writeFileSync(queuePath, readFileSync(queuePath, "utf8").replace(from, to), "utf8");',
  'let after = "?";',
  'if (mode === "continue") { setStatus("进行中（dev）", "测试待审（整合方）"); after = "测试待审（整合方）"; }',
  'else if (mode === "dev-claim") { setStatus("| 待领 |", "| 测试待审（整合方） |"); after = "测试待审（整合方）"; }',
  'else if (mode === "integ-done") { setStatus("| 测试待审（整合方） |", "| 已完成（2026-10-21） |"); after = "已完成（2026-10-21）"; }',
  'else if (mode === "merge-b") { writeFileSync(clone + "/docs/委派/笔记.md", "并入的一笔 " + Date.now() + "\\n", "utf8"); after = "待复审（整合方）"; }',
  'g("add", "-A");',
  'g("commit", "-q", "-m", mode === "merge-b" ? "并入 L0b：补完实验" : "L：替身改状态");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE " + taskId + " " + after);',
  '',
].join('\n');

/** 临时 git 仓库（已推上去）+ 整合方和开发各一个克隆 + 数据目录 + 替身。 */
function setupCli(opts: {
  queue: string;
  devMode: string;
  integMode?: string;
  pauseIntegrator?: boolean;
}) {
  const root = mkTmp();
  const origin = join(root, 'origin.git');
  const integ = join(root, 'integ');
  const dev = join(root, 'dev');
  const dataDir = join(root, 'relay');
  mkdirSync(dataDir, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, integ]);
  for (const c of [integ]) {
    git(c, ['config', 'user.email', 'dev@example.invalid']);
    git(c, ['config', 'user.name', 'dev']);
  }
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(join(integ, 'docs', '委派', '队列.md'), opts.queue, 'utf8');
  git(integ, ['add', '-A']);
  git(integ, ['commit', '-m', '初始合成仓库']);
  git(integ, ['push', 'origin', 'HEAD:main']);
  git(root, ['clone', origin, dev]);
  git(dev, ['config', 'user.email', 'dev@example.invalid']);
  git(dev, ['config', 'user.name', 'dev']);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string, mode: string) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--mode', mode, '--clone', cwd],
    cwd,
    timeoutMinutes: 60,
    quotaPatterns: [],
    quotaPauseMinutes: 10,
  });
  const config: RelayConfig = {
    roles: {
      integrator: role(integ, opts.integMode ?? 'integ-done'),
      developer: role(dev, opts.devMode),
    },
    idleSeconds: 1,
    localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
  };
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify(
      {
        stoppedReason: null,
        pausedUntil: opts.pauseIntegrator ? { integrator: '2999-01-01T00:00:00.000Z' } : {},
        turns: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, integ, dev, dataDir, config, stub };
}

const relay = (dataDir: string, args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
    windowsHide: true,
    timeout: 120_000,
  });

const ledgerRows = (dataDir: string) => {
  const p = join(dataDir, 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

/** 另起一个一直活着的进程，拿它的进程号当「别的调度器」。 */
const otherAlive = () => {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  kids.push({ kill: () => p.kill() });
  return p.pid!;
};

describe('条件 11：同一时间只许一个', () => {
  it('锁文件里的进程还活着 → 拒绝；进程不在了 → 放行', () => {
    const dataDir = mkTmp();
    const pid = otherAlive();
    writeFileSync(
      join(dataDir, 'lock.json'),
      `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    expect(acquireLock(dataDir).ok).toBe(false);

    // 已经退出的进程：用一个不可能存在的进程号
    writeFileSync(
      join(dataDir, 'lock.json'),
      `${JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    expect(acquireLock(dataDir).ok).toBe(true);
  });

  it('锁被别的活着的进程占着 → once 拒绝启动，并说清是哪个进程号，什么都不跑', () => {
    const s = setupCli({ queue: QUEUE_RUNNING, devMode: 'continue', pauseIntegrator: true });
    const pid = otherAlive();
    writeFileSync(
      join(s.dataDir, 'lock.json'),
      `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    const r = relay(s.dataDir, ['once']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(String(pid));
    expect(ledgerRows(s.dataDir)).toHaveLength(0);
    expect(existsSync(join(s.dataDir, 'turns'))).toBe(false);
  });
});

describe('条件 5 / 9：命令与记账', () => {
  // 整合方补（2026-10-21）：调度器开跑前 main 上的队列已经变了（开发在别处领了活）→ 要用拉下来的最新那份
  it('开跑前 main 上的队列已经变了 → 用 origin/main 的最新队列定这一棒', () => {
    const s = setupCli({
      queue: QUEUE_RUNNING.replace('进行中（dev）', '待领'),
      devMode: 'continue',
      pauseIntegrator: true,
    });
    const q = join(s.dev, 'docs', '委派', '队列.md');
    writeFileSync(q, readFileSync(q, 'utf8').replace('| 待领 |', '| 进行中（dev） |'), 'utf8');
    git(s.dev, ['commit', '-qam', '领 L1']);
    git(s.dev, ['push', '-q', 'origin', 'HEAD:main']);

    const r = relay(s.dataDir, ['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const rows = ledgerRows(s.dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('developer-continue');
    expect(rows[0]!.statusBefore).toBe('进行中（dev）');
  });

  it('relay once：跑一棒、记一行字段齐全的账；做完后的状态是从 main 上重新读的', () => {
    const s = setupCli({ queue: QUEUE_RUNNING, devMode: 'continue', pauseIntegrator: true });
    const r = relay(s.dataDir, ['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const rows = ledgerRows(s.dataDir);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    for (const field of [
      'turn',
      'role',
      'kind',
      'taskId',
      'startedAt',
      'endedAt',
      'exitCode',
      'timedOut',
      'quotaHit',
      'statusBefore',
      'statusAfter',
      'doneLine',
      'violations',
    ]) {
      expect(Object.keys(row), `记账行缺字段 ${field}`).toContain(field);
    }
    expect(row.turn).toBe(1);
    expect(row.role).toBe('developer');
    expect(row.kind).toBe('developer-continue');
    expect(row.taskId).toBe('60');
    expect(row.exitCode).toBe(0);
    expect(row.timedOut).toBe(false);
    expect(row.quotaHit).toBe(false);
    expect(Number.isNaN(Date.parse(String(row.startedAt)))).toBe(false);
    expect(Date.parse(String(row.endedAt))).toBeGreaterThanOrEqual(
      Date.parse(String(row.startedAt)),
    );
    expect(row.statusBefore).toBe('进行中（dev）');
    // 开发替身是在它自己的克隆里推的：整合方的目录没变，调度器要拉一下才读得到
    expect(row.statusAfter).toBe('测试待审（整合方）');
    expect(row.doneLine).toBe('RELAY-DONE 60 测试待审（整合方）');
    expect(row.violations).toEqual([]);

    const state = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      turns: number;
    };
    expect(state.turns).toBe(1);
    // 一棒的东西都落在 turns/1/ 里
    expect(existsSync(join(s.dataDir, 'turns', '1', 'prompt.md'))).toBe(true);
    expect(existsSync(join(s.dataDir, 'turns', '1', 'stdout.txt'))).toBe(true);
    expect(existsSync(join(s.dataDir, 'turns', '1', 'stderr.txt'))).toBe(true);
    // 调度器自己不改仓库：整合方目录的工作区干干净净
    expect(git(s.integ, ['status', '--porcelain'])).toBe('');
  });

  it('越界之后 once 什么都不跑，resume 之后才接着', () => {
    const s = setupCli({ queue: QUEUE_RUNNING, devMode: 'merge-b', pauseIntegrator: true });
    expect(relay(s.dataDir, ['once']).status).toBe(0);

    const state1 = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      stoppedReason?: string | null;
    };
    expect(state1.stoppedReason).toBeTruthy();
    expect(state1.stoppedReason).toContain('b-tier-merged-by-developer');
    const afterFirst = ledgerRows(s.dataDir);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.violations).toContain('b-tier-merged-by-developer');

    // 停住之后：再一次 once 什么都不跑（不新增记账、不新开一棒）
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    expect(ledgerRows(s.dataDir)).toHaveLength(1);
    expect(existsSync(join(s.dataDir, 'turns', '2'))).toBe(false);

    // status 里能看到停住的原因
    const status = relay(s.dataDir, ['status']);
    expect(status.status).toBe(0);
    expect(`${status.stdout}${status.stderr}`).toContain('b-tier-merged-by-developer');

    // resume 之后又能接着跑
    expect(relay(s.dataDir, ['resume']).status).toBe(0);
    const state2 = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      stoppedReason?: string | null;
    };
    expect(state2.stoppedReason ?? null).toBeNull();
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    expect(ledgerRows(s.dataDir)).toHaveLength(2);
  });

  it('relay run --exit-when-idle：开发领 → 整合方完成 → 队列空了就退出', () => {
    const s = setupCli({ queue: QUEUE_ONE_TODO, devMode: 'dev-claim', integMode: 'integ-done' });
    const r = relay(s.dataDir, ['run', '--exit-when-idle']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const rows = ledgerRows(s.dataDir);
    expect(rows.map((x) => [x.turn, x.role, x.kind, x.taskId, x.statusAfter])).toEqual([
      [1, 'developer', 'developer-claim', '70', '测试待审（整合方）'],
      [2, 'integrator', 'integrator-review', '70', '已完成（2026-10-21）'],
    ]);
    const state = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      turns: number;
      stoppedReason: string | null;
    };
    expect(state.turns).toBe(2);
    expect(state.stoppedReason ?? null).toBeNull();
  });

  it('配置不过 → once 拒绝启动、说清楚哪一条，什么都不跑', () => {
    const s = setupCli({ queue: QUEUE_RUNNING, devMode: 'continue', pauseIntegrator: true });
    const bad = {
      ...s.config,
      roles: {
        ...s.config.roles,
        developer: {
          ...s.config.roles.developer,
          argv: [...s.config.roles.developer.argv, '--dangerously-skip-permissions'],
        },
      },
    };
    writeFileSync(join(s.dataDir, 'config.json'), `${JSON.stringify(bad, null, 2)}\n`, 'utf8');
    const r = relay(s.dataDir, ['once']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('--dangerously-skip-permissions');
    expect(ledgerRows(s.dataDir)).toHaveLength(0);
    expect(existsSync(join(s.dataDir, 'turns'))).toBe(false);
  });
});
