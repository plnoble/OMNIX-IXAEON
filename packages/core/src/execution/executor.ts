import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCodes, IxaError, type CodingTask } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { CodingTaskStore } from './taskStore.js';
import { landTask, toLf } from './landing.js';
import { FORBIDDEN_DIRS } from './workspaceCopy.js';
import { SkillCandidateStore } from '../runtime/skills.js';
import {
  checkSandboxAuth,
  ensureSandboxProfileConfig,
  locateCodexExecutable,
  SANDBOX_PROFILE,
  sandboxHomeDir,
  type SandboxAuthResult,
} from './verifySandbox.js';

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
  /**
   * D4（契约 3）：派发时记下每个改动文件**改之前**的指纹（hashWorkspace(before)），
   * 新文件记为 null（不存在）。落地时与项目当前 HEAD 比对，对不上就是冲突。
   */
  baseHashes?: Record<string, string | null>;
  /**
   * D5a：这次任务的验收测试。只有走「验收先行」的任务才有（有验收条件、没有验证命令）。
   * files 是第 1 步写出来的测试文件；locked 是锁没锁定；没锁定时 reason 是原因。
   */
  acceptanceTests?: { files: string[]; locked: boolean; reason: string | null };
}

/** D5a：验收测试所在的目录名（副本里的 ixaeon-acceptance/<任务号前 8 位>/）。 */
export const ACCEPTANCE_DIR = 'ixaeon-acceptance';

/** D5a：执行器的一次运行还能看哪些文件（内容发给执行器，但不许改）。 */
export interface ExecutorRunOptions {
  /** 这些文件的内容给执行器看，但不许改。能改什么仍由任务的 scope 定。 */
  readScope?: string[];
}

/** 沙箱不肯跑、又没给说明时写的话（给了说明就用它的）。 */
const SANDBOX_SILENT = '验证的沙箱不肯跑，也没给说明';

