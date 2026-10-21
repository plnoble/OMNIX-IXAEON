/**
 * L1b 验收测试（一）：跑一棒（规格条件 5、6、7、8，对应规格第 6、7 条）。2026-10-21 整合方按拆法改名（跑一棒归 L1b）。
 *
 * 逐条对应：
 * - 条件 5：替身命令行收到了 {prompt_file} 换成的真路径、在配置的 cwd 里跑；标准输出、错误输出存进
 *   turns/<编号>/。
 * - 条件 6：替身自己再拉起一个子进程、然后一直不退 → 超过超时（测试里把单位换小）之后，它和它的子进程都被杀掉；
 *   timedOut: true。
 * - 条件 7：替身输出里有配置的额度字样 → 那个角色歇到点（state.pausedUntil[role] = 现在 + quotaPauseMinutes）。
 * - 条件 8：替身输出 Claude 那种带 total_cost_usd 的 JSON → 记 costUsd；输出 Codex 那种带 usage 的 JSONL → 记 token 数。
 *
 * 替身是测试自己在临时目录里写的小脚本，全在临时目录里跑，不调真的模型。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decideNextTurn,
  runTurn,
  type RelayConfig,
  type RelayState,
  type Turn,
} from '../../src/index.js';

const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l1-run-'));
  dirs.push(d);
  return d;
};
/** 测试失败时留下的替身进程，收尾时清掉（别让一个十分钟的进程挂在机器上）。 */
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* 已经不在了 */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 替身脚本：argv[0] 是 {prompt_file}，后面是 --mode 和 --pidfile。 */
const STUB = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const promptFile = argv[0];',
  'const mode = argv[argv.indexOf("--mode") + 1] ?? "ok";',
  'const pidfile = argv[argv.indexOf("--pidfile") + 1];',
  'const say = (s) => console.log(s);',
  'if (mode === "ok") {',
  '  say(JSON.stringify({ promptFile, cwd: process.cwd(), turn: argv }));',
  '  console.error("替身的 stderr：一行");',
  '  say("RELAY-DONE 60 待复审（整合方）");',
  '} else if (mode === "cost") {',
  '  say(JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.25 }));',
  '} else if (mode === "tokens") {',
  '  say(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }));',
  '  say(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 3 } }));',
  '} else if (mode === "twodone") {',
  '  say("先照抄一遍交代：RELAY-DONE 60 <这一行现在的状态>");',
  '  say("RELAY-DONE 60 进行中（dev）");',
  '  say("又做了一点");',
  '  say("RELAY-DONE 60 待复审（整合方）");',
  '} else if (mode === "quota-stderr") {',
  '  console.error("ERROR: usage_limit_reached");',
  '  process.exit(1);',
  '} else if (mode === "quota") {',
  '  say("usage_limit_reached: session limit");',
  '  process.exit(3);',
  '} else if (mode === "timeout") {',
  // 整合方改（2026-10-21）：子进程要 detached。Windows 上 Node 拉起的子进程默认跟父进程绑在一起
  // （父进程一死它就跟着死），那样「只杀替身、不杀子进程」也测不出来；真的命令行拉起的子进程不是这样。
  '  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", detached: true });',
  '  if (pidfile) writeFileSync(pidfile, JSON.stringify({ stub: process.pid, child: child.pid }), "utf8");',
  '  await new Promise(() => {});',
  '}',
  '',
].join('\n');

function setup(mode: string, over: Partial<RelayConfig['roles']['developer']> = {}) {
  const root = mkTmp();
  const cwd = join(root, 'dev-cwd');
  const dataDir = join(root, 'relay');
  const stub = join(root, 'stub-role.mjs');
  const pidfile = join(root, 'pids.json');
  // 目录要存在（配置检查会拒绝不存在的 cwd）
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stub, STUB, 'utf8');
  const config: RelayConfig = {
    roles: {
      integrator: {
        argv: [process.execPath, stub, '{prompt_file}', '--mode', 'ok', '--pidfile', pidfile],
        cwd,
        timeoutMinutes: 60,
        quotaPatterns: ['usage_limit_reached', 'session limit'],
        quotaPauseMinutes: 200,
      },
      developer: {
        argv: [process.execPath, stub, '{prompt_file}', '--mode', mode, '--pidfile', pidfile],
        cwd,
        timeoutMinutes: 60,
        quotaPatterns: ['usage_limit_reached', 'session limit'],
        quotaPauseMinutes: 200,
        ...over,
      },
    },
    idleSeconds: 60,
  };
  const state: RelayState = { stoppedReason: null, pausedUntil: {}, turns: 0 };
  const turn: Turn = {
    role: 'developer',
    kind: 'developer-claim',
    taskId: '60',
    task: 'L1 接力调度器核心',
    status: '待领',
  };
  return { root, cwd, dataDir, stub, pidfile, config, state, turn };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !alive(pid);
};

