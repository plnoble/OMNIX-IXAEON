/**
 * P5 验收（规格 docs/委派/P5-解除项目的文件夹绑定.md，条件 1–10、12；条件 11 的界面在
 * p5-unbind-page.test.ts）。执行方先推了一版，整合方 2026-10-08 锁定前重写（规格末尾
 * 「整合方审测试时的改正与补充」）。
 *
 * 真的运行时方法（AppRuntime 的原型）、真的编排与自动派发（CodingOrchestrator、CodingDispatch）、
 * 真的授权与来源；项目文件夹是合成的 git 仓库。只有执行器是按目标的开头走的替身：
 * 目标以「[卡住]」开头就停在执行中等放行，以「[失败]」开头就说自己没做成，别的照常改 note.txt。
 *
 * 钉住的接缝：
 * - `AppRuntime.previewUnbindProjectFolder(projectId)`、`AppRuntime.unbindProjectFolder(projectId)`；
 * - 审计 `project.folder_unbound`，内容 `{ projectId, grantId, cancelledTasks }`；
 * - 拒绝的话：「这个项目没有绑定文件夹」；解除之后派不了任务报 P4 那一句；
 * - 预览的 `rootPath` 就是项目上存的那个 `root_path`（项目行上显示的那个），不另做规范化。
 *
 * 原版里写坏的（改掉了）：
 * - 条件 3 把派发换成了只记任务号的替身，却去对话里找「取消了」的回报——替身不写回报，
 *   实现写对了这条也过不了；任务号还是从一个没等的 Promise 上取的。这里用真的派发。
 * - 条件 9 的任务没有任何改动、项目也不是 git 仓库，却指望接受后建出分支。
 * - 为了拿一句文案引入了 P4 的测试文件，结果 P4 的 10 条在这个文件里又跑了一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeProvider,
  ItemService,
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
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

/** P4 拦三处入口的那一句（逐字）。 */
const UNBOUND_MESSAGE = '这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。';
const NO_FOLDER = '这个项目没有绑定文件夹';
/** 执行器替身认的两个开头：停在执行中等放行；说自己没做成。 */
const HOLD = '[卡住]';
const FAIL = '[失败]';

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};
/** 这一条用例里放行卡住的执行器、卡住的验证（收尾时一定要放，不然派发永远不结束）。 */
let releases: Array<() => void> = [];

beforeEach(() => {
  // 隔开本机的 git 全局配置：提交签名、全局钩子不能影响合成仓库
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'nul';
  }
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p5-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  releases = [];
});

