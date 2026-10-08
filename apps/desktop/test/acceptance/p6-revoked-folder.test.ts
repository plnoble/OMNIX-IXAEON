/**
 * P6 验收（规格 docs/委派/P6-授权撤销后不建副本不派任务.md，条件 1–8）。
 * B 档：先只交测试，整合方锁定后再写实现（与 P5 同法）。
 *
 * 钉住的接缝：
 * - `AppRuntime.assertProjectFolderBound`（P4 加的、三个入口共用的那道检查）多查一条：
 *   项目绑着文件夹、但 `permissions.activePermissionForPath(root_path)` 是 null →
 *   报「授权已撤销那句」，入口表现照 P4（不建草案/不记审计、不批准、不建副本）。
 * - 任务页点「派发」`finishCodingTask(id, 'dispatch')`：同样拦，任务留在排队，执行器不被调用。
 * - 自动派发（CodingDispatch）经宿主新的可选回调
 *   `folderGap?: (taskId: string) => string | null` 判断：拦下时跳过、留在排队、接着派后面的；
 *   发起对话里回报「<目标第一行>」停在排队里：<授权已撤销那句>，meta.status 'folder_missing'，
 *   同一个任务只写一次。没绑文件夹（P4 那句）也经这个回调走同一条路。
 * - 已经在执行的任务不管（照常跑完）。
 *
 * 固定文案：
 * - 授权已撤销那句：「这个项目文件夹的读取授权已经撤销：在项目页解除绑定、重新绑定之后，再派编码任务。」
 * - 没绑文件夹（照旧 P4 的那句）：「这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。」
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeProvider,
  PermissionService,
  ProjectService,
  SearchService,
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
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'nul';
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
  const f = join(dir, label);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, 'note.txt'), '合成文件\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: f });
  execFileSync('git', ['add', '-A'], { cwd: f });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init'],
    { cwd: f },
  );
  return f;
}

interface Harness {
  runtime: AppRuntime;
  projects: ProjectService;
  permissions: PermissionService;
  conversations: ConversationStore;
  todos: TodoStore;
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
    async run(task, workspace, signal) {
      executed.push(task.id);
      if (task.goal.startsWith(HOLD)) {
        await executorGate;
      }
      void signal;
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
    coding,
    executed,
    releaseExecutor: openExecutor,
    dataDir,
  };
}

/** 新建项目并绑定一个合成的 git 文件夹（发授权），返回项目与授权 id。 */
async function bound(
  h: Harness,
  name = '合成项目',
): Promise<{ project: Project; root: string; grantId: string }> {
  const created = h.projects.create({ name, rootPath: null, description: null });
  const root = gitFolder(`repo-${name}`);
  const project = await h.runtime.bindProjectFolder(created.id, root);
  const grant = h.permissions.activePermissionForPath(root)!;
  return { project, root, grantId: grant.id };
}

const taskRow = (id: string) =>
  db.prepare('SELECT status, workspace_path FROM coding_tasks WHERE id = ?').get(id) as {
    status: string;
    workspace_path: string | null;
  };

const draft = (h: Harness, projectId: string, goal: string) =>
  h.coding.create({ projectId, goal, scope: ['note.txt'], allowedCommands: [] });

const audits = (kind: string): number =>
  (db.prepare('SELECT count(*) AS n FROM audit_events WHERE kind = ?').get(kind) as { n: number })
    .n;

/** 对话里的任务回报。 */
const reports = (conversationId: string) =>
  (
    db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ content: string; meta_json: string }>
  )
    .map((m) => ({ content: m.content, meta: JSON.parse(m.meta_json) as Record<string, unknown> }))
    .filter((m) => m.meta['kind'] === 'task_report');

/** 聊天那条路：真的走一轮提问，会话替身在这一轮里建出草案。 */
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

