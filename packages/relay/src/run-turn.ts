/** 跑一棒（第 6、7 条）：照配置调起命令行、输出落盘、超时杀**它自己拉起的那一棵**进程树、用量与额度。 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTurnPrompt } from './prompt.js';
import type { RelayConfig, RelayState, Turn } from './types.js';

export interface Usage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}
export interface TurnResult {
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  exitCode: number | null;
  timedOut: boolean;
  quotaHit: boolean;
  doneLine: string | null;
  usage?: Usage;
}

/** 只杀自己拉起的那一棵（照 scripts/real/run-batch.mjs）。 */
function killTree(pid?: number): void {
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

/** 标准输出里的用量：`total_cost_usd` / `usage.input_tokens`、`output_tokens`（加总）。 */
function usageOf(stdout: string): Usage | undefined {
  const u: Usage = {};
  for (const line of stdout.split('\n')) {
    try {
      const j = JSON.parse(line) as {
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (typeof j.total_cost_usd === 'number') u.costUsd = j.total_cost_usd;
      const add = (n: number | undefined, f: 'inputTokens' | 'outputTokens') => {
        if (typeof n === 'number') u[f] = (u[f] ?? 0) + n;
      };
      add(j.usage?.input_tokens, 'inputTokens');
      add(j.usage?.output_tokens, 'outputTokens');
    } catch {
      /* 不是 JSON 的行不算 */
    }
  }
  return Object.keys(u).length ? u : undefined;
}

export async function runTurn(
  turn: Turn,
  config: RelayConfig,
  state: RelayState,
  opts: { dataDir: string; turnNumber: number; timeoutMs?: number },
): Promise<TurnResult> {
  const role = config.roles[turn.role];
  const dir = join(opts.dataDir, 'turns', String(opts.turnNumber));
  const promptPath = writeTurnPrompt(turn, { dataDir: opts.dataDir, turnNumber: opts.turnNumber });
  const argv = role.argv.map((a) => (a === '{prompt_file}' ? promptPath : a));
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: role.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
  });
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString('utf8');
  });
  let timedOut = false;
  const onTimeout = () => {
    timedOut = true;
    killTree(child.pid);
  };
  const timer = setTimeout(onTimeout, opts.timeoutMs ?? role.timeoutMinutes * 60_000);
  const code = await new Promise<number | null>((r) => {
    child.on('close', (c) => r(c));
    child.on('error', () => r(null));
  });
  clearTimeout(timer);
  if (timedOut) killTree(child.pid);
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  writeFileSync(stdoutPath, out, 'utf8');
  writeFileSync(stderrPath, err, 'utf8');
  const hay = `${out}\n${err}`.toLowerCase();
  const quotaHit = role.quotaPatterns.some((p) => p.trim() && hay.includes(p.trim().toLowerCase()));
  if (quotaHit) {
    const until = Date.now() + role.quotaPauseMinutes * 60_000;
    state.pausedUntil[turn.role] = new Date(until).toISOString();
  }
  const lines = out.split('\n').map((l) => l.trim());
  return {
    promptPath,
    stdoutPath,
    stderrPath,
    exitCode: timedOut ? null : code,
    timedOut,
    quotaHit,
    doneLine: lines.find((l) => l.startsWith('RELAY-DONE')) ?? null,
    usage: usageOf(out),
  };
}