afterEach(async () => {
  for (const release of releases) release();
  // 等后台的派发收尾，再关库
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

/** 路径的规范形：真实路径（短名→长名）、统一斜杠、去尾斜杠，Windows 上不分大小写。 */
function canon(p: string): string {
  let r = resolve(p);
  try {
    r = realpathSync.native(r);
  } catch {
    // 不存在就只做词法规范化
  }
  r = r.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 合成的 git 项目文件夹（一个 note.txt，一次提交）。 */
function gitFolder(label: string): string {
  const f = join(dir, label);
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
  items: ItemService;
  coding: CodingOrchestrator;
  /** 执行器被调过的任务号（按次序）。 */
  executed: string[];
  /** 卡住的执行器收到取消信号的那一刻，库里是什么样（项目的路径、有效授权的条数）。 */
  atCancel: Array<{ rootPath: string | null; activeGrants: number }>;
  /** 放行所有「卡住」的执行器。 */
  releaseExecutor(): void;
  /** 让下一次验证卡住，返回放行它的函数。 */
  holdVerify(): () => void;
}

function setup(): Harness {
  const executed: string[] = [];
  const atCancel: Harness['atCancel'] = [];
  let openExecutor!: () => void;
  const executorGate = new Promise<void>((r) => {
    openExecutor = r;
  });
  releases.push(openExecutor);
  const executor: CodingExecutor = {
    name: 'scripted',
    async run(task, workspace, signal) {
      executed.push(task.id);
      // 派发时目标后面还接了范围、背景几段，所以只看开头
      if (task.goal.startsWith(HOLD)) {
        signal?.addEventListener('abort', () => {
          atCancel.push({
            rootPath: (
              db.prepare('SELECT root_path FROM projects WHERE id = ?').get(task.project_id) as {
                root_path: string | null;
              }
            ).root_path,
            activeGrants: (
              db.prepare("SELECT count(*) AS n FROM permissions WHERE status = 'active'").get() as {
                n: number;
              }
            ).n,
          });
        });
        await executorGate;
      }
      if (task.goal.startsWith(FAIL)) {
        return {
          claimedSuccess: false,
          summary: '合成的失败',
          changedPaths: [],
          testsModified: false,
          raw: '',
        };
      }
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
  let verifyGate: Promise<void> | null = null;
  const runCheck = async (argv: string[]): Promise<IndependentCheck> => {
    if (verifyGate) await verifyGate;
    return { argv, exitCode: 0, output: 'ok', ran: true };
  };
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const items = new ItemService(db);
  const sources = new SourceStore(db);
  const coding = new CodingOrchestrator(db, executor, join(dir, 'data'), runCheck);
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
    items,
    search: new SearchService(db),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('p5'),
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
    items,
    coding,
    executed,
    atCancel,
    releaseExecutor: openExecutor,
    holdVerify() {
      let open!: () => void;
      verifyGate = new Promise<void>((r) => {
        open = r;
      });
      releases.push(open);
      return () => {
        verifyGate = null;
        open();
      };
    },
  };
}

/** 新建项目并绑定一个合成的 git 文件夹（走真的 bindProjectFolder，会发授权）。 */
async function bound(
  h: Harness,
  name = '合成项目',
): Promise<{ project: Project; root: string; grantId: string }> {
  const created = h.projects.create({ name, rootPath: null, description: null });
  const root = gitFolder(`repo-${name}`);
  const project = await h.runtime.bindProjectFolder(created.id, root);
  return { project, root, grantId: ownGrant(root)!.id };
}

/** 这个文件夹自己的那条授权（locator 就是它；不管有效还是已撤销，取最新的）。 */
function ownGrants(root: string): Array<{ id: string; status: string }> {
  return (
    db
      .prepare(
        "SELECT id, status, locator FROM permissions WHERE scope_type = 'folder' ORDER BY granted_at, rowid",
      )
      .all() as Array<{ id: string; status: string; locator: string }>
  ).filter((g) => canon(g.locator) === canon(root));
}
const ownGrant = (root: string) => ownGrants(root).find((g) => g.status === 'active') ?? null;

const taskRow = (id: string) =>
  db
    .prepare(
      'SELECT status, workspace_path, applied_ref, apply_error FROM coding_tasks WHERE id = ?',
    )
    .get(id) as {
    status: string;
    workspace_path: string | null;
    applied_ref: string | null;
    apply_error: string | null;
  };

const audits = (kind: string): Array<Record<string, unknown>> =>
  (
    db.prepare('SELECT detail_json FROM audit_events WHERE kind = ?').all(kind) as Array<{
      detail_json: string;
    }>
  ).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);

/** 对话里的任务回报。 */
const reports = (conversationId: string) =>
  (
    db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ content: string; meta_json: string }>
  )
    .map((m) => ({ content: m.content, meta: JSON.parse(m.meta_json) as Record<string, unknown> }))
    .filter((m) => m.meta['kind'] === 'task_report');

/** 库里和解除绑定有关的一切：用来证明「什么都没变」。 */
function snapshot() {
  return {
    projects: db.prepare('SELECT id, root_path FROM projects ORDER BY id').all(),
    permissions: db.prepare('SELECT id, status, revoked_at FROM permissions ORDER BY id').all(),
    tasks: db.prepare('SELECT id, status, generation FROM coding_tasks ORDER BY id').all(),
    todos: db.prepare('SELECT id, status FROM todos ORDER BY id').all(),
    audits: (db.prepare('SELECT count(*) AS n FROM audit_events').get() as { n: number }).n,
    messages: (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n,
    sources: (db.prepare('SELECT count(*) AS n FROM sources').get() as { n: number }).n,
    items: (db.prepare('SELECT count(*) AS n FROM items').get() as { n: number }).n,
  };
}

/** 任务页那条路：建草案。 */
function draft(h: Harness, projectId: string, goal: string, commands: string[][] = []) {
  return h.coding.create({ projectId, goal, scope: ['note.txt'], allowedCommands: commands });
}

/** 任务页那条路：建草案、批准、派发，等它停下（等接受 / 失败）。 */
async function runToEnd(h: Harness, projectId: string, goal: string): Promise<string> {
  const task = draft(h, projectId, goal);
  await h.runtime.approveCodingTask(task.id);
  await h.runtime.finishCodingTask(task.id, 'dispatch');
  return task.id;
}

/**
 * 聊天那条路（照 D3）：真的走一轮提问，会话替身在这一轮里建出草案——任务带着这一轮的
 * origin_run_id，对话里挂着它的待办卡。返回任务号、待办号、对话号。
 */
async function chatDraft(
  h: Harness,
  projectId: string,
  goal: string,
  commands: string[][] = [],
): Promise<{ taskId: string; todoId: string; conversationId: string }> {
  const conv = h.conversations.create({ projectId });
  let taskId = '';
  (h.runtime as unknown as { askSessions: Map<string, AgentSession> }).askSessions.set(conv.id, {
    run: async () => {
      taskId = draft(h, projectId, goal, commands).id;
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
    getEngineSessionId: () => 's-p5',
  } as unknown as AgentSession);
  const answered = await h.runtime.ask({
    conversationId: conv.id,
    projectId,
    question: '把这个做了',
  });
  const todo = h.todos.list({ status: ['proposed'] }).find((t) => t.linked_id === taskId);
  return { taskId, todoId: todo!.id, conversationId: answered.conversationId };
}

/** 往这条授权下放一份导入的资料（projectId 是 null = 没归到哪个项目）。返回来源号。 */
function sourceUnder(h: Harness, permissionId: string, projectId: string | null): string {
  return h.sources.insertParsed(
    {
      kind: 'project_snapshot',
      provider: 'project',
      accountNamespace: 'local',
      externalId: randomUUID(),
      title: '合成资料',
      contentHash: randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      capturedAt: '2026-10-01T08:00:00.000Z',
      importMethod: 'project_snapshot',
      segments: [
        {
          sequence: 0,
          role: 'document',
          externalNodeId: null,
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: '2026-10-01T08:00:00.000Z',
          text: '合成的资料正文',
          metadata: {},
        },
      ],
      metadata: {},
    },
    { permissionId, projectId, rawPath: `sha256/aa/${'a'.repeat(64)}` },
  ).id;
}
/** 一条从这份资料提炼出来的条目。返回条目号。 */
function itemFrom(h: Harness, sourceId: string, projectId: string): string {
  const item = h.items.createManual({
    projectId,
    type: 'decision',
    statement: '从合成资料里提炼出的一条',
    rationale: null,
  });
  db.prepare('UPDATE items SET extracted_from_source_id = ? WHERE id = ?').run(sourceId, item.id);
  return item.id;
}
/** 来源页上这份资料的授权状态。 */
const sourceGrantStatus = (h: Harness, sourceId: string) =>
  h.sources.list({ projectId: null }).find((s) => s.source.id === sourceId)?.permissionStatus;

/** 同一个文件夹的另一种写法（大小写、斜杠方向、结尾斜杠）。 */
const respelled = (root: string): string =>
  process.platform === 'win32' ? `${root.replaceAll('\\', '/').toUpperCase()}/` : `${root}/`;

describe('条件 1：解除绑定', () => {
  it('路径清空、那条授权撤销、审计一条、返回的东西如实', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const done = await h.runtime.unbindProjectFolder(project.id);

    expect(done.project.id).toBe(project.id);
    expect(done.project.root_path).toBeNull();
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    expect(done.revokedPermissionId).toBe(grantId);
    const grant = h.permissions.get(grantId)!;
    expect(grant.status).toBe('revoked');
    expect(grant.revoked_at).not.toBeNull();
    expect(done.cancelledTaskIds).toEqual([]);
    expect(audits('project.folder_unbound')).toEqual([
      { projectId: project.id, grantId, cancelledTasks: 0 },
    ]);
  });

  it('项目上存的路径和授权的写法不一样（大小写、斜杠、结尾斜杠）：认得出是同一个文件夹，照样撤销', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    // 早先用别的写法登记的项目：路径和授权的 locator 字面上对不上（契约 3：照 canon 比）
    const stored = respelled(root);
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(stored, project.id);
    expect(h.permissions.get(grantId)!.locator).not.toBe(stored);

    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('revoke');
    expect(preview.rootPath).toBe(stored);
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBe(grantId);
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    expect(h.projects.get(project.id)!.root_path).toBeNull();
  });
});

describe('条件 2：解除之后这个项目派不了编码任务', () => {
  it('聊天里提、点「要做」、任务页批准，都报 P4 那一句；任务和待办不动', async () => {
    const h = setup();
    const { project } = await bound(h);
    // 解除之前就有的一个草案和它的待办
    const existing = draft(h, project.id, '解除之前的草案');
    const todo = h.todos.propose({
      title: '解除之前的草案',
      linked: { kind: 'coding_task', id: existing.id },
    })!;
    await h.runtime.unbindProjectFolder(project.id);

    // 聊天里提：真的有一轮在回答（照 P4 条件 4）
    const conv = h.conversations.create({ projectId: project.id });
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
      getEngineSessionId: () => 's-p5',
    } as unknown as AgentSession);
    const asking = h.runtime
      .ask({ conversationId: conv.id, projectId: project.id, question: '加个文件' })
      .catch(() => undefined);
    const active = (h.runtime as unknown as { activeAskRuns: Map<string, string> }).activeAskRuns;
    await vi.waitFor(() => expect(active.size).toBe(1));
    const tasksBefore = (
      db.prepare('SELECT count(*) AS n FROM coding_tasks').get() as { n: number }
    ).n;
    await expect(
      h.runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow(UNBOUND_MESSAGE);
    expect((db.prepare('SELECT count(*) AS n FROM coding_tasks').get() as { n: number }).n).toBe(
      tasksBefore,
    );
    finish();
    await asking;

    await expect(h.runtime.acceptTodo(todo.id)).rejects.toThrow(UNBOUND_MESSAGE);
    await expect(h.runtime.approveCodingTask(existing.id)).rejects.toThrow(UNBOUND_MESSAGE);
    expect(taskRow(existing.id).status).toBe('draft');
    expect(taskRow(existing.id).workspace_path).toBeNull();
    expect(h.todos.get(todo.id).status).toBe('proposed');
    expect(h.executed).toEqual([]);
  });
});

describe('条件 3：解除时在途的任务被取消，别的不动', () => {
  it('执行中的、排队的取消并在各自的对话里回报；草案、等批准、等接受、已结束的不动；副本都还在', async () => {
    const h = setup();
    const { project } = await bound(h);
    // 先把不该动的几种状态做出来（都走真的流程）
    const keptDraft = draft(h, project.id, '一直是草案').id;
    const keptWaiting = draft(h, project.id, '建了副本等批准').id;
    h.coding.store.prepareWorkspace(keptWaiting, join(dir, 'data'));
    const keptPending = await runToEnd(h, project.id, '做完等接受');
    const keptCompleted = await runToEnd(h, project.id, '做完也接受了');
    await h.runtime.acceptCodingTask(keptCompleted);
    const keptFailed = await runToEnd(h, project.id, `${FAIL} 执行器说没做成`);
    const keptCancelled = draft(h, project.id, '批准后自己取消的').id;
    await h.runtime.approveCodingTask(keptCancelled);
    await h.runtime.finishCodingTask(keptCancelled, 'cancel');
    const kept: Record<string, string> = {
      [keptDraft]: 'draft',
      [keptWaiting]: 'waiting_approval',
      [keptPending]: 'pending_accept',
      [keptCompleted]: 'completed',
      [keptFailed]: 'failed',
      [keptCancelled]: 'cancelled',
    };
    for (const [id, status] of Object.entries(kept)) expect(taskRow(id).status).toBe(status);

    // 在途的两个：都是聊天里提的（各有各的对话）。第一个卡在执行中，第二个排在它后面
    const running = await chatDraft(h, project.id, `${HOLD} 执行到一半`);
    const queued = await chatDraft(h, project.id, '排在后面的');
    await h.runtime.acceptTodo(running.todoId);
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('running'), {
      timeout: 60_000,
    });
    await vi.waitFor(() => expect(h.executed).toContain(running.taskId), { timeout: 60_000 });
    await h.runtime.acceptTodo(queued.todoId);
    expect(taskRow(queued.taskId).status).toBe('queued');
    // 除了草案，个个都有副本
    const copies = [...Object.keys(kept), running.taskId, queued.taskId]
      .map((id) => taskRow(id).workspace_path)
      .filter((p): p is string => p !== null);
    expect(copies).toHaveLength(7);
    const before = snapshot();
    const storedRoot = h.projects.get(project.id)!.root_path;

    const done = await h.runtime.unbindProjectFolder(project.id);

    expect(done.cancelledTaskIds.slice().sort()).toEqual([running.taskId, queued.taskId].sort());
    expect(taskRow(running.taskId).status).toBe('cancelled');
    expect(taskRow(queued.taskId).status).toBe('cancelled');
    // 契约 4 的次序：先取消，再清路径、撤授权——执行器收到取消信号的那一刻两样都还在
    expect(h.atCancel).toEqual([{ rootPath: storedRoot, activeGrants: 1 }]);
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    for (const conversationId of [running.conversationId, queued.conversationId]) {
      const written = reports(conversationId);
      expect(written).toHaveLength(1);
      expect(written[0]!.content).toContain('取消了');
      expect(written[0]!.meta['status']).toBe('cancelled');
    }
    expect(audits('project.folder_unbound')).toEqual([
      expect.objectContaining({ projectId: project.id, cancelledTasks: 2 }),
    ]);
    // 别的状态一个没动
    for (const [id, status] of Object.entries(kept)) expect(taskRow(id).status).toBe(status);
    // 不删任何东西：任务、待办、来源、条目的条数不变，副本目录都还在
    const after = snapshot();
    expect(after.tasks.length).toBe(before.tasks.length);
    expect(after.todos.length).toBe(before.todos.length);
    expect(after.sources).toBe(before.sources);
    expect(after.items).toBe(before.items);
    for (const copy of copies) expect(existsSync(copy), `副本还在：${copy}`).toBe(true);

    // 放行卡住的执行器：晚到的结果不能把「取消」盖掉，排队的那个也没有被派出去
    h.releaseExecutor();
    await vi.waitFor(() => expect(h.coding.store.runningCount()).toBe(0), { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(taskRow(running.taskId).status).toBe('cancelled');
    expect(taskRow(queued.taskId).status).toBe('cancelled');
    expect(h.executed).not.toContain(queued.taskId);
    expect(reports(running.conversationId)).toHaveLength(1);
  });

  it('验证中的任务也取消', async () => {
    const h = setup();
    const { project } = await bound(h);
    const release = h.holdVerify();
    const verifying = await chatDraft(h, project.id, '写完之后验证停着', [
      [process.execPath, '-e', "require('node:fs').readFileSync('note.txt')"],
    ]);
    await h.runtime.acceptTodo(verifying.todoId);
    await vi.waitFor(() => expect(taskRow(verifying.taskId).status).toBe('pending_verify'), {
      timeout: 60_000,
    });

    // 预览里验证中的也算会被取消的（整合方复审实现时补的：预览和解除各查各的，要各测各的）
    expect((await h.runtime.previewUnbindProjectFolder(project.id)).inFlightTasks).toBe(1);
    expect(taskRow(verifying.taskId).status).toBe('pending_verify');
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.cancelledTaskIds).toEqual([verifying.taskId]);
    expect(taskRow(verifying.taskId).status).toBe('cancelled');
    expect(reports(verifying.conversationId).map((r) => r.meta['status'])).toEqual(['cancelled']);

    release();
    await vi.waitFor(() => expect(h.coding.store.runningCount()).toBe(0), { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(taskRow(verifying.taskId).status).toBe('cancelled');
  });

  it('别的项目的任务不取消，也不算进预览', async () => {
    const h = setup();
    const mine = await bound(h, '甲');
    const theirs = await bound(h, '乙');
    const theirPending = await runToEnd(h, theirs.project.id, '乙的，做完等接受');
    const theirQueued = draft(h, theirs.project.id, '乙的，批准了排着').id;
    await h.runtime.approveCodingTask(theirQueued);
    expect(taskRow(theirQueued).status).toBe('queued');
    expect(taskRow(theirPending).status).toBe('pending_accept');

    const preview = await h.runtime.previewUnbindProjectFolder(mine.project.id);
    expect(preview.inFlightTasks).toBe(0);
    expect(preview.pendingAcceptTasks).toBe(0);
    const done = await h.runtime.unbindProjectFolder(mine.project.id);
    expect(done.cancelledTaskIds).toEqual([]);
    expect(done.revokedPermissionId).toBe(mine.grantId);
    expect(taskRow(theirQueued).status).toBe('queued');
    expect(taskRow(theirPending).status).toBe('pending_accept');
    // 乙照旧绑着、授权照旧有效
    expect(h.projects.get(theirs.project.id)!.root_path).toBe(theirs.project.root_path);
    expect(h.permissions.get(theirs.grantId)!.status).toBe('active');
  });
});

describe('条件 4：这条授权下导入过资料', () => {
  it('解除之后资料的授权状态是已撤销；提炼出的条目一条不少', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const sourceId = sourceUnder(h, grantId, project.id);
    const itemId = itemFrom(h, sourceId, project.id);
    // 同一条授权下、没归到这个项目的资料也一样
    const loose = sourceUnder(h, grantId, null);
    expect(sourceGrantStatus(h, sourceId)).toBe('active');
    expect(sourceGrantStatus(h, loose)).toBe('active');
    expect((await h.runtime.previewUnbindProjectFolder(project.id)).sourcesUnderGrant).toBe(2);
    const before = snapshot();

    await h.runtime.unbindProjectFolder(project.id);

    expect(sourceGrantStatus(h, sourceId)).toBe('revoked');
    expect(sourceGrantStatus(h, loose)).toBe('revoked');
    expect(h.sources.get(sourceId)!.project_id).toBe(project.id);
    expect(h.sources.countItems(sourceId)).toBe(1);
    expect(h.items.get(itemId).statement).toBe('从合成资料里提炼出的一条');
    const after = snapshot();
    expect(after.sources).toBe(before.sources);
    expect(after.items).toBe(before.items);
  });
});

describe('条件 5：别的项目也绑着同一个文件夹', () => {
  it('只清这个项目的路径，授权仍然有效；预览说不撤销、资料数是 0', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h, '甲');
    const sourceId = sourceUnder(h, grantId, project.id);
    // 另一个项目绑着同一个文件夹，路径写法不一样（P4 的绑定不许这样，这里直接落库造出来）
    const other = h.projects.create({ name: '乙', rootPath: null, description: null });
    const variant = respelled(root);
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(variant, other.id);

    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('kept_other_project');
    expect(preview.sourcesUnderGrant).toBe(0);

    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBeNull();
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    expect(h.projects.get(other.id)!.root_path).toBe(variant);
    expect(h.permissions.get(grantId)!.status).toBe('active');
    expect(sourceGrantStatus(h, sourceId)).toBe('active');
    expect(audits('project.folder_unbound')).toEqual([
      { projectId: project.id, grantId: null, cancelledTasks: 0 },
    ]);
  });

  it('那个项目已经归档也算（契约 4：不管什么状态）', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h, '甲');
    const other = h.projects.create({ name: '乙', rootPath: null, description: null });
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(root, other.id);
    h.projects.updateStatus(other.id, 'archived');

    expect((await h.runtime.previewUnbindProjectFolder(project.id)).grant).toBe(
      'kept_other_project',
    );
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBeNull();
    expect(h.permissions.get(grantId)!.status).toBe('active');
    expect(h.projects.get(project.id)!.root_path).toBeNull();
  });

  it('别的项目绑的是上级文件夹：不算同一个，自己的那条照样撤销，上级那条不动', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h, '甲');
    const upper = h.projects.create({ name: '乙', rootPath: null, description: null });
    await h.runtime.bindProjectFolder(upper.id, dirname(root));
    const upperGrant = ownGrant(dirname(root))!;
    expect(upperGrant.id).not.toBe(grantId);

    expect((await h.runtime.previewUnbindProjectFolder(project.id)).grant).toBe('revoke');
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBe(grantId);
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    expect(h.permissions.get(upperGrant.id)!.status).toBe('active');
    expect(canon(h.projects.get(upper.id)!.root_path!)).toBe(canon(dirname(root)));
  });
});

