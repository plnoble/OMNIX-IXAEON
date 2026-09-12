import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ErrorCodes, IxaError, type CodingTask } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { CodingTaskStore } from './taskStore.js';
import { SkillCandidateStore } from '../runtime/skills.js';

const PLACEHOLDER_VERIFY = ['node', '-e', 'process.exit(0)'];

export function isPlaceholderVerifyCommand(argv: string[]): boolean {
  return (
    argv.length === PLACEHOLDER_VERIFY.length && argv.every((p, i) => p === PLACEHOLDER_VERIFY[i])
  );
}

/** 探针任务默认：检查 note.txt 存在且非空。不是无条件成功。 */
export const DEFAULT_NOTE_VERIFY: string[][] = [
  [
    process.execPath,
    '-e',
    "const fs=require('fs');const p='note.txt';if(!fs.existsSync(p))process.exit(2);if(!String(fs.readFileSync(p,'utf8')).trim())process.exit(3);",
  ],
];

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
  exitCode: number | null;
  output: string;
  ran: boolean;
}

/**
 * Fake 执行器：测试与未授权真实工具时使用。
 * 不调用 Codex，不拼 shell；只按任务写入隔离工作区。
 */
export class FakeCodingExecutor implements CodingExecutor {
  readonly name = 'fake';
  lastGoal = '';
  constructor(
    private readonly behavior: {
      claimedSuccess?: boolean;
      files?: Record<string, string>;
      testsModified?: boolean;
      summary?: string;
    } = {},
  ) {}

  async run(task: CodingTask, workspace: string, _signal: AbortSignal): Promise<ExecutorReport> {
    this.lastGoal = task.goal;
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
/**
 * 执行器自建的报告通道文件（codex -o 落点）。它是基础设施不是任务交付物：
 * codex 的 workspace-write 沙箱只允许写工作区内，通道文件必须留在工作区，
 * 但不得计入「改动范围」守卫——那会把每次真实执行误判为越界。
 * 通道内容只用于摘要展示，验收始终走独立验证命令。
 */
export const EXECUTOR_CHANNEL_FILE = '.ixaeon-last-message.txt';

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
    const outFile = join(workspace, EXECUTOR_CHANNEL_FILE);
    const argv = [
      'exec',
      '--sandbox',
      this.locator.sandbox,
      // Windows 上 --ignore-user-config 会一并丢掉用户 config.toml 里的
      // [windows] sandbox = "elevated"（本机 codex 写文件靠它）；显式补回这一条，
      // 其余用户配置（MCP/插件/钩子）仍保持忽略。
      ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
      '-C',
      workspace,
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--color',
      'never',
      '--json',
      '-o',
      outFile,
      task.goal,
    ];
    const raw = await spawnCodexExec(this.locator.exe, argv, workspace, task.timeout_ms, signal);
    const last = existsSync(outFile)
      ? readFileSync(outFile, 'utf8')
      : raw.lastMessage || raw.stdout;
    return {
      claimedSuccess: raw.turnCompleted || raw.exitCode === 0,
      summary: last.slice(0, 2000) || `codex exit ${raw.exitCode}`,
      changedPaths: [],
      testsModified: false,
      raw: [
        last.slice(0, 8000),
        raw.killedAfterTurn ? '\n[codex 进程在 turn.completed 后未自行退出，已终止进程树]' : '',
      ].join(''),
    };
  }
}

/**
 * codex exec 的进程监督（0.130.0-alpha.5 Windows 实测）：
 * - --json 每行一个事件；turn.completed 是协议层的回合终点。
 * - elevated 沙箱下进程在 turn.completed 之后可能不退出（收尾挂起），
 *   因此以 turn.completed 为准，给 10s 自然退出宽限，到点终止进程树；
 *   被终止发生在工作完成之后，不影响磁盘交付物与 -o 报告。
 * - 无 turn.completed 的真挂死仍走 timeoutMs 超时，任务诚实失败。
 */