describe('条件 5：替身收到真路径、在配置的 cwd 里跑、输出落进 turns/<编号>/', () => {
  it('{prompt_file} 换成真路径，cwd 是配置里的那个，stdout/stderr 都存下来', async () => {
    const s = setup('ok');
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 1 });

    const promptPath = join(s.dataDir, 'turns', '1', 'prompt.md');
    expect(result.promptPath).toBe(promptPath);
    expect(existsSync(promptPath)).toBe(true);

    const stdoutPath = join(s.dataDir, 'turns', '1', 'stdout.txt');
    const stderrPath = join(s.dataDir, 'turns', '1', 'stderr.txt');
    expect(result.stdoutPath).toBe(stdoutPath);
    expect(result.stderrPath).toBe(stderrPath);
    const stdout = readFileSync(stdoutPath, 'utf8');
    const stderr = readFileSync(stderrPath, 'utf8');
    const first = JSON.parse(stdout.split('\n')[0]!) as { promptFile: string; cwd: string };

    expect(first.promptFile).toBe(promptPath);
    expect(first.cwd).toBe(s.cwd);
    expect(stderr).toContain('替身的 stderr');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.quotaHit).toBe(false);
    expect(result.doneLine).toBe('RELAY-DONE 60 待复审（整合方）');
  });
});

// 整合方补（2026-10-21，复审实现时）：嵌在参数里的 {prompt_file} 也要换；RELAY-DONE 取最后一行
describe('条件 5（整合方补）：参数里嵌着的 {prompt_file}、最后一行 RELAY-DONE', () => {
  it('参数是「file={prompt_file}」→ 替身收到「file=<真路径>」', async () => {
    const s = setup('ok');
    s.config.roles.developer.argv = [
      process.execPath,
      s.stub,
      'file={prompt_file}',
      '--mode',
      'ok',
    ];
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 8 });
    const stdout = readFileSync(result.stdoutPath, 'utf8');
    const first = JSON.parse(stdout.split('\n')[0]!) as { promptFile: string };
    expect(first.promptFile).toBe(`file=${result.promptPath}`);
  });

  it('输出里有几行 RELAY-DONE → 取最后一行（交代里要的是最后一行）', async () => {
    const s = setup('twodone');
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 9 });
    expect(result.doneLine).toBe('RELAY-DONE 60 待复审（整合方）');
  });
});

describe('条件 6：超时连子进程一起杀', () => {
  it('替身拉起子进程后一直不退 → 超时后两个进程都不在了，timedOut: true', async () => {
    const s = setup('timeout');
    const started = Date.now();
    const result = await runTurn(s.turn, s.config, s.state, {
      dataDir: s.dataDir,
      turnNumber: 2,
      timeoutMs: 4000,
    });
    const elapsed = Date.now() - started;
    const pids = JSON.parse(readFileSync(s.pidfile, 'utf8')) as { stub: number; child: number };
    leftovers.push(pids.stub, pids.child);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // 等够了超时（4s）才退，但远不到「一直不退」
    expect(elapsed).toBeGreaterThan(3_000);
    expect(elapsed).toBeLessThan(60_000);

    expect(pids.child).toBeGreaterThan(0);
    expect(await waitDead(pids.stub)).toBe(true);
    expect(await waitDead(pids.child)).toBe(true);
  });
});

describe('条件 7：额度字样 → 那个角色歇到点', () => {
  it('输出里有配置的额度字样 → quotaHit: true，pausedUntil 是「现在 + quotaPauseMinutes」', async () => {
    const s = setup('quota', { quotaPauseMinutes: 200 });
    const before = Date.now();
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 3 });
    const after = Date.now();

    expect(result.quotaHit).toBe(true);
    expect(s.state.pausedUntil.developer).toBeTruthy();
    const until = Date.parse(s.state.pausedUntil.developer!);
    expect(until).toBeGreaterThanOrEqual(before + 200 * 60_000 - 5_000);
    expect(until).toBeLessThanOrEqual(after + 200 * 60_000 + 5_000);

    // 歇着期间：开发的活跳过（队列里只有一行「待领」，于是谁也领不了）
    const queue = [
      '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
      '| ---- | ---- | ------------ | ---- | ---- | ---- |',
      '| 60 | L1 接力调度器核心 | [L1](L1.md) | B | 无 | 待领 |',
    ].join('\n');
    expect(decideNextTurn(queue, s.state, new Date(after))).toEqual({ idle: 'all-blocked' });
  });

  // 整合方补：规格第 3 条「不分大小写」
  it('额度字样不分大小写：配置写 Session Limit，输出是 session limit → 也算撞上', async () => {
    const s = setup('quota', { quotaPatterns: ['Session Limit'], quotaPauseMinutes: 30 });
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 6 });
    expect(result.quotaHit).toBe(true);
    expect(s.state.pausedUntil.developer).toBeTruthy();
  });

  it('没撞额度 → 不歇', async () => {
    const s = setup('ok');
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 7 });
    expect(result.quotaHit).toBe(false);
    expect(s.state.pausedUntil.developer).toBeUndefined();
  });

  // 整合方补（2026-10-21，复审实现时）：Codex 这类命令行把额度错误打在错误输出里
  it('额度字样只出现在错误输出里 → 也算撞上', async () => {
    const s = setup('quota-stderr');
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 10 });
    expect(result.quotaHit).toBe(true);
    expect(s.state.pausedUntil.developer).toBeTruthy();
  });
});

describe('条件 8：用量', () => {
  it('Claude 那种带 total_cost_usd 的 JSON → usage.costUsd', async () => {
    const s = setup('cost');
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 4 });
    expect(result.usage?.costUsd).toBe(0.25);
  });

  it('Codex 那种带 usage 的 JSONL → token 数加总', async () => {
    const s = setup('tokens');
    const result = await runTurn(s.turn, s.config, s.state, { dataDir: s.dataDir, turnNumber: 5 });
    expect(result.usage?.inputTokens).toBe(105);
    expect(result.usage?.outputTokens).toBe(23);
  });
});