describe('条件 6：没有可撤销的那一条', () => {
  it('这个文件夹的授权早先已经撤销：照样解除，没有新撤销的', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    h.permissions.revoke(grantId);

    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('none');
    expect(preview.sourcesUnderGrant).toBe(0);
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBeNull();
    expect(h.projects.get(project.id)!.root_path).toBeNull();
  });

  it('只有上级文件夹的授权：照样解除，上级那一条不动', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    h.permissions.revoke(grantId);
    const parent = h.permissions.grantFolder(dirname(root));

    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('none');
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBeNull();
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    expect(h.permissions.get(parent.id)!.status).toBe('active');
  });

  it('自己的和上级的授权都在：只撤销自己的那一条', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    const parent = h.permissions.grantFolder(dirname(root));
    // 上级那条授权下也有资料：不算在「这条授权下的资料」里
    sourceUnder(h, parent.id, project.id);

    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('revoke');
    expect(preview.sourcesUnderGrant).toBe(0);
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(done.revokedPermissionId).toBe(grantId);
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    expect(h.permissions.get(parent.id)!.status).toBe('active');
  });
});

describe('条件 7：预览', () => {
  it('不改任何东西；要取消的、等接受的、资料数、授权怎么处理都对', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    sourceUnder(h, grantId, project.id);
    sourceUnder(h, grantId, project.id);
    // 这条授权下、没归到这个项目的资料也算
    sourceUnder(h, grantId, null);
    draft(h, project.id, '草案不算');
    await runToEnd(h, project.id, '做完等接受');
    const running = await chatDraft(h, project.id, `${HOLD} 执行到一半`);
    const queued = await chatDraft(h, project.id, '排在后面的');
    await h.runtime.acceptTodo(running.todoId);
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('running'), {
      timeout: 60_000,
    });
    await h.runtime.acceptTodo(queued.todoId);
    const before = snapshot();

    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview).toEqual({
      rootPath: h.projects.get(project.id)!.root_path,
      inFlightTasks: 2,
      pendingAcceptTasks: 1,
      sourcesUnderGrant: 3,
      grant: 'revoke',
    });
    expect(canon(preview.rootPath)).toBe(canon(root));
    expect(await h.runtime.previewUnbindProjectFolder(project.id)).toEqual(preview);
    expect(snapshot()).toEqual(before);
    expect(taskRow(running.taskId).status).toBe('running');
    expect(taskRow(queued.taskId).status).toBe('queued');
    expect(reports(running.conversationId)).toEqual([]);
  });
});

