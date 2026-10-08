/**
 * P6 验收（规格 docs/委派/P6-授权撤销后不建副本不派任务.md，条件 1–5、7、8；条件 6 是别的锁定测试照过）。
 * 执行方先推了一版（7 条，写得对），整合方 2026-10-08 锁定前在它上面补了几处
 * （规格末尾「整合方审测试时的改正与补充」）。
 *
 * 真的运行时方法（AppRuntime 的原型）、真的编排与自动派发；项目文件夹是合成的 git 仓库，
 * 用真的 bindProjectFolder 绑上（会发授权）。执行器是替身：目标以「[卡住]」开头就停在执行中等放行。
 *
 * 钉住的接缝：
 * - P4 那道检查（propose_coding_task / 待办点「要做」/ 任务页批准 三个入口共用）多查一条：
 *   项目绑着文件夹、但 `permissions.activePermissionForPath(root_path)` 是 null → 报「授权已撤销那句」；
 * - `finishCodingTask(id, 'dispatch')` 同样拦，任务留在排队，执行器不调；`'cancel'` 不拦；
 * - 自动派发经宿主的可选回调 `CodingDispatchHost.folderGap?: (taskId) => string | null`：
 *   返回一句话就跳过这个任务（留在排队、接着派后面的），在发起它的对话里回报
 *   「<目标第一行>」停在排队里：<那句话>，meta 是 { kind: 'task_report', taskId, status: 'folder_missing' }，
 *   同一个任务只写一次；没给回调的宿主行为不变；
 * - 已经在执行的任务不管。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeProvider,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  migrate,
  openDatabase,
  type AgentSession,
  type CodingExecutor,
  type CoreDatabase,
  type IndependentCheck,
} from '@ixaeon/core';
import type { Project } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { CodingDispatch, type CodingDispatchHost } from '../../src/main/codingDispatch.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

const REVOKED = '这个项目文件夹的读取授权已经撤销：在项目页解除绑定、重新绑定之后，再派编码任务。';
const UNBOUND = '这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。';
/** 执行器替身认的开头：停在执行中等放行。 */
const HOLD = '[卡住]';

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};
let releases: Array<() => void> = [];