function spawnCodexExec(
  exe: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{
  exitCode: number | null;
  turnCompleted: boolean;
  killedAfterTurn: boolean;
  stdout: string;
  lastMessage: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, {
      cwd,
      env: minimalChildEnv(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let turnCompleted = false;
    let lastMessage = '';
    let settled = false;
    let exited: number | null = null;
    const finish = (killedAfterTurn: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: exited, turnCompleted, killedAfterTurn, stdout, lastMessage });
    };
    const stop = () => {
      if (child.pid) killProcessTree(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      stop();
      reject(
        new IxaError(
          ErrorCodes.JOB_CANCELLED,
          turnCompleted
            ? `执行超时（${timeoutMs} ms）且未见 turn.completed 后的退出，已停止本次子进程`
            : `执行超时（${timeoutMs} ms），已停止本次子进程`,
        ),
      );
      settled = true;
    }, timeoutMs);
    const onAbort = () => {
      stop();
    };
    signal.addEventListener('abort', onAbort);
    const handleLine = (line: string) => {
      if (!line) return;
      if (line.includes('"type":"turn.completed"')) {
        turnCompleted = true;
        // 工作已到协议终点：10s 自然退出宽限，随后终止进程树收尾。
        setTimeout(() => {
          if (!settled) {
            if (exited === null) stop();
            finish(true);
          }
        }, 10_000);
      }
      if (line.includes('"type":"item.completed"')) {
        const m = /"text":"((?:[^"\\]|\\.)*)"/.exec(line);
        if (m) {
          try {
            lastMessage = JSON.parse(`"${m[1]}"`) as string;
          } catch {
            /* 保留上一条 */
          }
        }
      }
    };
    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      stdout += text;
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
      lineBuf += text;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleLine(lineBuf.slice(0, nl).trim());
        lineBuf = lineBuf.slice(nl + 1);
      }
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
      if (stderr.length > 50_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
      settled = true;
    });
    child.on('close', (code) => {
      exited = code ?? (turnCompleted ? 0 : 1);
      if (turnCompleted) finish(false);
      else finish(false);
    });
  });
}

