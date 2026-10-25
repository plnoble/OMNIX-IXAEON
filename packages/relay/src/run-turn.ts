/** 跑一棒（第 6、7 条）：照配置调起命令行、输出落盘、超时杀**它自己拉起的那一棵**进程树、用量与额度。 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoleOutput } from './output.js';
import { writeTurnPrompt } from './prompt.js';
import { nextWeeklyReset } from './weekly.js';
import type { RelayConfig, RelayState, Turn, Usage } from './types.js';

/** 正在跑的这份代码的仓库根（L10 契约第 5 条：`{relay_root}` 换它）。 */
const RELAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

/** DSH `--json` 里工具调用、工具结果、思考这几种事件：是它读到、想到的，不是命令行自己报的。 */
const NOISE_TYPES = new Set(['tool_call', 'tool_result', 'thinking']);
function agentNoise(line: string): boolean {
  if (!line.startsWith('{')) return false;
  try {
    return NOISE_TYPES.has(String((JSON.parse(line) as { type?: unknown }).type));
  } catch {
    return false;
  }
}

export async function runTurn(
  turn: Turn,
  config: RelayConfig,
  state: RelayState,
  opts: { dataDir: string; turnNumber: number; timeoutMs?: number },
): Promise<TurnResult> {
  const role = config.roles[turn.role];
  const dir = join(opts.dataDir, 'turns', String(opts.turnNumber));
  const promptPath = writeTurnPrompt(turn, {
    dataDir: opts.dataDir,
    turnNumber: opts.turnNumber,
    pushByRelay: role.pushByRelay === true,
    cwd: role.cwd,
  });
  // 整合方改：嵌在参数里的也换（真 Claude 要写成 -p "读 {prompt_file} 照做"）
  // L10 契约第 5 条：`{relay_root}` 一起换，值是正在跑的这份代码的仓库根。
  const argv = role.argv.map((a) =>
    a.split('{prompt_file}').join(promptPath).split('{relay_root}').join(RELAY_ROOT),
  );
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
  // 整合方改（2026-10-23）：额度字样不在 DSH 的工具结果、思考里找——第 3 棒读了写着这些字样的配置，被误判成撞额度。
  const hay = [...out.split('\n').filter((l) => !agentNoise(l.trim())), err]
    .join('\n')
    .toLowerCase();
  const patterns = (list: string[] | undefined): boolean =>
    (list ?? []).some((p) => p.trim() && hay.includes(p.trim().toLowerCase()));
  // L19 契约第 3 条：周额度优先——同一份 hay 里对上周额度就歇到下一个北京时间周四 04:00，
  // 不再加 quotaPauseMinutes；只有会话额度对上时照旧。
  const weeklyHit = patterns(role.weeklyQuotaPatterns);
  const quotaHit = weeklyHit || patterns(role.quotaPatterns);
  if (quotaHit) {
    const until = weeklyHit
      ? nextWeeklyReset(new Date()).getTime()
      : Date.now() + role.quotaPauseMinutes * 60_000;
    state.pausedUntil[turn.role] = new Date(until).toISOString();
  }
  // L2：真 Claude 的 RELAY-DONE 在 result 里、DSH 在 final.text 里，按行找不到
  const parsed = parseRoleOutput(out);
  return {
    promptPath,
    stdoutPath,
    stderrPath,
    exitCode: timedOut ? null : code,
    timedOut,
    quotaHit,
    doneLine: parsed.doneLine,
    usage: parsed.usage,
  };
}