beforeEach(() => {
  // 隔开本机的 git 全局配置；不让本机装没装 Codex 影响自动派发
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', 'nul'],
    ['GIT_CONFIG_SYSTEM', 'nul'],
    ['IXAEON_CODEX_EXE', 'none'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p6-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  releases = [];
});

afterEach(async () => {
  for (const release of releases) release();
  for (let i = 0; i < 100; i += 1) {
    const running = (
      db
        .prepare(
          "SELECT count(*) AS n FROM coding_tasks WHERE status IN ('running','pending_verify')",
        )
        .get() as { n: number }
    ).n;
    if (running === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 50));
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (db.open) db.close();
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

/** 合成的 git 项目文件夹。 */
function gitFolder(label: string): string {
  const f = join(dir, 'repos', label);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, 'note.txt'), '合成文件\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f });
  git('init', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init');
  return f;
}

interface Harness {
  runtime: AppRuntime;
  projects: ProjectService;
  permissions: PermissionService;
  conversations: ConversationStore;
  todos: TodoStore;
  sources: SourceStore;
  coding: CodingOrchestrator;
  /** 执行器被调过的任务号（按次序）。 */
  executed: string[];
  /** 放行所有「卡住」的执行器。 */
  releaseExecutor(): void;
  dataDir: string;
}

function setup(): Harness {
  const executed: string[] = [];
  let openExecutor!: () => void;
  const executorGate = new Promise<void>((r) => {
    openExecutor = r;
  });
  releases.push(openExecutor);
  const executor: CodingExecutor = {
    name: 'scripted',
    async run(task, workspace) {
      executed.push(task.id);
      // 派发时目标后面还接了范围、背景几段，所以只看开头
      if (task.goal.startsWith(HOLD)) await executorGate;
      writeFileSync(join(workspace, 'note.txt'), `任务 ${task.id.slice(0, 8)} 改过\n`);
      return {
        claimedSuccess: true,
        summary: '改了 note.txt',
        changedPaths: ['note.txt'],
        testsModified: false,
        raw: '',
      };
    },
  };
  const runCheck = async (argv: string[]): Promise<IndependentCheck> => ({
    argv,
    exitCode: 0,
    output: 'ok',
    ran: true,
  });
  const dataDir = join(dir, 'data');
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const sources = new SourceStore(db);
  const coding = new CodingOrchestrator(db, executor, dataDir, runCheck);
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    projects,
    permissions,
    sources,
    conversations,
    todos,
    coding,
    search: new SearchService(db),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('p6'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger,
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return {
    runtime,
    projects,
    permissions,
    conversations,
    todos,
    sources,
    coding,
    executed,
    releaseExecutor: openExecutor,
    dataDir,
  };
}

/** 新建项目并绑定一个合成的 git 文件夹（走真的 bindProjectFolder，会发授权）。 */
async function bound(
  h: Harness,
  name = '合成项目',
): Promise<{ project: Project; root: string; grantId: string }> {
  const created = h.projects.create({ name, rootPath: null, description: null });
  const root = gitFolder(name);
  const project = await h.runtime.bindProjectFolder(created.id, root);
  return { project, root, grantId: h.permissions.activePermissionForPath(root)!.id };
}

/**
 * 用户实际走得到的那条路：来源页对一份从这个文件夹导入的资料点「撤销读取」
 * （IPC revokeSourceReading），撤销的是整条文件夹授权。
 */
async function revokeViaSourcePage(h: Harness, grantId: string, projectId: string): Promise<void> {
  const source = h.sources.insertParsed(
    {
      kind: 'project_snapshot',
      provider: 'project',
      accountNamespace: 'local',
      externalId: randomUUID(),
      title: '合成资料',
      contentHash: randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      capturedAt: '2026-10-01T08:00:00.000Z',
      importMethod: 'project_snapshot',
      segments: [],
      metadata: {},
    },
    { permissionId: grantId, projectId, rawPath: `sha256/aa/${'a'.repeat(64)}` },
  );
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(h.runtime);
  const entry = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === 'ixaeon:revokeSourceReading');
  if (!entry) throw new Error('没有注册 IPC：revokeSourceReading');
  await entry[1]({} as never, source.id);
  expect(h.permissions.get(grantId)!.status).toBe('revoked');
}

const taskRow = (id: string) =>
  db.prepare('SELECT status, workspace_path FROM coding_tasks WHERE id = ?').get(id) as {
    status: string;
    workspace_path: string | null;
  };
const count = (table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const audits = (kind: string): number =>
  (db.prepare('SELECT count(*) AS n FROM audit_events WHERE kind = ?').get(kind) as { n: number })
    .n;
/** 数据目录里一共建了几个任务副本。 */
const copies = (h: Harness): string[] =>
  existsSync(join(h.dataDir, 'workspaces')) ? readdirSync(join(h.dataDir, 'workspaces')) : [];

const draft = (h: Harness, projectId: string, goal: string) =>
  h.coding.create({ projectId, goal, scope: ['note.txt'], allowedCommands: [] });

/** 对话里的任务回报。 */
const reports = (conversationId: string) =>
  (
    db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ content: string; meta_json: string }>
  )
    .map((m) => ({ content: m.content, meta: JSON.parse(m.meta_json) as Record<string, unknown> }))
    .filter((m) => m.meta['kind'] === 'task_report');

/** 聊天那条路：真的走一轮提问，会话替身在这一轮里建出草案（带 origin_run_id，对话里挂着待办卡）。 */
async function chatDraft(
  h: Harness,
  projectId: string,
  goal: string,
): Promise<{ taskId: string; todoId: string; conversationId: string }> {
  const conv = h.conversations.create({ projectId });
  let taskId = '';
  (h.runtime as unknown as { askSessions: Map<string, AgentSession> }).askSessions.set(conv.id, {
    run: async () => {
      taskId = draft(h, projectId, goal).id;
      return {
        answer: '可以，我起草了一个编码任务，等你拍板。',
        citations: [],
        notice: '',
        usedChars: 1,
        modelName: 'hermes',
        engine: 'hermes',
        runId: 'fake',
        steps: [],
        memoryUsed: [],
      };
    },
    cancel: () => undefined,
    invalidateContext: () => undefined,
    getEngineSessionId: () => 's-p6',
  } as unknown as AgentSession);
  const answered = await h.runtime.ask({
    conversationId: conv.id,
    projectId,
    question: '把这个做了',
  });
  const todo = h.todos.list({ status: ['proposed'] }).find((t) => t.linked_id === taskId);
  return { taskId, todoId: todo!.id, conversationId: answered.conversationId };
}

/** 让一次提问停在半路，好在这一轮里调 propose_coding_task。返回放行它的函数。 */
async function withInFlightAsk(h: Harness, projectId: string): Promise<() => Promise<void>> {
  const conv = h.conversations.create({ projectId });
  let finish!: () => void;
  const hold = new Promise<void>((r) => {
    finish = r;
  });
  (h.runtime as unknown as { askSessions: Map<string, AgentSession> }).askSessions.set(conv.id, {
    run: async (input: { runId?: string }) => {
      await hold;
      return {
        answer: '好。',
        citations: [],
        notice: '',
        usedChars: 1,
        modelName: 'hermes',
        engine: 'hermes',
        runId: input.runId ?? 'fake',
        steps: [],
        memoryUsed: [],
      };
    },
    cancel: () => undefined,
    invalidateContext: () => undefined,
    getEngineSessionId: () => 's-p6',
  } as unknown as AgentSession);
  const asking = h.runtime
    .ask({ conversationId: conv.id, projectId, question: '加个文件' })
    .catch(() => undefined);
  const active = (h.runtime as unknown as { activeAskRuns: Map<string, string> }).activeAskRuns;
  await vi.waitFor(() => expect(active.size).toBe(1));
  return async () => {
    finish();
    await asking;
  };
}

const propose = (h: Harness) =>
  h.runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] });