function spawnArgv(
  exe: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  _dropEnv: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, {
      cwd,
      env: minimalChildEnv(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const stop = () => {
      if (child.pid) killProcessTree(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      stop();
      reject(
        new IxaError(ErrorCodes.JOB_CANCELLED, `执行超时（${timeoutMs} ms），已停止本次子进程`),
      );
    }, timeoutMs);
    const onAbort = () => {
      stop();
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
      allowedCommands: [
        [
          process.execPath,
          '-e',
          "const fs=require('fs');if(!fs.existsSync('research-followup.md'))process.exit(2);",
        ],
      ],
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
    if (['completed', 'cancelled', 'failed', 'unknown'].includes(task.status)) {
      throw new IxaError(ErrorCodes.CONFLICT, `已结束任务不能再派发（${task.status}）`);
    }
    if (task.status === 'running' || task.status === 'pending_verify') {
      throw new IxaError(ErrorCodes.CONFLICT, '任务已在执行或验证，不能重复派发');
    }
    this.store.liveApproval(task);
    this.running = true;
    this.currentTaskId = taskId;
    this.currentAbort = new AbortController();
    const generation = task.generation;
    const workspace = task.workspace_path!;
    const before = hashWorkspace(workspace);
    this.store.setStatus(taskId, 'running', { executorName: this.executor.name });
    try {
      const bg = this.store.taskBackground(task);
      const skills = new SkillCandidateStore(this.db).approvedForProject(task.project_id);
      const dispatched: CodingTask = {
        ...task,
        goal: [
          task.goal,
          `可修改范围：${(JSON.parse(task.scope_json) as string[]).join(', ')}`,
          bg.statements.length > 0 ? `获准背景：\n${bg.statements.join('\n')}` : '获准背景：无',
          skills.length > 0
            ? `获准 Skill（用户已对照批准）：\n${skills.map((s) => `- ${s.title}: ${s.method}`).join('\n')}`
            : '获准 Skill：无',
        ].join('\n\n'),
      };
      const report = await this.executor.run(dispatched, workspace, this.currentAbort.signal);
      if (this.store.get(taskId).generation !== generation) {
        return this.store.setStatus(taskId, 'cancelled', {
          error: '取消后的晚到成功不覆盖取消',
          executorReportJson: JSON.stringify(report),
        });
      }
      const after = hashWorkspace(workspace);
      const actualChanged = diffWorkspace(before, after).filter((p) => p !== EXECUTOR_CHANNEL_FILE);
      const claimed = report.changedPaths.map((p) => p.replaceAll('\\', '/'));
      const changed = uniquePaths([...claimed, ...actualChanged]);
      this.store.assertChangedPathsInScope(task, changed);
      const testsModified = changed.some((p) => /test/i.test(p)) || report.testsModified;
      const merged: ExecutorReport = { ...report, changedPaths: changed, testsModified };
      if (!report.claimedSuccess) {
        const failed = this.store.setStatus(taskId, 'failed', {
          executorName: this.executor.name,
          executorReportJson: JSON.stringify(merged),
          testsModified,
          error: '执行器未声称成功，不把验证命令当成完成',
        });
        this.recordWorkRun(failed, 'failed');
        return failed;
      }
      this.store.setStatus(taskId, 'pending_verify', {
        executorName: this.executor.name,
        executorReportJson: JSON.stringify(merged),
        testsModified,
      });
      return this.verify(taskId, generation);
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

  async verify(taskId: string, generation?: number): Promise<CodingTask> {
    const task = this.store.get(taskId);
    const gen = generation ?? task.generation;
    if (task.status === 'cancelled' || task.generation !== gen) {
      return this.store.setStatus(taskId, 'cancelled', {
        error: '取消后的晚到验证不覆盖取消',
      });
    }
    const allowed = JSON.parse(task.allowed_commands_json) as string[][];
    const realCmds = allowed.filter((cmd) => cmd.length > 0);
    if (realCmds.length === 0) {
      return this.store.setStatus(taskId, 'pending_accept', {
        verifyStatus: 'not_run',
        verifyOutput: '没有有效验证命令，保留未运行',
      });
    }
    const outputs: string[] = [];
    for (const cmd of realCmds) {
      if (this.store.get(taskId).generation !== gen) {
        return this.store.setStatus(taskId, 'cancelled', {
          error: '取消后的晚到验证不覆盖取消',
        });
      }
      this.store.assertCommandAllowed(task, cmd);
      const result = await this.runCheck(cmd, task.workspace_path!);
      if (this.store.get(taskId).generation !== gen) {
        return this.store.setStatus(taskId, 'cancelled', {
          error: '取消后的晚到验证不覆盖取消',
          verifyOutput: result.output.slice(0, 8000),
        });
      }
      if (!result.ran) {
        return this.store.setStatus(taskId, 'pending_accept', {
          verifyStatus: 'not_run',
          verifyExitCode: null,
          verifyOutput: result.output || '验证未运行',
        });
      }
      outputs.push(`${cmd.join(' ')} → ${result.exitCode}\n${result.output}`);
      if (result.exitCode !== 0) {
        const failed = this.store.setStatus(taskId, 'failed', {
          verifyStatus: 'failed',
          verifyExitCode: result.exitCode,
          verifyOutput: outputs.join('\n---\n').slice(0, 8000),
          error: '独立验证失败，不把执行器自报当作通过',
        });
        this.recordWorkRun(failed, 'failed');
        return failed;
      }
    }
    return this.store.setStatus(taskId, 'pending_accept', {
      verifyStatus: 'passed',
      verifyExitCode: 0,
      verifyOutput: outputs.join('\n---\n').slice(0, 8000),
      error: null,
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
    const now = new Date().toISOString();
    this.recordWorkRun(task, task.verify_status === 'passed' ? 'success' : 'partial', now);
    return this.store.setStatus(taskId, 'completed', {
      acceptedAt: now,
    });
  }

  private recordWorkRun(
    task: CodingTask,
    outcome: 'success' | 'partial' | 'failed',
    now = new Date().toISOString(),
  ): void {
    const clientRef = `coding-task:${task.id}:v${task.version}:${outcome}`;
    const exists = this.db
      .prepare('SELECT 1 AS ok FROM work_runs WHERE client_ref = ?')
      .get(clientRef) as { ok: number } | undefined;
    if (exists) return;
    const report = task.executor_report_json
      ? (JSON.parse(task.executor_report_json) as Partial<ExecutorReport>)
      : {};
    this.db
      .prepare(
        `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary,
           changes_json, tests_json, open_loops_json, commit_ref, finished_at, client_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        task.project_id,
        task.executor_name ?? this.executor.name,
        task.goal,
        outcome,
        report.summary ?? task.verify_output ?? task.error ?? '任务结束（未部署）',
        JSON.stringify(report.changedPaths ?? []),
        JSON.stringify({
          verify_status: task.verify_status,
          verify_exit_code: task.verify_exit_code,
        }),
        JSON.stringify([]),
        task.snapshot_ref,
        now,
        clientRef,
      );
    if (outcome === 'failed') {
      new SkillCandidateStore(this.db).proposeFromFailure({
        projectId: task.project_id,
        workRunId: clientRef,
        task: task.goal,
        summary: String(task.error ?? report.summary ?? '执行失败'),
      });
    }
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
  if (isPlaceholderVerifyCommand(argv)) {
    return {
      argv,
      exitCode: null,
      output: '拒绝无条件成功命令 process.exit(0)，不算验证',
      ran: false,
    };
  }
  try {
    const exe = argv[0]!;
    const rest = argv.slice(1);
    const restricted =
      (exe === process.execPath || /node(\.exe)?$/i.test(exe)) && !rest.includes('--permission');
    const finalArgv = restricted
      ? ['--permission', `--allow-fs-read=${cwd}`, `--allow-fs-write=${cwd}`, ...rest]
      : rest;
    const raw = await spawnArgv(exe, finalArgv, cwd, 60_000, new AbortController().signal, {});
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.replaceAll('\\', '/')))];
}

function hashWorkspace(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else {
        const rel = relative(root, abs).replaceAll('\\', '/');
        map.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
      }
    }
  };
  walk(root);
  return map;
}

function diffWorkspace(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.push(path);
  }
  return changed;
}

function minimalChildEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'ComSpec',
    'COMSPEC',
    'ProgramFiles',
    'ProgramW6432',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env;
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
