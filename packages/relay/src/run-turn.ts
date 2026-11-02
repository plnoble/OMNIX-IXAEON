/** 跑一棒（第 6、7 条）：照配置调起命令行、输出落盘、超时杀**它自己拉起的那一棵**进程树、用量与额度。 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoleOutput } from './output.js';
import {
  GATEWAY_NOT_FOUND_LINE,
  isDshLauncher,
  prepareGatewayPatch,
  removeGatewayPatch,
  type GatewayPatch,
} from './gateway.js';
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

/** MG2：magpie 就在本机；只认 http + 本机主机 + 端口，别的地址不拿来起角色（免得把内容发到别处）。 */
function localMagpieBase(raw: string | undefined): string | null {
  const text = (raw ?? '').trim() || 'http://127.0.0.1:3425';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return null;
    if (!url.port || url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return `http://${url.hostname}:${url.port}`;
  } catch {
    return null;
  }
}

export async function runTurn(
  turn: Turn,
  config: RelayConfig,
  state: RelayState,
  opts: {
    dataDir: string;
    turnNumber: number;
    timeoutMs?: number;
    /** L16 契约第 6 条：飞书回复棒交代里要列的原话（runOnce 从 inbox.jsonl 算好传进来）。 */
    inboxMessages?: Array<{ at: string; text: string }>;
  },
): Promise<TurnResult> {
  const role = config.roles[turn.role];
  const dir = join(opts.dataDir, 'turns', String(opts.turnNumber));
  const promptPath = writeTurnPrompt(turn, {
    dataDir: opts.dataDir,
    turnNumber: opts.turnNumber,
    pushByRelay: role.pushByRelay === true,
    cwd: role.cwd,
    inboxMessages: opts.inboxMessages,
  });
  // 整合方改：嵌在参数里的也换（真 Claude 要写成 -p "读 {prompt_file} 照做"）
  // L10 契约第 5 条：`{relay_root}` 一起换，值是正在跑的这份代码的仓库根。
  let argv = role.argv.map((a) =>
    a.split('{prompt_file}').join(promptPath).split('{relay_root}').join(RELAY_ROOT),
  );
  // MG2：整合方选了 magpie 的模型 / 分组 → 照 magpie 的 Claude Code 接法带上网关地址、Key 和 --model。
  // 没选就一个都不加（参数和环境变量和原来逐字一样）。
  let env: NodeJS.ProcessEnv | undefined;
  const magpieModel = turn.role === 'integrator' ? role.magpieModel?.trim() : '';
  if (magpieModel) {
    const base = localMagpieBase(role.magpieUrl);
    if (!base) throw new Error('整合方选了 magpie 的模型，但 magpie 地址不是本机');
    const at = argv.indexOf('--model');
    if (at >= 0) argv.splice(at, at + 1 < argv.length ? 2 : 1);
    argv.push('--model', magpieModel);
    env = { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'magpie' };
    // 用户自己的 Anthropic Key 不能带到 magpie 上（magpie 只认字面量 magpie）。
    delete env.ANTHROPIC_API_KEY;
  }
  // DG1 契约第 1、3 条：DSH 那一棒先从桌面版配置取网关段，插在接力补丁前面；
  // 取不到（配置不存在 / 没有 llm-pi-ai）就照原来的参数起，打一行提示。临时补丁在下面 finally 删。
  let gateway: GatewayPatch | null = null;
  if (isDshLauncher(argv)) {
    gateway = prepareGatewayPatch(argv);
    if (gateway) argv = gateway.argv;
    else console.log(GATEWAY_NOT_FOUND_LINE);
  }
  let out = '';
  let err = '';
  let code: number | null = null;
  let timedOut = false;
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: role.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(env ? { env } : {}),
    });
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    const onTimeout = () => {
      timedOut = true;
      killTree(child.pid);
    };
    const timer = setTimeout(onTimeout, opts.timeoutMs ?? role.timeoutMinutes * 60_000);
    code = await new Promise<number | null>((r) => {
      child.on('close', (c) => r(c));
      child.on('error', () => r(null));
    });
    clearTimeout(timer);
    if (timedOut) killTree(child.pid);
  } finally {
    // 正常、替身崩溃、超时（进程被强杀）三种都在这里删：这一段在调起方（调度器）里跑，
    // 比放在 dsh.mjs 里可靠——超时那一刀会连启动器一起杀掉，启动器自己的 finally 跑不到。
    if (gateway) removeGatewayPatch(gateway.file);
  }
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