/** 标题一行，下面每条一行、编上号。 */
const numbered = (title: string, items: string[]): string =>
  `${title}\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;

/**
 * D5a 契约 5：给执行器的三段交代。原文写死在规格里，改措辞要先改规格和锁定的验收测试。
 */
function writeTestsBrief(goal: string, conditions: string[], testDir: string): string {
  return [
    '这一步只写验收测试，不要写实现。',
    `要做的事：\n${goal}`,
    numbered('验收条件：', conditions),
    [
      '怎么写：',
      `- 测试文件放在 ${testDir}/ 下，文件名以 .test.mjs 结尾。别的文件一个都不要动。`,
      '- 用 node:test 和 node:assert/strict，不用任何 npm 包。每个文件要能用「node 文件名」直接跑；有测试不通过时退出码不是 0。',
      '- 跑的时候当前目录是项目根目录；引入项目里的模块，要从测试文件所在的目录往上两级（../../）。',
      '- 每条验收条件至少有一个测试，测试的名字以「条件 N：」开头。',
      '- 测试跑的时候不能联网、不能起别的进程，只能读项目目录里的文件；不要改项目里的文件。',
      '- 实现现在还没有写：这些测试现在应该不通过，实现写对之后才通过。',
      '- 有的条件没法这样自动测（比如要人看界面、要联网）：不要硬凑，在 summary 里写明是哪几条、为什么。一条都测不了就不要写文件，把 claimedSuccess 设为 false，在 summary 里说明。',
    ].join('\n'),
  ].join('\n\n');
}
function lockedBrief(files: string[], testDir: string): string {
  return [
    `验收测试已经写好并锁定：${files.join('，')}。`,
    `- 不许改这些文件，也不许在 ${testDir}/ 下增删文件；改了这次任务就算失败。`,
    '- 做完的标准是它们全部通过（每个文件用「node 文件名」跑）。',
  ].join('\n');
}
function unlockedBrief(testDir: string): string {
  return [
    `${testDir}/ 下是这次任务写的验收测试，没有锁定，不拿它们当验证。`,
    `- 不要改、不要删这些文件，也不要往 ${testDir}/ 下加文件；动了这次任务就算失败。`,
  ].join('\n');
}

/** 执行器说的话只留开头一段：它要进回报，回报又进对话。 */
function clip(said: string): string {
  const text = said.trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * 把验证输出里副本的绝对路径换成「<副本>」。那个路径里有本机的用户名，而输出会进回报、
 * 进对话，再随对话历史发给模型；node:test 的报错里到处是这种路径。
 */
function hideWorkspacePath(text: string, workspace: string): string {
  const dirs = [workspace];
  try {
    // 系统临时目录常是短名（RUNNER~1），node 报出来的是长名
    dirs.push(realpathSync.native(workspace));
  } catch {
    // 副本没了：按原样的路径换
  }
  const forms = new Set<string>();
  for (const dir of dirs) {
    forms.add(dir);
    forms.add(dir.replaceAll('\\', '/'));
    forms.add(pathToFileURL(dir).href);
  }
  let out = text;
  // 长的先换；Windows 上盘符大小写可能不同，不分大小写
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<副本>');
  }
  return out;
}

export interface CodingExecutor {
  readonly name: string;
  run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    options?: ExecutorRunOptions,
  ): Promise<ExecutorReport>;
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

  async run(
    task: CodingTask,
    workspace: string,
    _signal: AbortSignal,
    _options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
    this.lastGoal = task.goal;
    // D5a：被叫去写验收测试（scope 只有这个任务的测试目录）时不动副本，照实说写不了。
    // 只认这一种：批准范围是整个项目（'.'）的任务，写实现那一步照常写。
    const scope = JSON.parse(task.scope_json) as string[];
    if (scope.length === 1 && scope[0]!.startsWith(`${ACCEPTANCE_DIR}/`)) {
      return {
        claimedSuccess: false,
        summary: '替身执行器不写验收测试',
        changedPaths: [],
        testsModified: false,
        raw: '',
      };
    }
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
  // IXAEON_CODEX_EXE=none：明确不用真 Codex，走执行器替身（真机检查用）
  if (process.env.IXAEON_CODEX_EXE?.trim() === 'none') return null;
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

  async run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    _options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
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
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, {
      cwd,
      env: { ...minimalChildEnv(), ...extraEnv },
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
      signal?: AbortSignal,
      context?: { projectRoot: string; dataDir: string },
    ) => Promise<IndependentCheck> = defaultRunCheck,
  ) {
    this.store = new CodingTaskStore(db);
  }

  create(input: Parameters<CodingTaskStore['create']>[0]): CodingTask {
    return this.store.create(input);
  }

  /** 依赖档验证要的项目根目录（项目没绑目录就是空串，依赖档会如实不跑）。 */
  private projectRootOf(projectId: string): string {
    const row = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as
      { root_path: string | null } | undefined;
    return row?.root_path ?? '';
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
    // D7b：执行器名开工时读一次，之后写库都用这个值——
    // 跑到一半改了设置，这个任务记的还是开工时那个执行器。
    const executorNameAtStart = this.executor.name;
    // 范围守卫用字节级指纹（执行前后对比）；建分支冲突核对用 LF 归一的
    // **执行前**指纹（与落地侧 blobHash 同一套归一）。注意必须在 executor.run
    // 之前取——执行后重读文件拿到的是改动后的内容，与 HEAD 必然不一致，
    // 会把每个干净文件都误判成冲突（接手时真机撞出的回归）。
    const before = hashWorkspace(workspace);
    const beforeLf = hashWorkspace(workspace, { lfNormalize: true });
    this.store.setStatus(taskId, 'running', { executorName: executorNameAtStart });
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
      // D5a：有验收条件、没有验证命令的任务（聊天里提出来的）走「验收先行」；
      // 别的任务（带验证命令的、没有验收条件的）与原来一模一样，执行器只调一次。
      const conditions = (JSON.parse(task.acceptance_json ?? '[]') as string[]).filter(
        (a) => a.trim().length > 0,
      );
      const hasCommands = (JSON.parse(task.allowed_commands_json) as string[][]).some(
        (cmd) => cmd.length > 0,
      );
      const acceptanceFirst = conditions.length > 0 && !hasCommands;
      const signal = this.currentAbort.signal;
      const testDir = `${ACCEPTANCE_DIR}/${taskId.slice(0, 8)}`;
      const inTestDir = (rel: string): boolean => rel.startsWith(`${testDir}/`);
      /** 两次指纹之间变了哪些文件（执行器自己的报告通道文件不算）。 */
      const changedBetween = (from: Map<string, string>, to: Map<string, string>): string[] =>
        diffWorkspace(from, to).filter((p) => p !== EXECUTOR_CHANNEL_FILE);
      /** 取消了吗（任务的代次变了，或者取消信号响了）。 */
      const cancelledMid = (): boolean =>
        this.store.get(taskId).generation !== generation || signal.aborted;
      const settleCancelled = (): CodingTask =>
        this.store.setStatus(taskId, 'cancelled', { error: '取消后的晚到成功不覆盖取消' });
      /** 这一步就判任务失败：记下原因，不再往下走。 */
      const failNow = (error: string): CodingTask => {
        const failed = this.store.setStatus(taskId, 'failed', {
          executorName: executorNameAtStart,
          error,
        });
        this.recordWorkRun(failed, 'failed');
        return failed;
      };
      /** 跑一个验收测试文件：零依赖档，node 加相对路径，当前目录是副本的根。 */
      const runTest = async (rel: string): Promise<IndependentCheck> => {
        const check = await this.runCheck([process.execPath, rel], workspace, signal, {
          projectRoot: this.projectRootOf(task.project_id),
          dataDir: this.dataDir,
        });
        return { ...check, output: hideWorkspacePath(check.output, workspace) };
      };

      let report: ExecutorReport;
      let changed: string[];
      let testsModified: boolean;
      let acceptanceTests: ExecutorReport['acceptanceTests'];
      if (!acceptanceFirst) {
        report = await this.executor.run(dispatched, workspace, signal);
        if (this.store.get(taskId).generation !== generation) {
          return this.store.setStatus(taskId, 'cancelled', {
            error: '取消后的晚到成功不覆盖取消',
            executorReportJson: JSON.stringify(report),
          });
        }
        const claimed = report.changedPaths.map((p) => p.replaceAll('\\', '/'));
        changed = uniquePaths([...claimed, ...changedBetween(before, hashWorkspace(workspace))]);
        this.store.assertChangedPathsInScope(task, changed);
        testsModified = changed.some((p) => /test/i.test(p)) || report.testsModified;
      } else {
        // ---- 第 1 步：写测试。能改的只有测试目录，原来的批准范围只读 ----
        let said: string;
        try {
          const first = await this.executor.run(
            {
              ...dispatched,
              goal: writeTestsBrief(task.goal, conditions, testDir),
              scope_json: JSON.stringify([testDir]),
            },
            workspace,
            signal,
            { readScope: JSON.parse(task.scope_json) as string[] },
          );
          said = first.summary;
        } catch (err) {
          // 执行器报错也算「没写出测试」（取消除外）：原因记报错的话，接着写实现
          said = err instanceof Error ? err.message : String(err);
        }
        if (cancelledMid()) return settleCancelled();
        const afterTests = hashWorkspace(workspace);
        const stray = changedBetween(before, afterTests).filter((p) => !inTestDir(p));
        if (stray.length > 0) return failNow(`写验收测试时改了别的文件：${stray.join('、')}`);
        const files = [...afterTests.keys()]
          .filter((p) => inTestDir(p) && p.endsWith('.test.mjs'))
          .sort();
        // 不锁定的原因；到最后还是 null 就是锁定了
        let reason: string | null = null;
        let afterRed = afterTests;
        if (files.length === 0) {
          reason = `没写出验收测试：${clip(said) || '执行器没有说明'}`;
        } else {
          // ---- 第 2 步：实现前先跑一遍 ----
          const results: IndependentCheck[] = [];
          for (const rel of files) {
            results.push(await runTest(rel));
            if (cancelledMid()) return settleCancelled();
          }
          afterRed = hashWorkspace(workspace);
          // 测试跑的时候不许动副本里的文件（测试目录里的也算）：副本不干净了，不能接着写实现
          const touched = changedBetween(afterTests, afterRed);
          if (touched.length > 0) {
            return failNow(`验收测试改了项目里的文件：${touched.join('、')}`);
          }
          const refused = results.find((r) => !r.ran);
          if (refused) reason = refused.output.trim() || SANDBOX_SILENT;
          else if (results.every((r) => r.exitCode === 0)) {
            reason = '验收测试在实现之前就全部通过，测不出这次改动';
          }
        }
        acceptanceTests = { files, locked: reason === null, reason };
        // ---- 第 3 步：锁定。记下测试目录里每个文件的指纹。没锁定也记：写实现那一步动了
        // 测试目录一律算失败，不然批准范围以外就有了一条不受核对的路 ----
        const lockedDir = new Map([...afterRed].filter(([p]) => inTestDir(p)));
        // ---- 第 4 步：写实现。目标是派发时的那一份，接上验收条件和交代；测试目录只读 ----
        report = await this.executor.run(
          {
            ...dispatched,
            goal: [
              dispatched.goal,
              numbered('验收条件：', conditions),
              ...(acceptanceTests.locked
                ? [lockedBrief(files, testDir)]
                : lockedDir.size > 0
                  ? [unlockedBrief(testDir)]
                  : []),
            ].join('\n\n'),
          },
          workspace,
          signal,
          { readScope: [testDir] },
        );
        if (this.store.get(taskId).generation !== generation) {
          return this.store.setStatus(taskId, 'cancelled', {
            error: '取消后的晚到成功不覆盖取消',
            executorReportJson: JSON.stringify(report),
          });
        }
        const after = hashWorkspace(workspace);
        const claimed = report.changedPaths.map((p) => p.replaceAll('\\', '/'));
        changed = uniquePaths([...claimed, ...changedBetween(before, after)]);
        // 本任务的验收测试是第 1 步写进副本的，不按批准范围核
        this.store.assertChangedPathsInScope(
          task,
          changed.filter((p) => !inTestDir(p)),
        );
        const tampered = diffWorkspace(
          lockedDir,
          new Map([...after].filter(([p]) => inTestDir(p))),
        );
        if (tampered.length > 0) return failNow(`实现时改了验收测试：${tampered.join('、')}`);
        // 本任务新写的验收测试不算「测试代码被修改」，不然每个任务都显示这一句
        testsModified =
          changed.some((p) => /test/i.test(p) && !inTestDir(p)) || report.testsModified;
      }
      // D4：改之前每个文件的指纹（新文件 null），存进执行报告，落地时比对 HEAD。
      // 用执行前 LF 归一指纹（beforeLf）——不是执行后的文件内容。
      const baseHashes: Record<string, string | null> = {};
      for (const rel of changed) baseHashes[rel] = beforeLf.get(rel) ?? null;
      const merged: ExecutorReport = {
        ...report,
        changedPaths: changed,
        testsModified,
        baseHashes,
        ...(acceptanceTests ? { acceptanceTests } : {}),
      };
      if (!report.claimedSuccess) {
        const failed = this.store.setStatus(taskId, 'failed', {
          executorName: executorNameAtStart,
          executorReportJson: JSON.stringify(merged),
          testsModified,
          error: '执行器未声称成功，不把验证命令当成完成',
        });
        this.recordWorkRun(failed, 'failed');
        return failed;
      }
      this.store.setStatus(taskId, 'pending_verify', {
        executorName: executorNameAtStart,
        executorReportJson: JSON.stringify(merged),
        testsModified,
      });
      // A05：验证前后都要核范围——执行阶段后的工作区指纹作为验证前基线，
      // 验证程序自己引入的改动同样不得越出批准范围。
      const preVerify = hashWorkspace(workspace);
      let verified: CodingTask;
      if (acceptanceTests?.locked) {
        // ---- 第 5 步（锁定了）：每个测试文件再跑一遍 ----
        const outputs: string[] = [];
        let allPassed = true;
        let refused: string | null = null;
        for (const rel of acceptanceTests.files) {
          const check = await runTest(rel);
          if (cancelledMid()) return settleCancelled();
          if (!check.ran) refused ??= check.output.trim() || SANDBOX_SILENT;
          else {
            outputs.push(`node ${rel} → ${check.exitCode}\n${check.output}`);
            if (check.exitCode !== 0) allPassed = false;
          }
        }
        const verifyOutput = outputs.join('\n---\n').slice(0, 8000);
        const touched = changedBetween(preVerify, hashWorkspace(workspace));
        if (touched.length > 0) {
          const failed = this.store.setStatus(taskId, 'failed', {
            verifyStatus: 'failed',
            verifyOutput,
            error: `验收测试改了项目里的文件：${touched.join('、')}`,
          });
          this.recordWorkRun(failed, 'failed');
          return failed;
        }
        if (refused !== null) {
          // 沙箱不肯跑：不算通过也不算失败，等用户接受
          verified = this.store.setStatus(taskId, 'pending_accept', {
            verifyStatus: 'not_run',
            verifyExitCode: null,
            verifyOutput: refused.slice(0, 8000),
          });
        } else if (!allPassed) {
          const failed = this.store.setStatus(taskId, 'failed', {
            verifyStatus: 'failed',
            verifyExitCode: 1,
            verifyOutput,
            error: '独立验证失败，不把执行器自报当作通过',
          });
          this.recordWorkRun(failed, 'failed');
          return failed;
        } else {
          verified = this.store.setStatus(taskId, 'pending_accept', {
            verifyStatus: 'passed',
            verifyExitCode: 0,
            verifyOutput,
            error: null,
          });
        }
      } else if (acceptanceTests) {
        // 没锁定：不拿这些测试当验证，原因写进 verify_output
        verified = this.store.setStatus(taskId, 'pending_accept', {
          verifyStatus: 'not_run',
          verifyExitCode: null,
          verifyOutput: (acceptanceTests.reason ?? '').slice(0, 8000),
        });
      } else {
        verified = await this.verify(taskId, generation);
      }
      if (verified.status === 'pending_accept') {
        const postVerify = hashWorkspace(workspace);
        const verifyChanged = diffWorkspace(preVerify, postVerify).filter(
          (p) => p !== EXECUTOR_CHANNEL_FILE,
        );
        if (verifyChanged.length > 0) {
          try {
            this.store.assertChangedPathsInScope(this.store.get(taskId), verifyChanged);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const failed = this.store.setStatus(taskId, 'failed', {
              verifyStatus: 'failed',
              verifyExitCode: verified.verify_exit_code,
              verifyOutput: verified.verify_output,
              error: `验证程序改动越出批准范围：${msg}`,
            });
            this.recordWorkRun(failed, 'failed');
            return failed;
          }
        }
      }
      return verified;
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
      // A04：取消信号接入验证进程（用户取消 → 杀验证进程树，不留孤儿）
      // D2（补充第 3 条）：依赖档要把项目根目录与数据目录交给验证
      const projectRoot = this.projectRootOf(task.project_id);
      const result = await this.runCheck(cmd, task.workspace_path!, this.currentAbort?.signal, {
        projectRoot,
        dataDir: this.dataDir,
      });
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

  async accept(taskId: string): Promise<CodingTask> {
    const task = this.store.get(taskId);
    if (task.status !== 'pending_accept') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '只有待用户接受的任务可以接受');
    }
    if (task.verify_status === 'failed') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '独立验证失败，不能接受为完成');
    }
    const now = new Date().toISOString();
    this.recordWorkRun(task, task.verify_status === 'passed' ? 'success' : 'partial', now);
    const accepted = this.store.setStatus(taskId, 'completed', {
      acceptedAt: now,
    });
    // D4：接受之后落地——建分支 / 改动包；结果写回任务行，失败不吞掉接受本身。
    // 落地是异步的：期间任务可能被并发删除——landTask 已对这种情况返回 orphan 结果
    // 并记审计；这里再核一次，任务没了就不写库（写了会抛「不存在」），如实返回。
    try {
      const outcome = await landTask(this.db, accepted, this.dataDir);
      if (this.db.prepare('SELECT 1 FROM coding_tasks WHERE id = ?').get(taskId) == null) {
        return accepted;
      }
      return this.store.setLanding(taskId, {
        appliedRef: outcome.ref,
        applyError: outcome.reason,
        now: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      if (this.db.prepare('SELECT 1 FROM coding_tasks WHERE id = ?').get(taskId) == null) {
        return accepted;
      }
      return this.store.setLanding(taskId, {
        appliedRef: null,
        applyError: `落地出错：${msg}`,
        now: new Date().toISOString(),
      });
    }
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

/**
 * D2：依赖档验证的上下文（defaultCheck 第 6 个参数，编排层 runCheck 第 4 个参数）。
 * 生产路径不给 checkAuth / spawnCommand（用默认实现），只给 projectRoot 与 dataDir；
 * 测试用替身注入这两处接缝。
 */
export interface DependencyCheckContext {
  projectRoot: string;
  dataDir: string;
  checkAuth?: (dataDir: string) => Promise<SandboxAuthResult>;
  spawnCommand?: (
    cmd: string,
    args: string[],
    opts: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      signal: AbortSignal;
      timeoutMs: number;
    },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

/** 项目里除 node_modules 内部之外的每个 node_modules（相对项目根的目录）。 */
function collectNodeModulesDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const abs = join(dir, ent.name);
      if (ent.name === 'node_modules') {
        out.push(relative(root, abs).replaceAll('\\', '/'));
        continue; // 不往里钻（里面的 node_modules 是依赖自己带的，不链）
      }
      // 复审整改 5：与 copyProjectWorkspace 同规则，跳过 .git/dist/build 等目录
      if (FORBIDDEN_DIRS.has(ent.name)) continue;
      walk(abs);
    }
  };
  walk(root);
  return out;
}

/** 副本里有没有链接（目录链接、符号链接都算，藏在子目录里也算）。 */
function findFirstLink(dir: string): string | null {
  let hit: string | null = null;
  const walk = (d: string) => {
    if (hit) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hit) return;
      const abs = join(d, ent.name);
      if (ent.isSymbolicLink()) {
        hit = relative(dir, abs).replaceAll('\\', '/') || '.';
        return;
      }
      if (ent.isDirectory()) walk(abs);
    }
  };
  walk(dir);
  return hit;
}

/** 复审整改 5：把 copyProjectWorkspace 的跳过目录集合导出来复用（.git、dist 等不链）。 */
/** 依赖档准备/还原：派生前建链接，跑完（无论结局）拆干净。 */
function prepareDependencyCopy(
  copy: string,
  projectRoot: string,
): { cleanup: () => void; realDeps: string[]; tmp: string } | { error: string } {
  // 复审整改 5：项目里找 node_modules 时跳过与 copyProjectWorkspace 一样的目录
  const rels = collectNodeModulesDirs(projectRoot);
  // 预检：副本里要放链接的任一位置已经有东西 → 整单不跑，绝不覆盖执行器的东西
  for (const rel of rels) {
    if (existsSync(join(copy, rel))) {
      return { error: `副本里已有 node_modules（${rel}）：依赖档不跑，不覆盖已有的内容。` };
    }
  }

  const madeLinks: string[] = [];
  const madeDirs: string[] = [];
  const realDeps: string[] = [];
  const marker = join(copy, 'pnpm-workspace.yaml');
  const markerMade = !existsSync(marker);
  // 复审整改 5：.ixaeon-tmp 已被占就换名字，绝不删副本里本来就有的东西
  let tmpPath = join(copy, '.ixaeon-tmp');
  let n = 1;
  while (existsSync(tmpPath)) {
    n += 1;
    tmpPath = join(copy, `.ixaeon-tmp-${n}`);
  }

  const cleanup = () => {
    for (const rel of madeLinks) {
      // 只删链接本身，不跟进目标（Node 的 rm 对 junction/symlink 不递归进目标）
      rmSync(join(copy, rel), { recursive: true, force: true });
    }
    for (const d of madeDirs.slice().reverse()) {
      try {
        rmdirSync(d); // 只删空目录；非空说明有别的东西，保留并暴露
      } catch {
        /* 非空：保留 */
      }
    }
    if (markerMade) rmSync(marker, { force: true });
    rmSync(tmpPath, { recursive: true, force: true });
  };

  // 复审整改 5：准备到一半出错也要先拆干净再冒出去
  try {
    for (const rel of rels) {
      const link = join(copy, rel);
      // 逐层记录所有要新建的上级目录（mkdir recursive 可能一次建好几层）
      let d = dirname(link);
      const missing: string[] = [];
      while (!existsSync(d) && !madeDirs.includes(d)) {
        missing.push(d);
        const parent = dirname(d);
        if (parent === d) break;
        d = parent;
      }
      for (const md of missing.reverse()) {
        mkdirSync(md);
        madeDirs.push(md);
      }
      symlinkSync(join(projectRoot, rel), link, 'junction');
      madeLinks.push(rel);
      realDeps.push(join(projectRoot, rel));
    }
  } catch (err) {
    try {
      cleanup();
    } catch {
      /* 清理尽力而为 */
    }
    throw err;
  }

  if (markerMade) writeFileSync(marker, '');
  mkdirSync(tmpPath, { recursive: true });
  return { cleanup, realDeps, tmp: tmpPath };
}

/**
 * V3：零依赖档跑的程序不许联网。Node 的权限模型（这个版本）管不到网络，所以在验证程序自己的
 * 代码之前先加载这一段，把已知的联网入口都换成抛错的。这是进程内的拦截，不是操作系统级的隔离
 * （那是依赖档的沙箱）：挡的是「顺手把项目副本发出去」，不保证挡得住专门研究怎么绕的代码。
 */
const NETWORK_GUARD = `
import { syncBuiltinESMExports } from 'node:module';
const builtin = (name) => process.getBuiltinModule(name);
const deny = (what) => () => {
  throw Object.assign(new Error('验证程序不许联网（' + what + '）'), { code: 'ERR_IXAEON_NO_NETWORK' });
};
const denyAll = (obj, label, keep = []) => {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key !== 'constructor' && !keep.includes(key) && typeof obj[key] === 'function') obj[key] = deny(label + key);
  }
};
const net = builtin('node:net');
net.Socket.prototype.connect = deny('net.connect');
net.Server.prototype.listen = deny('net.listen');
const dgram = builtin('node:dgram');
for (const key of ['bind', 'connect', 'send']) dgram.Socket.prototype[key] = deny('dgram.' + key);
const dns = builtin('node:dns');
denyAll(dns, 'dns.', ['Resolver']);
denyAll(dns.promises, 'dns.promises.', ['Resolver']);
denyAll(dns.Resolver.prototype, 'dns.Resolver.');
denyAll(dns.promises.Resolver.prototype, 'dns.promises.Resolver.');
builtin('node:inspector').open = deny('inspector.open');
process.binding = deny('process.binding');
process._linkedBinding = deny('process._linkedBinding');
globalThis.fetch = async () => deny('fetch')();
globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };
globalThis.EventSource = undefined;
syncBuiltinESMExports();
//# sourceURL=ixaeon-network-guard.mjs
`;
const NETWORK_GUARD_URL = `data:text/javascript,${encodeURIComponent(NETWORK_GUARD)}`;

/**
 * V3：零依赖档只认「node 脚本 [参数…]」和「node -e 代码」。脚本名之前出现别的启动参数、
 * 或者 -e 的代码后面还跟着参数，返回那个参数（调用方据此不跑）；合规返回 null。
 * 不逐个去认哪些参数危险：预加载、环境文件、调试端口……没见过的一律不跑。
 */
function unexpectedNodeOption(args: string[]): string | null {
  const first = args[0];
  if (first === undefined || !first.startsWith('-')) return null; // 脚本名：后面都是给脚本的参数
  if (!['-e', '--eval', '-p', '--print'].includes(first)) return first;
  return args.slice(2).find((a) => a.startsWith('-')) ?? null;
}

/** 编排层默认 runCheck：4 参数（argv, cwd, signal, context）→ defaultCheck 第 6 参数。 */
async function defaultRunCheck(
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
  context?: { projectRoot: string; dataDir: string },
): Promise<IndependentCheck> {
  return defaultCheck(
    argv,
    cwd,
    signal,
    undefined,
    undefined,
    context as DependencyCheckContext | undefined,
  );
}

export async function defaultCheck(
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
  // V1 可注入判定（默认按「本进程是否 Electron 且派生自己」判定）。契约：
  // 计算出的附加环境**只能是** ELECTRON_RUN_AS_NODE 一项（布尔决定），
  // 不给任意环境变量开口子——白名单以外的变量仍带不进子进程。
  runAsNode: (exe: string, execPath: string, versions: NodeJS.ProcessVersions) => boolean = (
    exe,
    execPath,
    versions,
  ) => electronRunAsNodeEnv(exe, execPath, versions).ELECTRON_RUN_AS_NODE === '1',
  // 验收测试用「默认 runAsNode + 注入 versions.electron」走生产默认路径。
  versions: NodeJS.ProcessVersions = process.versions,
  // D2 依赖档上下文（第 6 个参数，V1 锁定的第 4、5 个参数不动）。
  context?: DependencyCheckContext,
): Promise<IndependentCheck> {
  if (isPlaceholderVerifyCommand(argv)) {
    return {
      argv,
      exitCode: null,
      output: '拒绝无条件成功命令 process.exit(0)，不算验证',
      ran: false,
    };
  }
  // D2 依赖档：ixaeon:vitest 伪命令 → 专用 CODEX_HOME + 提权沙箱
  if (argv[0] === 'ixaeon:vitest') {
    return checkDependencyTier(argv.slice(1), cwd, signal, runAsNode, versions, context);
  }
  try {
    const exe = argv[0]!;
    // A04（审核 2026-09-13）：验证命令必须经过统一沙箱——
    // 1. 只支持 Node（进程内 node:test 已实测）；其他可执行程序（npm、
    //    python、任意 exe）尚未接入统一沙箱，明确不裸跑（ran=false 如实说明），
    //    不靠教用户换命令绕开保护。
    const isNode = exe === process.execPath || /node(\.exe)?$/i.test(exe);
    if (!isNode) {
      return {
        argv,
        exitCode: null,
        output:
          `验证命令的可执行程序不在支持范围（${exe}）。` +
          '统一沙箱目前只支持 node（进程内测试）；其他程序不裸跑，不算验证。',
        ran: false,
      };
    }
    // D2 条件 8：零依赖档靠 Node 权限模型，它判写权限看链接所在的路径，
    // 副本里有链接（藏在子目录里也算）就可能顺着链接写到副本外——不跑。
    const linkHit = findFirstLink(cwd);
    if (linkHit) {
      return {
        argv,
        exitCode: null,
        output: `副本里有目录链接（${linkHit}）：零依赖档不跑，防止权限模型顺着链接写到副本外。`,
        ran: false,
      };
    }
    // 2. 权限参数统一由产品注入：剥离命令自带的 --permission / --allow-fs-*，
    //    强制工作区读写边界（自带的更宽参数不生效——验证器不能自己扩权）。
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === '--permission') continue;
      if (a.startsWith('--allow-fs-read=') || a.startsWith('--allow-fs-write=')) continue;
      if (a === '--allow-fs-read' || a === '--allow-fs-write') {
        i += 1; // 跳过其值参
        continue;
      }
      rest.push(a);
    }
    // V3：脚本名（或 -e）之前带了别的启动参数就不跑——它们会抢在断网之前执行或开监听。
    const extra = unexpectedNodeOption(rest);
    if (extra !== null) {
      return {
        argv,
        exitCode: null,
        output:
          `验证命令带了启动参数 ${extra}：零依赖档只跑「node 脚本 [参数…]」和「node -e 代码」，` +
          '别的启动参数（预加载、环境文件、调试端口等）会抢在断网之前执行，不跑。',
        ran: false,
      };
    }
    const finalArgv = [
      '--permission',
      `--allow-fs-read=${cwd}`,
      `--allow-fs-write=${cwd}`,
      '--import',
      NETWORK_GUARD_URL,
      ...rest,
    ];
    // 3. 取消信号接入正在运行的验证程序（用户取消 → 杀进程树）。
    const abort = new AbortController();
    const onOuterAbort = () => abort.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      // V1：IXAEON 开发版与打包版都跑在 Electron 里，process.execPath 是
      // Electron 可执行文件——当被派生的程序就是它自己时，注入
      // ELECTRON_RUN_AS_NODE=1 才会当 node 跑，否则再启动一个应用实例
      // （验证命令没跑，还多出一个窗口）。普通 node 环境不加。
      // 附加环境只此一项（布尔判定），白名单外变量仍带不进来。
      const extraEnv: Record<string, string> = runAsNode(exe, process.execPath, versions)
        ? { ELECTRON_RUN_AS_NODE: '1' }
        : {};
      const raw = await spawnArgv(exe, finalArgv, cwd, 60_000, abort.signal, {}, extraEnv);
      return {
        argv,
        exitCode: raw.exitCode,
        output: `${raw.stdout}\n${raw.stderr}`.trim(),
        ran: true,
      };
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
    }
  } catch (err) {
    return {
      argv,
      exitCode: 1,
      output: err instanceof Error ? err.message : String(err),
      ran: true,
    };
  }
}

/**
 * D2 依赖档（契约 3/4/5/7 + 补充 9/10/12）：
 * ixaeon:vitest run … → 专用 CODEX_HOME + codex 提权沙箱跑副本里的 vitest。
 * 链接只在派生这段时间存在，跑完拆干净。派生前先做被动授权检查（不弹窗）。
 */
async function checkDependencyTier(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  runAsNode: (exe: string, execPath: string, versions: NodeJS.ProcessVersions) => boolean,
  versions: NodeJS.ProcessVersions,
  context: DependencyCheckContext | undefined,
): Promise<IndependentCheck> {
  if (!context) {
    return {
      argv: ['ixaeon:vitest', ...args],
      exitCode: null,
      output: '依赖档验证缺少项目根目录与数据目录上下文，不算验证。',
      ran: false,
    };
  }
  if (args[0] !== 'run') {
    return {
      argv: ['ixaeon:vitest', ...args],
      exitCode: null,
      output: `ixaeon:vitest 只支持 run 子命令（收到 ${args[0] ?? '无'}），不派生。`,
      ran: false,
    };
  }
  const rest = args.slice(1);
  const { projectRoot, dataDir } = context;
  // 项目根目录没装 vitest：vitest_missing，不当成「跑了没通过」
  if (!existsSync(join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'))) {
    return {
      argv: ['ixaeon:vitest', ...args],
      exitCode: null,
      output:
        '项目根目录没有安装 vitest（node_modules/vitest/vitest.mjs 不存在）：vitest_missing。',
      ran: false,
    };
  }
  // 派生前先查授权（被动，绝不弹窗）
  const checkAuth = context.checkAuth ?? ((dir: string) => checkSandboxAuth(dir));
  const auth = await checkAuth(dataDir);
  if (!auth.ok) {
    return {
      argv: ['ixaeon:vitest', ...args],
      exitCode: null,
      output: `依赖档沙箱检查未过：${auth.reason}，不派生，不算验证。`,
      ran: false,
    };
  }

  const prepared = prepareDependencyCopy(cwd, projectRoot);
  if ('error' in prepared) {
    return {
      argv: ['ixaeon:vitest', ...args],
      exitCode: null,
      output: prepared.error,
      ran: false,
    };
  }
  try {
    const home = sandboxHomeDir(dataDir);
    ensureSandboxProfileConfig(home, cwd, prepared.realDeps);
    const node = process.execPath;
    const env: NodeJS.ProcessEnv = {
      ...minimalChildEnv(),
      CODEX_HOME: home,
      TMP: prepared.tmp,
      TEMP: prepared.tmp,
      ...(runAsNode(node, process.execPath, versions) ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    const spawnCommand =
      context.spawnCommand ??
      ((
        cmd: string,
        sargs: string[],
        opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number },
      ) => spawnSandboxProcess(cmd, sargs, opts));
    // 复审整改 1：授权检查通过后不再判 Codex 在不在（检查函数已经保证；替身派生
    // 不许被本机没有 Codex 卡住——CI 上没有 Codex，13 条替身测试因此挂过）。
    // 真派生时拿默认安装位置的路径；起不来就按「派生出错」记。
    const codexExe =
      locateCodexExecutable() ??
      join(process.env.LOCALAPPDATA || 'C:/nonexistent', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    const codexArgs = [
      'sandbox',
      'windows',
      '--permissions-profile',
      SANDBOX_PROFILE,
      '-c',
      'windows.sandbox="elevated"',
      '-C',
      cwd,
      '--',
      node,
      join(cwd, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config-loader',
      'runner',
      // 复审整改 4：vitest 4.1.11 没有可用的缓存目录参数；--no-cache 下
      // node_modules 一个文件都不写（默认缓存经链接写真实依赖会被拒）
      '--no-cache',
      ...rest,
    ];
    const effectiveSignal = signal ?? new AbortController().signal;
    let raw;
    try {
      raw = await spawnCommand(codexExe, codexArgs, {
        cwd,
        env,
        signal: effectiveSignal,
        timeoutMs: 60_000,
      });
    } catch (err) {
      // 派生出错（进程起不来等）：如实反映，副本照常在 finally 拆干净
      return {
        argv: ['ixaeon:vitest', ...args],
        exitCode: 1,
        output: err instanceof Error ? err.message : String(err),
        ran: true,
      };
    }
    return {
      argv: ['ixaeon:vitest', ...args],
      exitCode: raw.exitCode,
      output: `${raw.stdout}\n${raw.stderr}`.trim(),
      ran: true,
    };
  } finally {
    prepared.cleanup();
  }
}

/** 生产派生器：promise 化 + 取消杀进程树 + 超时（形状与验收的 SpawnOpts 一致）。 */
function spawnSandboxProcess(
  exe: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ exitCode: null, stdout, stderr });
    };
    const stop = () => {
      if (child.pid) killProcessTree(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      stop();
      finish(
        new IxaError(
          ErrorCodes.JOB_CANCELLED,
          `执行超时（${opts.timeoutMs} ms），已停止本次子进程`,
        ),
      );
    }, opts.timeoutMs);
    const onAbort = () => {
      stop();
      resolve({ exitCode: null, stdout, stderr });
    };
    opts.signal.addEventListener('abort', onAbort);
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8');
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.replaceAll('\\', '/')))];
}

/**
 * V1：被派生的可执行文件就是「本进程自己」且本进程是 Electron
 * （process.versions.electron 有值）时，子进程要 ELECTRON_RUN_AS_NODE=1
 * 才按 node 跑；普通 node 环境不注入。纯函数便于验收测试两分支各测。
 */
export function electronRunAsNodeEnv(
  exe: string,
  execPath: string,
  versions: NodeJS.ProcessVersions,
): Record<string, string> {
  if (exe === execPath && versions.electron !== undefined) {
    return { ELECTRON_RUN_AS_NODE: '1' };
  }
  return {};
}

/**
 * S2-02（审核 2026-09-15）：受控验证命令执行器——供 Skill 对照评测等主进程入口使用。
 * 复用统一沙箱（仅 node、剥离自带 --permission/--allow-fs-*、强制 cwd 读写边界），
 * 返回真实退出码与输出。调用方自报的退出码/输出一律不采信。
 */
export async function runControlledVerifyCommand(
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<IndependentCheck> {
  return defaultCheck(argv, cwd, signal);
}

function hashWorkspace(root: string, opts: { lfNormalize?: boolean } = {}): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        // A05：符号链接按「链接存在性 + 指向」记指纹（增删改都能被发现）
        const rel = relative(root, abs).replaceAll('\\', '/');
        map.set(rel, `link:${readlinkSync(abs)}`);
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else {
        const rel = relative(root, abs).replaceAll('\\', '/');
        const buf = readFileSync(abs);
        // D4 接手修复：baseHashes 用途的指纹按 LF 归一（与落地侧 blobHash 同一套），
        // 防 autocrlf/eol=crlf 仓库把干净文件误判冲突；范围守卫用途仍字节级。
        const hashed = opts.lfNormalize ? toLf(buf) : buf;
        map.set(rel, createHash('sha256').update(hashed).digest('hex'));
      }
    }
  };
  walk(root);
  return map;
}

/**
 * A05（审核 2026-09-13）：三方对比——新增、修改、**删除**都要算改动。
 * 旧实现只遍历 after 表，删除的文件（在 before 不在 after）根本不会出现，
 * 执行器删掉批准范围外的文件也能蒙混过关。这里补齐。
 */
function diffWorkspace(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.push(path); // 新增或内容变化
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(path); // 被删除
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
