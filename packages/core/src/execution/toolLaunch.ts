/**
 * MP3d / MP3e：起开发工具的参数与读结果，纯函数（执行器只把它们接上进程监督）。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CodingExecutor, ExecutorReport, ExecutorRunOptions } from './executor.js';
import type { CodingTask } from '@ixaeon/contracts';

export type ClaudeModel = 'opus' | 'sonnet' | 'haiku';

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

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('超时'));
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      reject(new Error('用户取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, code });
    });
  });
}

/** Claude Code 执行器：argv 写死、不拼 shell；结果取标准输出 JSON 的 result。 */
export class ClaudeCodeExecutor implements CodingExecutor {
  readonly name = 'claude-code';
  constructor(private readonly opts: { exe: string; model?: ClaudeModel }) {}

  async run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    _options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
    const launch = claudeCodeLaunch({
      exe: this.opts.exe,
      goal: task.goal,
      workspace,
      model: this.opts.model,
    });
    const { stdout, code } = await runProcess(
      launch.command,
      launch.args,
      launch.cwd,
      process.env,
      signal,
      15 * 60_000,
    );
    const parsed = parseClaudeCodeOutput(stdout, code);
    if (!parsed.ok) throw new Error(`Claude Code 执行失败（退出码 ${String(code)}）`);
    return {
      summary: parsed.summary,
      claimedSuccess: true,
      changes: [],
    } as unknown as ExecutorReport;
  }
}
