/**
 * MP3d / MP3e：开发工具的起进程参数、读结果与两个执行器。
 *
 * 子进程环境用 Codex 那套最小环境（`minimalChildEnv`）；只额外给 Claude Code / DSH 补
 * `APPDATA` / `LOCALAPPDATA`（只是路径，不是密钥）。取消与超时都杀整棵进程树。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingTask } from '@ixaeon/contracts';
import {
  killProcessTree,
  minimalChildEnv,
  type CodingExecutor,
  type ExecutorReport,
  type ExecutorRunOptions,
} from './executor.js';

export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const TAIL = 4000;

export function claudeCodeLaunch(input: {
  exe: string;
  goal: string;
  workspace: string;
  model?: ClaudeModel;
  mode?: string;
}): { command: string; args: string[]; cwd: string } {
  const args = [
    '-p',
    input.goal,
    '--output-format',
    'json',
    '--permission-mode',
    input.mode ?? 'acceptEdits',
  ];
  if (input.model) args.push('--model', input.model);
  return { command: input.exe, args, cwd: input.workspace };
}

export function parseClaudeCodeOutput(
  stdout: string,
  exitCode: number | null,
): { ok: boolean; summary: string } {
  if (exitCode !== 0) return { ok: false, summary: '' };
  let parsed: { result?: unknown; is_error?: unknown } | null = null;
  try {
    parsed = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
  } catch {
    return { ok: false, summary: '' };
  }
  if (!parsed || parsed.is_error === true) return { ok: false, summary: '' };
  const summary = typeof parsed.result === 'string' ? parsed.result : '';
  return { ok: summary.length > 0, summary };
}

export function dshLaunch(input: {
  install: string;
  goal: string;
  workspace: string;
  baseEnv: NodeJS.ProcessEnv;
}): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const cli = join(
    input.install,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  return {
    command: join(input.install, 'DeepSeek Harness.exe'),
    args: [cli, '--profile', 'headless', '--json', input.goal],
    cwd: input.workspace,
    env: { ...input.baseEnv, ELECTRON_RUN_AS_NODE: '1' },
  };
}

export function parseDshOutput(
  stdout: string,
  exitCode: number | null,
): { ok: boolean; summary: string } {
  if (exitCode !== 0) return { ok: false, summary: '' };
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]!) as { type?: string; text?: unknown };
      if (obj.type === 'final') {
        const summary = typeof obj.text === 'string' ? obj.text : '';
        return { ok: summary.length > 0, summary };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, summary: '' };
}

/** 只补路径变量（不是密钥），其余跟 Codex 执行器同一个最小环境。 */
function toolEnv(): NodeJS.ProcessEnv {
  const env = minimalChildEnv();
  for (const key of ['APPDATA', 'LOCALAPPDATA'] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function tail(text: string, n = TAIL): string {
  return text.length > n ? text.slice(-n) : text;
}

function failureReport(summary: string, stdout: string, stderr: string): ExecutorReport {
  return {
    claimedSuccess: false,
    summary,
    changedPaths: [],
    testsModified: false,
    raw: `${tail(stdout)}\n${tail(stderr)}`.slice(-TAIL * 2),
  };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const stop = (): void => {
      if (child.pid) killProcessTree(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = (): void => {
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr: stderr + String(err), code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** Claude Code 执行器：argv 写死、不拼 shell；失败时给「没做成」的回报（带输出尾巴，供候选串判额度）。 */
export class ClaudeCodeExecutor implements CodingExecutor {
  readonly name = 'claude-code';
  constructor(private readonly opts: { exe: string; model?: ClaudeModel }) {}

  async run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    _options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
    if (!existsSync(this.opts.exe)) {
      return failureReport('没找到 Claude Code，跳过这一项', '', '');
    }
    const launch = claudeCodeLaunch({
      exe: this.opts.exe,
      goal: task.goal,
      workspace,
      model: this.opts.model,
    });
    const r = await runProcess(
      launch.command,
      launch.args,
      launch.cwd,
      toolEnv(),
      signal,
      task.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    );
    if (r.timedOut)
      return failureReport('Claude Code 超时了，已停掉本次子进程', r.stdout, r.stderr);
    const parsed = parseClaudeCodeOutput(r.stdout, r.code);
    if (!parsed.ok) {
      return failureReport(`Claude Code 没做成（退出码 ${String(r.code)}）`, r.stdout, r.stderr);
    }
    return {
      claimedSuccess: true,
      summary: parsed.summary,
      changedPaths: [],
      testsModified: false,
      raw: '',
    };
  }
}

/** DSH 执行器：经 dshLaunch 起桌面版（最小环境 + ELECTRON_RUN_AS_NODE=1），取最后一行 final。 */
export class DshExecutor implements CodingExecutor {
  readonly name = 'dsh';
  constructor(private readonly opts: { install: string }) {}

  async run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    _options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
    const launch = dshLaunch({
      install: this.opts.install,
      goal: task.goal,
      workspace,
      baseEnv: toolEnv(),
    });
    const r = await runProcess(
      launch.command,
      launch.args,
      launch.cwd,
      launch.env,
      signal,
      task.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    );
    if (r.timedOut) return failureReport('DSH 超时了，已停掉本次子进程', r.stdout, r.stderr);
    const parsed = parseDshOutput(r.stdout, r.code);
    if (!parsed.ok) {
      return failureReport(`DSH 没做成（退出码 ${String(r.code)}）`, r.stdout, r.stderr);
    }
    return {
      claimedSuccess: true,
      summary: parsed.summary,
      changedPaths: [],
      testsModified: false,
      raw: '',
    };
  }
}