const WAIT = { timeout: 60_000 };

describe('条件 1：绑着文件夹、授权撤销了', () => {
  it('propose_coding_task：授权还在时照常建草案；从来源页撤销之后不建草案、不记审计，错误就是那一句', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    // 先证明这一套搭得对：授权还在，同一个调用建得出草案
    const endFirst = await withInFlightAsk(h, project.id);
    await expect(propose(h)).resolves.toMatchObject({ status: 'draft' });
    await endFirst();
    expect(count('coding_tasks')).toBe(1);
    expect(audits('hermes.propose_coding_task')).toBe(1);

    await revokeViaSourcePage(h, grantId, project.id);
    const end = await withInFlightAsk(h, project.id);
    const todosBefore = count('todos');
    await expect(propose(h)).rejects.toThrow(REVOKED);
    expect(count('coding_tasks')).toBe(1);
    expect(audits('hermes.propose_coding_task')).toBe(1);
    expect(count('todos')).toBe(todosBefore);
    await end();
  });

  it('已有的草案点「要做」、任务页批准：都报那一句；没批准、没建副本，待办还是「等你拍板」', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const d = draft(h, project.id, '撤销之前的草案');
    const todo = h.todos.propose({
      title: '撤销之前的草案',
      linked: { kind: 'coding_task', id: d.id },
    })!;
    await revokeViaSourcePage(h, grantId, project.id);

    await expect(h.runtime.acceptTodo(todo.id)).rejects.toThrow(REVOKED);
    await expect(h.runtime.approveCodingTask(d.id)).rejects.toThrow(REVOKED);
    expect(taskRow(d.id).status).toBe('draft');
    expect(taskRow(d.id).workspace_path).toBeNull();
    expect(count('coding_approvals')).toBe(0);
    expect(copies(h)).toEqual([]);
    expect(h.todos.get(todo.id).status).toBe('proposed');
    expect(h.executed).toEqual([]);
  });
});

describe('条件 2：早先批准好、在排队，之后授权撤销', () => {
  it('任务页点派发：报那一句，任务还在排队，执行器没被调', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const d = draft(h, project.id, '批准了排着');
    await h.runtime.approveCodingTask(d.id);
    expect(taskRow(d.id).status).toBe('queued');
    h.permissions.revoke(grantId);

    await expect(h.runtime.finishCodingTask(d.id, 'dispatch')).rejects.toThrow(REVOKED);
    expect(taskRow(d.id).status).toBe('queued');
    expect(h.executed).toEqual([]);
  });

  it('取消不拦：这样的任务照样取消得掉', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const d = draft(h, project.id, '批准了排着');
    await h.runtime.approveCodingTask(d.id);
    h.permissions.revoke(grantId);

    const cancelled = await h.runtime.finishCodingTask(d.id, 'cancel');
    expect(cancelled.status).toBe('cancelled');
    expect(taskRow(d.id).status).toBe('cancelled');
    expect(h.executed).toEqual([]);
  });
});