describe('条件 8：拒绝', () => {
  it('项目不存在、项目没绑文件夹：两个接口都拒绝，什么都不变', async () => {
    const h = setup();
    await bound(h, '绑着的');
    const bare = h.projects.create({ name: '没绑的', rootPath: null, description: null });
    const before = snapshot();

    await expect(h.runtime.previewUnbindProjectFolder('no-such-project')).rejects.toThrow(/不存在/);
    await expect(h.runtime.unbindProjectFolder('no-such-project')).rejects.toThrow(/不存在/);
    await expect(h.runtime.previewUnbindProjectFolder(bare.id)).rejects.toThrow(NO_FOLDER);
    await expect(h.runtime.unbindProjectFolder(bare.id)).rejects.toThrow(NO_FOLDER);
    expect(snapshot()).toEqual(before);
  });
});

describe('条件 9：解除之后重新绑定', () => {
  it('是一条新的有效授权，原来那条还是已撤销；之前等接受的任务这时接受，改动落进项目', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    const waiting = await runToEnd(h, project.id, '做完等接受');
    expect(taskRow(waiting).status).toBe('pending_accept');

    await h.runtime.unbindProjectFolder(project.id);
    expect(taskRow(waiting).status).toBe('pending_accept');

    const again = await h.runtime.bindProjectFolder(project.id, root);
    expect(canon(again.root_path!)).toBe(canon(root));
    const grants = ownGrants(root);
    expect(grants.map((g) => g.status)).toEqual(['revoked', 'active']);
    expect(grants[0]!.id).toBe(grantId);
    expect(grants[1]!.id).not.toBe(grantId);

    const accepted = await h.runtime.acceptCodingTask(waiting);
    expect(accepted.status).toBe('completed');
    expect(accepted.apply_error).toBeNull();
    expect(accepted.applied_ref).toMatch(/^ixaeon\//);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    expect(git('diff', '--name-only', 'main', accepted.applied_ref!)).toBe('note.txt');
    expect(git('show', `${accepted.applied_ref}:note.txt`)).toContain('改过');
  });
});

