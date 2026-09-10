import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ErrorCodes, IxaError, type CodingTask } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { CodingTaskStore } from './taskStore.js';

export interface ExecutorReport {
  claimedSuccess: boolean;
  summary: string;
  changedPaths: string[];
  testsModified: boolean;
  raw: string;
}

export interface CodingExecutor {
  readonly name: string;
  run(task: CodingTask, workspace: string, signal: AbortSignal): Promise<ExecutorReport>;
}

export interface IndependentCheck {
  argv: string[];
  exitCode: number;
  output: string;
  ran: boolean;
}

/**
 * Fake 执行器：测试与未授权真实工具时使用。
 * 不调用 Codex，不拼 shell；只按任务写入隔离工作区。
 */
export class FakeCodingExecutor implements CodingExecutor {
  readonly name = 'fake';
  constructor(
    private readonly behavior: {
      claimedSuccess?: boolean;
      files?: Record<string, string>;
      testsModified?: boolean;
      summary?: string;
    } = {},
  ) {}

  async run(task: CodingTask, workspace: string, _signal: AbortSignal): Promise<ExecutorReport> {
    const files = this.behavior.files ?? { 'note.txt': `fake result for ${task.goal}` };
    for (const [rel, body] of Object.entries(files)) {
      if (
        rel.includes('..') ||
        rel.startsWith('/') ||
        rel.startsWith('\\') ||
        /^[a-zA-Z]:/.test(rel)
      ) {
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `假执行器拒绝越界路径：${rel}`);
      }
      const abs = join(workspace, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
    return {
      claimedSuccess: this.behavior.claimedSuccess ?? true,
      summary: this.behavior.summary ?? 'fake executor wrote files',
      changedPaths: Object.keys(files),
      testsModified: this.behavior.testsModified ?? Object.keys(files).some((p) => /test/i.test(p)),
      raw: JSON.stringify(files),
    };
  }
}

export interface CodexLocator {
  exe: string;
  sandbox: 'read-only' | 'workspace-write';
}

const DEFAULT_CODEX_SANDBOX: CodexLocator['sandbox'] = 'workspace-write';

/** 用户已确认的真机隔离默认：workspace-write + 隔离工作区 + 忽略用户更宽配置。 */
export function resolveCodexLocator(): CodexLocator | null {
  const fromEnv = process.env.IXAEON_CODEX_EXE?.trim();
  const localApp = process.env.LOCALAPPDATA;
  const candidates = [
    fromEnv,
    localApp ? join(localApp, 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    'codex',
  ].filter((p): p is string => Boolean(p));
  for (const exe of candidates) {
    if (exe === 'codex') continue;
    if (existsSync(exe)) return { exe, sandbox: DEFAULT_CODEX_SANDBOX };
  }
  return null;
}

/**
 * Codex CLI 适配器：固定 argv，不拼 shell。
 * 用户已确认隔离默认值；工具缺失时抛可操作缺口。
 */
export class CodexCliExecutor implements CodingExecutor {
  readonly name = 'codex-cli';
  constructor(private readonly locator: CodexLocator) {}

  async run(task: CodingTask, workspace: string, signal: AbortSignal): Promise<ExecutorReport> {
    if (!existsSync(this.locator.exe)) {
      throw new IxaError(
        ErrorCodes.NOT_FOUND,
        `Codex CLI 不存在：${this.locator.exe}。请安装或确认路径后再派发。`,
      );
    }
    const outFile = join(workspace, '.ixaeon-last-message.txt');
    const argv = [
      'exec',
      '--sandbox',
      this.locator.sandbox,
      '-C',
      workspace,
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--color',
      'never',
      '-o',
      outFile,
      task.goal,
    ];
    const raw = await spawnArgv(this.locator.exe, argv, workspace, task.timeout_ms, signal, {
      IXAEON_LOCAL_TOKEN: '',
      IXAEON_API_KEY: '',
    });
    const last = existsSync(outFile) ? readFileSync(outFile, 'utf8') : raw.stdout;
    return {
      claimedSuccess: raw.exitCode === 0,
      summary: last.slice(0, 2000) || `codex exit ${raw.exitCode}`,
      changedPaths: [],
      testsModified: false,
      raw: last.slice(0, 8000),
    };
  }
}

function spawnArgv(
  exe: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  dropEnv: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...dropEnv };
    delete env.IXAEON_LOCAL_TOKEN;
    delete env.IXAEON_API_KEY;
    const child = spawn(exe, argv, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new IxaError(ErrorCodes.JOB_CANCELLED, `执行超时（${timeoutMs} ms），已停止本次子进程`),
      );
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
    };
    signal.addEventListener('abort', onAbort);
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
      if (stderr.length > 50_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export class CodingOrchestrator {
  readonly store: CodingTaskStore;
  private running = false;
  private currentAbort: AbortController | null = null;
  private currentTaskId: string | null = null;

  get executorName(): string {
    return this.executor.name;
  }

  constructor(
    private readonly db: CoreDatabase,
    private readonly executor: CodingExecutor,
    private readonly dataDir: string,
    private readonly runCheck: (
      argv: string[],
      cwd: string,
    ) => Promise<IndependentCheck> = defaultCheck,
  ) {
    this.store = new CodingTaskStore(db);
  }

  create(input: Parameters<CodingTaskStore['create']>[0]): CodingTask {
    return this.store.create(input);
  }

  /**
   * 从用户标过「值得行动」的发现开编码草案。不批准、不派发。
   * 同一发现同一项目幂等（dispatch_key）。
   */
  draftFromFinding(input: { findingId: string; projectId?: string | null }): CodingTask {
    const row = this.db
      .prepare('SELECT * FROM research_findings WHERE id = ?')
      .get(input.findingId) as
      | {
          id: string;
          title: string;
          url: string;
          excerpt: string;
          action_worthy: number;
          related_project_id: string | null;
        }
      | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `研究发现不存在: ${input.findingId}`);
    if (!row.action_worthy) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '先把这条发现标为值得行动，再开草案');
    }
    const projectId = input.projectId?.trim() || row.related_project_id;
    if (!projectId) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '开草案需要先选一个项目');
    }
    const goal = `跟进公开发现（不自动部署）：${row.title}\n来源 ${row.url}\n摘录：${row.excerpt.slice(0, 400)}`;
    return this.store.create({
      projectId,
      goal,
      scope: ['research-followup.md'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
      dispatchKey: `research-finding:${row.id}:${projectId}`,
    });
  }

  async approveAndQueue(taskId: string, expiresAt?: string | null): Promise<CodingTask> {
    const prepared = this.store.prepareWorkspace(taskId, this.dataDir);
    this.store.approve({
      taskId,
      workspacePath: prepared.workspace_path!,
      expiresAt: expiresAt ?? null,
    });
    return this.store.get(taskId);
  }

  async dispatch(taskId: string): Promise<CodingTask> {
    if (this.running || this.store.runningCount() > 0) {
      throw new IxaError(ErrorCodes.CONFLICT, '全局同时只允许一个正在执行的编码任务');
    }
    const task = this.store.get(taskId);
    if (task.status === 'cancelled') {
      return task;
    }
    const approval = this.store.liveApproval(task);
    void approval;
    this.running = true;
    this.currentTaskId = taskId;
    this.currentAbort = new AbortController();
    const generation = task.generation;
    this.store.setStatus(taskId, 'running', { executorName: this.executor.name });
    try {
      const report = await this.executor.run(task, task.workspace_path!, this.currentAbort.signal);
      if (this.store.get(taskId).generation !== generation) {
        return this.store.setStatus(taskId, 'cancelled', {
          error: '取消后的晚到成功不覆盖取消',
          executorReportJson: JSON.stringify(report),
        });
      }
      for (const rel of report.changedPaths) {
        this.store.assertPathInWorkspace(task, join(task.workspace_path!, rel));
      }
      this.store.setStatus(taskId, 'pending_verify', {
        executorName: this.executor.name,
        executorReportJson: JSON.stringify(report),
        testsModified: report.testsModified,
      });
      return this.verify(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = this.store.get(taskId).status === 'cancelled' ? 'cancelled' : 'failed';
      return this.store.setStatus(taskId, status, { error: msg });
    } finally {
      this.running = false;
      this.currentAbort = null;
      this.currentTaskId = null;
    }
  }

  async verify(taskId: string): Promise<CodingTask> {
    const task = this.store.get(taskId);
    const allowed = JSON.parse(task.allowed_commands_json) as string[][];
    const checkCmd = allowed[0];
    if (!checkCmd || checkCmd.length === 0) {
      return this.store.setStatus(taskId, 'pending_accept', {
        verifyStatus: 'not_run',
        verifyOutput: '未配置批准的验证命令，保留未运行',
      });
    }
    this.store.assertCommandAllowed(task, checkCmd);
    const result = await this.runCheck(checkCmd, task.workspace_path!);
    if (!result.ran) {
      return this.store.setStatus(taskId, 'pending_accept', {
        verifyStatus: 'not_run',
        verifyExitCode: null,
        verifyOutput: result.output || '验证未运行',
      });
    }
    const verifyStatus = result.exitCode === 0 ? 'passed' : 'failed';
    // 执行器自报成功不能当作验收通过
    const next = verifyStatus === 'passed' ? 'pending_accept' : 'failed';
    return this.store.setStatus(taskId, next, {
      verifyStatus,
      verifyExitCode: result.exitCode,
      verifyOutput: result.output.slice(0, 8000),
      error: verifyStatus === 'failed' ? '独立验证失败，不把执行器自报当作通过' : null,
    });
  }

  accept(taskId: string): CodingTask {
    const task = this.store.get(taskId);
    if (task.status !== 'pending_accept') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '只有待用户接受的任务可以接受');
    }
    if (task.verify_status === 'failed') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '独立验证失败，不能接受为完成');
    }
    return this.store.setStatus(taskId, 'completed', {
      acceptedAt: new Date().toISOString(),
    });
  }

  cancel(taskId: string): CodingTask {
    if (this.currentTaskId === taskId) this.currentAbort?.abort();
    return this.store.cancel(taskId);
  }

  remove(taskId: string): CodingTask {
    const task = this.store.remove(taskId);
    const ws = task.workspace_path;
    if (ws) {
      const root = resolve(join(this.dataDir, 'workspaces'));
      const abs = resolve(ws);
      if (abs === root || abs.startsWith(root + '\\') || abs.startsWith(root + '/')) {
        rmSync(abs, { recursive: true, force: true });
      }
    }
    return task;
  }
}

async function defaultCheck(argv: string[], cwd: string): Promise<IndependentCheck> {
  try {
    const raw = await spawnArgv(
      argv[0]!,
      argv.slice(1),
      cwd,
      60_000,
      new AbortController().signal,
      {},
    );
    return {
      argv,
      exitCode: raw.exitCode,
      output: `${raw.stdout}\n${raw.stderr}`.trim(),
      ran: true,
    };
  } catch (err) {
    return {
      argv,
      exitCode: 1,
      output: err instanceof Error ? err.message : String(err),
      ran: true,
    };
  }
}