describe('条件 3、4：自动派发', () => {
  it('轮到它：跳过、留在排队、对话里一条 folder_missing 回报；后面别的项目的照常做完；再触发还是一条；授权回来了就照常派', async () => {
    const h = setup();
    const x = await bound(h, '授权撤销的');
    const y = await bound(h, '授权还在的');
    // X 先批准、排在最前面；Y 的两个由「要做」批准并触发自动派发
    const xTask = await chatDraft(h, x.project.id, '第一条：停在排队里\n第二行是细节，回报里不带');
    await h.runtime.approveCodingTask(xTask.taskId);
    expect(taskRow(xTask.taskId).status).toBe('queued');
    const y1 = await chatDraft(h, y.project.id, '第二条：照常做完');
    const y2 = await chatDraft(h, y.project.id, '第三条：照常做完');
    h.permissions.revoke(x.grantId);

    await h.runtime.acceptTodo(y1.todoId);
    await vi.waitFor(() => expect(taskRow(y1.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.executed).toEqual([y1.taskId]);
    expect(taskRow(xTask.taskId).status).toBe('queued');
    expect(reports(xTask.conversationId)).toEqual([
      {
        content: `「第一条：停在排队里」停在排队里：${REVOKED}`,
        meta: { kind: 'task_report', taskId: xTask.taskId, status: 'folder_missing' },
      },
    ]);
    // 别的项目的回报里没有这一句
    expect(reports(y1.conversationId).map((r) => r.meta['status'])).toEqual(['pending_accept']);

    // 再触发一次：被拦的这条还是一条回报，后面的继续派
    await h.runtime.acceptTodo(y2.todoId);
    await vi.waitFor(() => expect(taskRow(y2.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.executed).toEqual([y1.taskId, y2.taskId]);
    expect(taskRow(xTask.taskId).status).toBe('queued');
    expect(reports(xTask.conversationId)).toHaveLength(1);

    // 授权回来了（比如又从这个文件夹导入了一次）：下一次轮到它就照常派、照常回报
    h.permissions.grantFolder(x.root);
    const y3 = await chatDraft(h, y.project.id, '第四条：再触发一次');
    await h.runtime.acceptTodo(y3.todoId);
    await vi.waitFor(() => expect(taskRow(xTask.taskId).status).toBe('pending_accept'), WAIT);
    await vi.waitFor(() => expect(taskRow(y3.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.executed).toEqual([y1.taskId, y2.taskId, xTask.taskId, y3.taskId]);
    expect(reports(xTask.conversationId).map((r) => r.meta['status'])).toEqual([
      'folder_missing',
      'pending_accept',
    ]);
  });

  it('排着队的任务、项目后来没了文件夹：走同一条路，回报里是 P4 那一句；任务页点派发也报 P4 那一句', async () => {
    const h = setup();
    const x = await bound(h, '后来没了文件夹的');
    const y = await bound(h, '照常的');
    const viaChat = await chatDraft(h, x.project.id, '聊天里提的');
    await h.runtime.approveCodingTask(viaChat.taskId);
    // 任务页建的任务没有发起的对话：跳过它，不往哪儿写
    const viaPage = draft(h, x.project.id, '任务页建的').id;
    await h.runtime.approveCodingTask(viaPage);
    // 老数据里才有的状态（P5 的解除绑定会先取消排队的任务）：直接把路径清掉造出来
    db.prepare('UPDATE projects SET root_path = NULL WHERE id = ?').run(x.project.id);
    const messagesBefore = count('messages');

    await expect(h.runtime.finishCodingTask(viaPage, 'dispatch')).rejects.toThrow(UNBOUND);
    expect(taskRow(viaPage).status).toBe('queued');

    const y1 = await chatDraft(h, y.project.id, '照常做完');
    await h.runtime.acceptTodo(y1.todoId);
    await vi.waitFor(() => expect(taskRow(y1.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.executed).toEqual([y1.taskId]);
    expect(taskRow(viaChat.taskId).status).toBe('queued');
    expect(taskRow(viaPage).status).toBe('queued');
    expect(reports(viaChat.conversationId)).toEqual([
      {
        content: `「聊天里提的」停在排队里：${UNBOUND}`,
        meta: { kind: 'task_report', taskId: viaChat.taskId, status: 'folder_missing' },
      },
    ]);
    // 多出来的消息只有：y1 那一轮的一问一答、它做完的回报、被拦那条的回报
    expect(count('messages') - messagesBefore).toBe(4);
  });

  it('宿主的 folderGap 回调：给了就照它说的拦、话原样进回报；没给的宿主行为不变', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const first = await chatDraft(h, project.id, '第一个');
    const second = await chatDraft(h, project.id, '第二个');
    await h.coding.approveAndQueue(first.taskId);
    await h.coding.approveAndQueue(second.taskId);
    h.permissions.revoke(grantId);

    // 给了回调：只拦它说要拦的那一个，另一个照常派
    const asked: string[] = [];
    const host: CodingDispatchHost = {
      db,
      coding: h.coding,
      conversations: h.conversations,
      folderGap: (taskId) => {
        asked.push(taskId);
        return taskId === first.taskId ? '宿主说的一句话' : null;
      },
    };
    new CodingDispatch(host).kick(second.taskId);
    await vi.waitFor(() => expect(taskRow(second.taskId).status).toBe('pending_accept'), WAIT);
    expect(asked).toContain(first.taskId);
    expect(taskRow(first.taskId).status).toBe('queued');
    expect(h.executed).toEqual([second.taskId]);
    expect(reports(first.conversationId)).toEqual([
      {
        content: '「第一个」停在排队里：宿主说的一句话',
        meta: { kind: 'task_report', taskId: first.taskId, status: 'folder_missing' },
      },
    ]);

    // 没给回调的宿主：不问、不拦（授权撤没撤销都照旧派）
    new CodingDispatch({ db, coding: h.coding, conversations: h.conversations }).kick(first.taskId);
    await vi.waitFor(() => expect(taskRow(first.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.executed).toEqual([second.taskId, first.taskId]);
  });
});

describe('条件 5：上级文件夹的授权还有效', () => {
  it('算有授权：聊天里提、点「要做」自动派发，任务页批准、派发，都照常', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    // 自己的那一条撤销了，但上级文件夹有一条有效的
    h.permissions.revoke(grantId);
    h.permissions.grantFolder(dirname(root));
    expect(h.permissions.activePermissionForPath(root)!.id).not.toBe(grantId);

    const end = await withInFlightAsk(h, project.id);
    await expect(propose(h)).resolves.toMatchObject({ status: 'draft' });
    await end();

    const viaPage = draft(h, project.id, '任务页批准再派发');
    await h.runtime.approveCodingTask(viaPage.id);
    await h.runtime.finishCodingTask(viaPage.id, 'dispatch');
    expect(taskRow(viaPage.id).status).toBe('pending_accept');

    const viaChat = await chatDraft(h, project.id, '点要做自动派发');
    await h.runtime.acceptTodo(viaChat.todoId);
    await vi.waitFor(() => expect(taskRow(viaChat.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.executed).toEqual([viaPage.id, viaChat.taskId]);
    expect(reports(viaChat.conversationId).map((r) => r.meta['status'])).toEqual([
      'pending_accept',
    ]);
  });
});

describe('条件 7：没绑文件夹的项目', () => {
  it('三个入口报的还是 P4 那一句，不是这一句', async () => {
    const h = setup();
    const bare = h.projects.create({ name: '没绑的', rootPath: null, description: null });
    const end = await withInFlightAsk(h, bare.id);
    await expect(propose(h)).rejects.toThrow(UNBOUND);
    await end();
    const d = draft(h, bare.id, '没绑的草案');
    const todo = h.todos.propose({
      title: '没绑的草案',
      linked: { kind: 'coding_task', id: d.id },
    })!;
    await expect(h.runtime.acceptTodo(todo.id)).rejects.toThrow(UNBOUND);
    await expect(h.runtime.approveCodingTask(d.id)).rejects.toThrow(UNBOUND);
    expect(taskRow(d.id).status).toBe('draft');
  });
});

describe('条件 8：已经在执行的任务', () => {
  it('执行途中授权撤销：任务照常跑完，不被拦下、不被取消，回报照常', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const running = await chatDraft(h, project.id, `${HOLD} 执行到一半`);
    await h.runtime.acceptTodo(running.todoId);
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('running'), WAIT);
    await vi.waitFor(() => expect(h.executed).toContain(running.taskId), WAIT);

    h.permissions.revoke(grantId);
    expect(taskRow(running.taskId).status).toBe('running');
    h.releaseExecutor();
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('pending_accept'), WAIT);
    expect(h.coding.store.runningCount()).toBe(0);
    expect(reports(running.conversationId).map((r) => r.meta['status'])).toEqual([
      'pending_accept',
    ]);
  });
});