describe('条件 10：解除绑定让对话上下文失效', () => {
  it('正在用的会话被作废（照 revokeSourceReading 的做法调 invalidateContext）', async () => {
    const h = setup();
    const { project } = await bound(h);
    const invalidate = vi.fn();
    const sessions = (h.runtime as unknown as { askSessions: Map<string, AgentSession> })
      .askSessions;
    sessions.set('合成会话', { invalidateContext: invalidate } as unknown as AgentSession);

    await h.runtime.previewUnbindProjectFolder(project.id);
    expect(invalidate).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
    await h.runtime.unbindProjectFolder(project.id);
    expect(invalidate).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });
});

describe('条件 12：IPC', () => {
  it('registerIpc 注册了两个接口，调它们得到的和运行时上的方法一样；输入只有项目号', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const call = async <T>(name: string, arg: unknown): Promise<T> => {
      const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
      if (!entry) throw new Error(`没有注册 IPC：${name}`);
      return (await entry[1]({} as never, arg)) as T;
    };

    const viaRuntime = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(await call('previewUnbindProjectFolder', project.id)).toEqual(viaRuntime);
    const done = await call<{ revokedPermissionId: string | null; project: Project }>(
      'unbindProjectFolder',
      project.id,
    );
    expect(done.revokedPermissionId).toBe(grantId);
    expect(done.project.root_path).toBeNull();
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    await expect(call('unbindProjectFolder', project.id)).rejects.toThrow(NO_FOLDER);
  });
});