/** 让一次提问停在半路，好在这个上下文中调 propose_coding_task。之后放行。 */
async function withInFlightAsk(
  h: Harness,
  projectId: string,
  run: (input: { runId?: string }) => void,
): Promise<() => Promise<void>> {
  const conv = h.conversations.create({ projectId });
  let finish!: () => void;
  const hold = new Promise<void>((r) => {
    finish = r;
  });
  (h.runtime as unknown as { askSessions: Map<string, AgentSession> }).askSessions.set(conv.id, {
    run: async (input: { runId?: string }) => {
      await hold;
      run(input);
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

describe('条件 1：绑着文件夹、授权撤销了', () => {
  it('propose_coding_task 不建草案、不记审计，错误就是「授权已撤销那句」', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    h.permissions.revoke(grantId);
    const end = await withInFlightAsk(h, project.id, () => undefined);
    const tasksBefore = (
      db.prepare('SELECT count(*) AS n FROM coding_tasks').get() as { n: number }
    ).n;
    const auditsBefore = audits('hermes.propose_coding_task');

    await expect(
      h.runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow(REVOKED);
    expect((db.prepare('SELECT count(*) AS n FROM coding_tasks').get() as { n: number }).n).toBe(
      tasksBefore,
    );
    expect(audits('hermes.propose_coding_task')).toBe(auditsBefore);
    await end();
  });

  it('已有的草案点「要做」与任务页批准：都报这句话，没批准、没副本，待办还是「等你拍板」', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const d = draft(h, project.id, '解除之前的草案');
    const todo = h.todos.propose({
      title: '解除之前的草案',
      linked: { kind: 'coding_task', id: d.id },
    })!;
    h.permissions.revoke(grantId);

    await expect(h.runtime.acceptTodo(todo.id)).rejects.toThrow(REVOKED);
    expect(taskRow(d.id).status).toBe('draft');
    expect(taskRow(d.id).workspace_path).toBeNull();
    expect(existsSync(join(h.dataDir, 'workspaces', d.id))).toBe(false);
    expect(h.todos.get(todo.id).status).toBe('proposed');

    await expect(h.runtime.approveCodingTask(d.id)).rejects.toThrow(REVOKED);
    expect(taskRow(d.id).status).toBe('draft');
    expect(taskRow(d.id).workspace_path).toBeNull();
    expect(existsSync(join(h.dataDir, 'workspaces', d.id))).toBe(false);
    expect(h.executed).toEqual([]);
  });
});

describe('条件 2：早先批准好、在排队，之后授权撤销', () => {
  it('任务页点派发：报这句话，任务还在排队，执行器没被调', async () => {
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
});

describe('条件 3、4：自动派发', () => {
  it('轮到它：跳过、留在排队、对话里一条 folder_missing 回报；再触发几次还是这一条；后面的别的项目照常做完', async () => {
    const h = setup();
    const x = await bound(h, '授权撤销的');
    const y = await bound(h, '授权还在的');
    // X 先批准排着（早于 Y）；Y 由「要做」批准并触发自动派发
    const xDraft = await chatDraft(h, x.project.id, '第一条：停在排队里');
    await h.runtime.approveCodingTask(xDraft.taskId);
    expect(taskRow(xDraft.taskId).status).toBe('queued');
    const yDraft = await chatDraft(h, y.project.id, '第二条：照常做完');
    const y2Draft = await chatDraft(h, y.project.id, '第三条：照常做完');
    h.permissions.revoke(x.grantId);

    await h.runtime.acceptTodo(yDraft.todoId);
    await vi.waitFor(() => expect(taskRow(yDraft.taskId).status).toBe('pending_accept'), {
      timeout: 60_000,
    });
    expect(h.executed).toContain(yDraft.taskId);
    expect(h.executed).not.toContain(xDraft.taskId);
    expect(taskRow(xDraft.taskId).status).toBe('queued');
    const first = reports(xDraft.conversationId);
    expect(first).toHaveLength(1);
    expect(first[0]!.meta['status']).toBe('folder_missing');
    expect(first[0]!.content).toBe(`「第一条：停在排队里」停在排队里：${REVOKED}`);

    // 再触发一次自动派发：被拦的这条还是一条回报，后面的继续派
    await h.runtime.acceptTodo(y2Draft.todoId);
    await vi.waitFor(() => expect(taskRow(y2Draft.taskId).status).toBe('pending_accept'), {
      timeout: 60_000,
    });
    expect(taskRow(xDraft.taskId).status).toBe('queued');
    expect(reports(xDraft.conversationId)).toHaveLength(1);
    expect(h.executed).toContain(y2Draft.taskId);
    expect(h.executed).not.toContain(xDraft.taskId);
  });
});

describe('条件 5：上级文件夹的授权还有效', () => {
  it('算有授权，批准、派发照常', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    // 自己的那一条撤销，但上级文件夹有一条有效的
    h.permissions.revoke(grantId);
    h.permissions.grantFolder(join(root, '..'));
    const d = draft(h, project.id, '上级授权兜底');
    await h.runtime.approveCodingTask(d.id);
    await h.runtime.finishCodingTask(d.id, 'dispatch');
    await vi.waitFor(() => expect(taskRow(d.id).status).toBe('pending_accept'), {
      timeout: 60_000,
    });
    expect(h.executed).toContain(d.id);
  });
});

describe('条件 7：没绑文件夹的项目', () => {
  it('报的还是 P4 那一句，不是这一句', async () => {
    const h = setup();
    const bare = h.projects.create({ name: '没绑的', rootPath: null, description: null });
    const end = await withInFlightAsk(h, bare.id, () => undefined);
    await expect(
      h.runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow(UNBOUND);
    await end();
    const d = draft(h, bare.id, '没绑的草案');
    await expect(h.runtime.approveCodingTask(d.id)).rejects.toThrow(UNBOUND);
  });
});

describe('条件 8：已经在执行的任务', () => {
  it('执行途中授权撤销：任务照常跑完，不被这一单拦下、不被取消', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const running = await chatDraft(h, project.id, `${HOLD} 执行到一半`);
    await h.runtime.acceptTodo(running.todoId);
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('running'), {
      timeout: 60_000,
    });
    await vi.waitFor(() => expect(h.executed).toContain(running.taskId), { timeout: 60_000 });
    h.permissions.revoke(grantId);
    expect(taskRow(running.taskId).status).toBe('running');
    h.releaseExecutor();
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('pending_accept'), {
      timeout: 60_000,
    });
    expect(taskRow(running.taskId).status).toBe('pending_accept');
    expect(h.coding.store.runningCount()).toBe(0);
  });
});
