/**
 * L1 验收测试（五）：配置检查、只许一个调度器、命令与记账（规格条件 10、11，以及条件 5 里
 * 「记账那一行字段齐全」和条件 9 里「越界之后 once 什么都不跑、resume 之后才接着」）。
 *
 * 逐条对应：
 * - 条件 10：argv 里有任何「跳过所有权限」的开关 → 拒绝启动；cwd 是共用检出目录 → 拒绝；cwd 不存在 → 拒绝。
 * - 条件 11：锁文件里的进程还活着 → 第二个拒绝启动；进程不在了 → 能启动。
 * - 条件 5：`relay once` 跑完往 ledger.jsonl 追加一行，字段齐全（turn/role/kind/taskId/开始结束时间/
 *   exitCode/timedOut/quotaHit/usage/statusBefore/statusAfter/doneLine/violations）。
 * - 条件 9：这一棒越界 → state.json 里写上是哪一条、之后 `once` 什么都不跑；`relay resume` 之后才接着。
 *
 * 命令都是起真的 CLI（`packages/relay/bin/relay.mjs`），配置里的角色是替身脚本；数据目录用
 * `IXAEON_RELAY_DIR` 指到临时目录（规格说的是 <Worktrees>/IXAEON/relay/，测试要能换地方）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLock, checkConfig, findSharedCheckout, type RelayConfig } from '../../src/index.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');

const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l1-cmd-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};

const goodRole = (cwd: string) => ({
  argv: [process.execPath, '-e', 'process.exit(0)'],
  cwd,
  timeoutMinutes: 60,
  quotaPatterns: [],
  quotaPauseMinutes: 10,
});

const QUEUE_RUNNING = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 59 | L0b 补完三个命令行的实验 | [L0b](L0b.md) | B | 无 | 待复审（整合方） |',
  '| 60 | L1 接力调度器核心 | [L1](L1.md) | A | 无 | 进行中（dev） |',
  '',
].join('\n');

/** 临时 git 仓库 + 数据目录 + 替身角色；替身按 --mode 干活。 */
function setupCli(mode: string) {
  const root = mkTmp();
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  const dataDir = join(root, 'relay');
  mkdirSync(dataDir, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, clone]);
  git(clone, ['config', 'user.email', 'dev@example.invalid']);
  git(clone, ['config', 'user.name', 'dev']);
  mkdirSync(join(clone, 'docs', '委派'), { recursive: true });
  writeFileSync(join(clone, 'docs', '委派', '队列.md'), QUEUE_RUNNING, 'utf8');
  const stub = join(root, 'stub-role.mjs');
  writeFileSync(
    stub,
    [
      "import { spawnSync } from 'node:child_process';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'const promptFile = argv[0];',
      'const mode = argv[argv.indexOf("--mode") + 1];',
      'const clone = argv[argv.indexOf("--clone") + 1];',
      'const queuePath = clone + "/docs/委派/队列.md";',
      'const prompt = readFileSync(promptFile, "utf8");',
      'const taskId = (prompt.match(/序号[^0-9]{0,4}(\\d+)/) ?? prompt.match(/(\\d+)/) ?? [])[1] ?? "?";',
      'if (mode === "claim") {',
      '  writeFileSync(queuePath, readFileSync(queuePath, "utf8").replace("进行中（dev）", "测试待审（整合方）"), "utf8");',
      '  spawnSync("git", ["add", "-A"], { cwd: clone });',
      '  spawnSync("git", ["commit", "-m", "L1：先推测试"], { cwd: clone });',
      '  spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: clone });',
      '  console.log("RELAY-DONE " + taskId + " 测试待审（整合方）");',
      '} else if (mode === "merge-b") {',
      '  writeFileSync(clone + "/docs/委派/笔记.md", "并入的一笔\\n", "utf8");',
      '  spawnSync("git", ["add", "-A"], { cwd: clone });',
      '  spawnSync("git", ["commit", "-m", "并入 L0b：补完实验"], { cwd: clone });',
      '  spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: clone });',
      '  console.log("RELAY-DONE " + taskId + " 待复审（整合方）");',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const role = {
    argv: [process.execPath, stub, '{prompt_file}', '--mode', mode, '--clone', clone],
    cwd: clone,
    timeoutMinutes: 60,
    quotaPatterns: [],
    quotaPauseMinutes: 10,
  };
  const config: RelayConfig = {
    roles: { integrator: { ...role }, developer: { ...role } },
    idleSeconds: 1,
    localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
  };
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  // 整合方歇着（额度），这样轮到的是开发那一棒；队列里 L0b（B 档）那一行留着给核对查档位
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify(
      {
        stoppedReason: null,
        pausedUntil: { integrator: '2999-01-01T00:00:00.000Z' },
        turns: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, clone, dataDir, config, stub };
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

describe('条件 10：配置检查', () => {
  it('argv 里带任何一个「跳过所有权限」的开关都拒绝启动，并说清是哪一个', () => {
    const cwd = mkTmp();
    const switches = [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--dangerously-bypass-approvals-and-sandbox',
      'danger-full-access',
      '--full-auto',
      'bypassPermissions',
    ];
    for (const sw of switches) {
      const config: RelayConfig = {
        roles: {
          integrator: goodRole(cwd),
          developer: { ...goodRole(cwd), argv: [process.execPath, sw] },
        },
        idleSeconds: 60,
      };
      const r = checkConfig(config);
      expect(r.ok, `${sw} 应当被拒绝`).toBe(false);
      if (!r.ok) expect(r.reason).toContain(sw);
    }
  });

  it('cwd 是共用检出目录 → 拒绝', () => {
    const shared = findSharedCheckout();
    const config: RelayConfig = {
      roles: { integrator: goodRole(shared), developer: goodRole(shared) },
      idleSeconds: 60,
    };
    const r = checkConfig(config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/共用|检出|主检出/);
  });

  it('cwd 不存在 → 拒绝；都合规 → 放行', () => {
    const cwd = mkTmp();
    const bad: RelayConfig = {
      roles: {
        integrator: goodRole(join(cwd, '不存在的目录')),
        developer: goodRole(cwd),
      },
      idleSeconds: 60,
    };
    expect(checkConfig(bad).ok).toBe(false);

    const good: RelayConfig = {
      roles: { integrator: goodRole(cwd), developer: goodRole(cwd) },
      idleSeconds: 60,
    };
    expect(checkConfig(good)).toEqual({ ok: true });
  });
});

describe('条件 11：同一时间只许一个', () => {
  it('锁文件里的进程还活着 → 拒绝；进程不在了 → 放行', () => {
    const dataDir = mkTmp();
    mkdirSync(dataDir, { recursive: true });

    // 活着的进程：拿测试自己的进程号（一定活着）
    writeFileSync(
      join(dataDir, 'lock.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    const busy = acquireLock(dataDir);
    expect(busy.ok).toBe(false);

    // 已经退出的进程：用一个不可能存在的进程号
    writeFileSync(
      join(dataDir, 'lock.json'),
      `${JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    expect(acquireLock(dataDir).ok).toBe(true);
  });
});

describe('条件 5 / 9：命令与记账', () => {
  it('relay once：跑一棒、记一行字段齐全的账', () => {
    const s = setupCli('claim');
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
    expect(row.role).toBe('developer');
    expect(row.kind).toBe('developer-claim');
    expect(row.taskId).toBe('60');
    expect(row.exitCode).toBe(0);
    expect(row.timedOut).toBe(false);
    expect(row.statusBefore).toBe('进行中（dev）');
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
  });

  it('越界之后 once 什么都不跑，resume 之后才接着', () => {
    const s = setupCli('merge-b');
    expect(relay(s.dataDir, ['once']).status).toBe(0);

    const state1 = JSON.parse(readFileSync(join(s.dataDir, 'state.json'), 'utf8')) as {
      stoppedReason?: string | null;
    };
    expect(state1.stoppedReason).toBeTruthy();
    expect(state1.stoppedReason).toContain('b-tier-merged-by-developer');
    const afterFirst = ledgerRows(s.dataDir);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.violations).toContain('b-tier-merged-by-developer');

    // 停住之后：再一次 once 什么都不跑（不新增记账）
    expect(relay(s.dataDir, ['once']).status).toBe(0);
    expect(ledgerRows(s.dataDir)).toHaveLength(1);

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

  it('锁被别的活着的进程占着 → once 拒绝启动，并说清是哪个进程号', () => {
    const s = setupCli('claim');
    writeFileSync(
      join(s.dataDir, 'lock.json'),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    const r = relay(s.dataDir, ['once']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(String(process.pid));
    expect(ledgerRows(s.dataDir)).toHaveLength(0);
  });
});
