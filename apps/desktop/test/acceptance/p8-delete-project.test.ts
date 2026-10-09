/**
 * P8 验收（规格 docs/委派/P8-删除项目时撤销授权并清副本.md，条件 1–9、11；界面的条件 10 在
 * p8-delete-page.test.ts）。执行方先推了一版，整合方 2026-10-09 锁定前重写
 * （规格末尾「整合方审测试时的改正与补充」）。
 *
 * 真的运行时方法（AppRuntime 的原型）、真的编排与自动派发；项目文件夹是合成的 git 仓库，
 * 用真的 bindProjectFolder 绑上。执行器是替身：目标以「[卡住]」开头就停在执行中等放行，
 * 以「[失败]」开头就说自己没做成，别的照常改 note.txt。
 *
 * 钉住的接缝：
 * - `AppRuntime.deleteProject(projectId)`，返回恰好六项
 *   `{ sourcesUnassigned, itemsRemoved, revokedPermissionId, cancelledTasks, copiesRemoved, copiesLeft }`；
 * - 绑着文件夹的先照 P5 解除绑定（审计里 `project.folder_unbound` 在 `project.deleted` 前面）；
 * - 审计 `project.deleted` 还是 `{ projectId, sourcesUnassigned, itemsRemoved }`，只记一条；
 * - 清副本只认数据目录 workspaces/ 之内的目录；审计 `project.task_copies_removed`
 *   `{ projectId, removed, left }`。
 *
 * 清副本（条件 7、8、9）单独一个 describe，放在最后：这一样是整合方加的，用户不要的话整块拿掉。
 *
 * 原版里写坏的（改掉了）：查项目还在不在用了 `await expect(projects.get(id)).rejects`，可那是个
 * 同步函数、查不到返回 null；项目删掉之后又去读它的任务行，而任务是跟着项目一起删的。
 * 两处都是实现写对了也过不了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/**
 * 让某个任务的副本目录「删不掉」（条件 9）：删它的时候抛 EBUSY。认的是路径结尾
 * `workspaces/<任务号>`，实现怎么拼路径、用同步的还是异步的删除都拦得住。别的路径照常删。
 */
const fsHooks = vi.hoisted(() => ({ undeletable: new Set<string>() }));
const refuseRemoval = (target: unknown): Error | null => {
  const path = String(target).replaceAll('\\', '/').replace(/\/+$/, '');
  for (const taskId of fsHooks.undeletable) {
    if (path.endsWith(`workspaces/${taskId}`)) {
      return Object.assign(new Error(`EBUSY: resource busy or locked, rm '${path}'`), {
        code: 'EBUSY',
      });
    }
  }
  return null;
};
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const guardedRmSync = ((path, options) => {
    const refused = refuseRemoval(path);
    if (refused) throw refused;
    return actual.rmSync(path, options);
  }) as typeof actual.rmSync;
  const guardedRm = (async (path, options) => {
    const refused = refuseRemoval(path);
    if (refused) throw refused;
    return actual.promises.rm(path, options);
  }) as typeof actual.promises.rm;
  const patched = {
    ...actual,
    rmSync: guardedRmSync,
    promises: { ...actual.promises, rm: guardedRm },
  };
  return { ...patched, default: patched };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  const guardedRm = (async (path, options) => {
    const refused = refuseRemoval(path);
    if (refused) throw refused;
    return actual.rm(path, options);
  }) as typeof actual.rm;
  const patched = { ...actual, rm: guardedRm };
  return { ...patched, default: patched };
});

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

/** 执行器替身认的两个开头：停在执行中等放行；说自己没做成。 */
const HOLD = '[卡住]';
const FAIL = '[失败]';
const WAIT = { timeout: 60_000 };

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};
let releases: Array<() => void> = [];

beforeEach(() => {
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', 'nul'],
    ['GIT_CONFIG_SYSTEM', 'nul'],
    ['IXAEON_CODEX_EXE', 'none'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  fsHooks.undeletable.clear();
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p8-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  releases = [];
});

afterEach(async () => {
  for (const release of releases) release();
  await new Promise((r) => setTimeout(r, 100));
  fsHooks.undeletable.clear();
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

interface Harness {
  runtime: AppRuntime;
  projects: ProjectService;
  permissions: PermissionService;
  conversations: ConversationStore;
  todos: TodoStore;
  sources: SourceStore;
  items: ItemService;
  coding: CodingOrchestrator;
  dataDir: string;
  /** 执行器被调过的任务号（按次序）。 */
  executed: string[];
  /** 卡住的执行器收到取消信号的那一刻：项目还在不在、有效授权有几条。 */
  atCancel: Array<{ projectExists: boolean; activeGrants: number }>;
  releaseExecutor(): void;
}

function setup(): Harness {
  const executed: string[] = [];
  const atCancel: Harness['atCancel'] = [];
  let openExecutor!: () => void;
  const gate = new Promise<void>((r) => {
    openExecutor = r;
  });
  releases.push(openExecutor);
  const executor: CodingExecutor = {
    name: 'scripted',
    async run(task, workspace, signal) {
      executed.push(task.id);
      if (task.goal.startsWith(HOLD)) {
        signal?.addEventListener('abort', () => {
          atCancel.push({
            projectExists:
              db.prepare('SELECT 1 FROM projects WHERE id = ?').get(task.project_id) != null,
            activeGrants: (
              db.prepare("SELECT count(*) AS n FROM permissions WHERE status = 'active'").get() as {
                n: number;
              }
            ).n,
          });
        });
        await gate;
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
      // 任务要是已经被删了、副本也清了，就别再往里写
      if (existsSync(workspace)) {
        writeFileSync(join(workspace, 'note.txt'), `任务 ${task.id.slice(0, 8)} 改过\n`);
      }
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
  const items = new ItemService(db);
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
    dataDir,
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
    getProvider: () => new FakeProvider('p8'),
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
    dataDir,
    executed,
    atCancel,
    releaseExecutor: openExecutor,
  };
}

/** 合成的 git 项目文件夹（一个 note.txt，一次提交）。 */
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

const count = (table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const taskStatus = (id: string): string | undefined =>
  (
    db.prepare('SELECT status FROM coding_tasks WHERE id = ?').get(id) as
      { status: string } | undefined
  )?.status;
const workspaceOf = (id: string): string | null =>
  (
    db.prepare('SELECT workspace_path AS w FROM coding_tasks WHERE id = ?').get(id) as
      { w: string | null } | undefined
  )?.w ?? null;
const audits = (kind: string): Array<Record<string, unknown>> =>
  (
    db
      .prepare('SELECT detail_json FROM audit_events WHERE kind = ? ORDER BY rowid')
      .all(kind) as Array<{
      detail_json: string;
    }>
  ).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);
const auditKinds = (): string[] =>
  (db.prepare('SELECT kind FROM audit_events ORDER BY rowid').all() as Array<{ kind: string }>).map(
    (r) => r.kind,
  );
/** 数据目录 workspaces/ 下现在有哪些副本目录。 */
const copies = (h: Harness): string[] =>
  existsSync(join(h.dataDir, 'workspaces'))
    ? readdirSync(join(h.dataDir, 'workspaces')).sort()
    : [];
/** 库里和删除项目有关的一切：用来证明「什么都没变」。 */
const snapshot = () => ({
  projects: db.prepare('SELECT id, root_path FROM projects ORDER BY id').all(),
  permissions: db.prepare('SELECT id, status FROM permissions ORDER BY id').all(),
  tasks: db.prepare('SELECT id, status FROM coding_tasks ORDER BY id').all(),
  sources: db.prepare('SELECT id, project_id FROM sources ORDER BY id').all(),
  items: count('items'),
  audits: count('audit_events'),
});

const draft = (h: Harness, projectId: string, goal: string) =>
  h.coding.create({ projectId, goal, scope: ['note.txt'], allowedCommands: [] });

/** 任务页那条路：建草案、批准、派发，等它停下（等接受 / 失败）。返回任务号。 */
async function runToEnd(h: Harness, projectId: string, goal: string): Promise<string> {
  const task = draft(h, projectId, goal);
  await h.runtime.approveCodingTask(task.id);
  await h.runtime.finishCodingTask(task.id, 'dispatch');
  return task.id;
}

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
    getEngineSessionId: () => 's-p8',
  } as unknown as AgentSession);
  const answered = await h.runtime.ask({
    conversationId: conv.id,
    projectId,
    question: '把这个做了',
  });
  const todo = h.todos.list({ status: ['proposed'] }).find((t) => t.linked_id === taskId);
  return { taskId, todoId: todo!.id, conversationId: answered.conversationId };
}

/** 往一条授权下放一份资料。返回来源号。 */
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
      segments: [],
      metadata: {},
    },
    { permissionId, projectId, rawPath: `sha256/aa/${'a'.repeat(64)}` },
  ).id;
}
const sourceGrantStatus = (h: Harness, sourceId: string) =>
  h.sources.list({ projectId: null }).find((s) => s.source.id === sourceId)?.permissionStatus;

/** 同一个文件夹的另一种写法（大小写、斜杠方向、结尾斜杠）。 */
const respelled = (root: string): string =>
  process.platform === 'win32' ? `${root.replaceAll('\\', '/').toUpperCase()}/` : `${root}/`;

describe('条件 1：绑着文件夹、有自己那条授权的项目', () => {
  it('项目没了；那条授权撤销了；审计先 folder_unbound 再 deleted；返回的六项如实', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);

    const done = await h.runtime.deleteProject(project.id);

    expect(done).toEqual({
      sourcesUnassigned: 0,
      itemsRemoved: 0,
      revokedPermissionId: grantId,
      cancelledTasks: 0,
      copiesRemoved: 0,
      copiesLeft: 0,
    });
    expect(h.projects.get(project.id)).toBeNull();
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    const kinds = auditKinds();
    expect(kinds.indexOf('project.folder_unbound')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('project.folder_unbound')).toBeLessThan(kinds.indexOf('project.deleted'));
    expect(audits('project.folder_unbound')).toEqual([
      { projectId: project.id, grantId, cancelledTasks: 0 },
    ]);
    expect(audits('project.deleted')).toEqual([
      { projectId: project.id, sourcesUnassigned: 0, itemsRemoved: 0 },
    ]);
    expect(audits('project.task_copies_removed')).toEqual([]);
  });
});

describe('条件 2：这条授权下导入过的资料、项目的理解', () => {
  it('资料变成未归属、授权状态是已撤销、一份不少；两个数和原来算法一样；个人条目不动', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const first = sourceUnder(h, grantId, project.id);
    const second = sourceUnder(h, grantId, project.id);
    // 别的授权下、也归在这个项目的资料：变成未归属，但授权不受影响
    const elsewhere = sourceUnder(h, h.permissions.grantFolder(gitFolder('别处')).id, project.id);
    h.items.createManual({
      projectId: project.id,
      type: 'decision',
      statement: '属于项目的理解',
      rationale: null,
    });
    const personal = h.items.createManual({
      projectId: null,
      type: 'decision',
      statement: '个人条目',
      rationale: null,
    });

    const done = await h.runtime.deleteProject(project.id);

    expect(done.sourcesUnassigned).toBe(3);
    expect(done.itemsRemoved).toBe(1);
    expect(count('sources')).toBe(3);
    for (const id of [first, second, elsewhere]) expect(h.sources.get(id)!.project_id).toBeNull();
    expect(sourceGrantStatus(h, first)).toBe('revoked');
    expect(sourceGrantStatus(h, second)).toBe('revoked');
    expect(sourceGrantStatus(h, elsewhere)).toBe('active');
    expect(count('items')).toBe(1);
    expect(h.items.get(personal.id).statement).toBe('个人条目');
    expect(audits('project.deleted')).toEqual([
      { projectId: project.id, sourcesUnassigned: 3, itemsRemoved: 1 },
    ]);
  });
});

describe('条件 3：授权不撤销的两种情况', () => {
  it('别的项目也绑着同一个文件夹（路径写法不同也算）：项目删了，授权仍然有效', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h, '要删的');
    const other = h.projects.create({ name: '也绑着的', rootPath: null, description: null });
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(respelled(root), other.id);

    const done = await h.runtime.deleteProject(project.id);

    expect(done.revokedPermissionId).toBeNull();
    expect(h.projects.get(project.id)).toBeNull();
    expect(h.projects.get(other.id)!.root_path).toBe(respelled(root));
    expect(h.permissions.get(grantId)!.status).toBe('active');
  });

  it('只有上级文件夹的授权：上级那条不动', async () => {
    const h = setup();
    const { project, root, grantId } = await bound(h);
    h.permissions.revoke(grantId);
    const parent = h.permissions.grantFolder(dirname(root));

    const done = await h.runtime.deleteProject(project.id);

    expect(done.revokedPermissionId).toBeNull();
    expect(h.projects.get(project.id)).toBeNull();
    expect(h.permissions.get(parent.id)!.status).toBe('active');
  });
});

describe('条件 4：没绑文件夹的项目', () => {
  it('照原来那样删掉；不撤销什么、不取消什么；审计里没有 folder_unbound', async () => {
    const h = setup();
    const kept = await bound(h, '别的项目');
    const bare = h.projects.create({ name: '没绑的', rootPath: null, description: null });
    h.items.createManual({
      projectId: bare.id,
      type: 'decision',
      statement: '属于项目的理解',
      rationale: null,
    });

    const invalidate = vi.fn();
    (h.runtime as unknown as { askSessions: Map<string, unknown> }).askSessions.set('合成会话', {
      invalidateContext: invalidate,
    });

    const done = await h.runtime.deleteProject(bare.id);

    expect(invalidate).toHaveBeenCalled();
    expect(done).toEqual({
      sourcesUnassigned: 0,
      itemsRemoved: 1,
      revokedPermissionId: null,
      cancelledTasks: 0,
      copiesRemoved: 0,
      copiesLeft: 0,
    });
    expect(h.projects.get(bare.id)).toBeNull();
    expect(audits('project.folder_unbound')).toEqual([]);
    expect(audits('project.deleted')).toEqual([
      { projectId: bare.id, sourcesUnassigned: 0, itemsRemoved: 1 },
    ]);
    // 别的项目和它的授权不受影响
    expect(h.projects.get(kept.project.id)!.root_path).toBe(kept.project.root_path);
    expect(h.permissions.get(kept.grantId)!.status).toBe('active');
  });

  it('没绑文件夹、却还有排着队的任务（老数据）：照样先取消并回报', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const queued = await chatDraft(h, project.id, '排着的');
    await h.runtime.approveCodingTask(queued.taskId);
    expect(taskStatus(queued.taskId)).toBe('queued');
    // P5 的解除绑定会先取消排队的任务，所以这个状态只有老数据里有：直接把路径清掉造出来
    db.prepare('UPDATE projects SET root_path = NULL WHERE id = ?').run(project.id);

    const done = await h.runtime.deleteProject(project.id);

    expect(done.cancelledTasks).toBe(1);
    expect(done.revokedPermissionId).toBeNull();
    expect(h.permissions.get(grantId)!.status).toBe('active');
    expect(reports(queued.conversationId).map((r) => r.meta['status'])).toEqual(['cancelled']);
    expect(h.executed).toEqual([]);
    expect(audits('project.folder_unbound')).toEqual([]);
  });
});

describe('条件 5：删除时有排队、执行中的任务', () => {
  it('先取消（那一刻项目还在、授权还有效）并回报；之后放行执行器不出错，编排器接着派得出别的任务', async () => {
    const h = setup();
    const { project, grantId } = await bound(h, '要删的');
    const other = await bound(h, '别的项目');
    const running = await chatDraft(h, project.id, `${HOLD} 执行到一半`);
    await h.runtime.acceptTodo(running.todoId);
    await vi.waitFor(() => expect(taskStatus(running.taskId)).toBe('running'), WAIT);
    await vi.waitFor(() => expect(h.executed).toContain(running.taskId), WAIT);
    const queued = await chatDraft(h, project.id, '排在后面的');
    await h.runtime.acceptTodo(queued.todoId);
    expect(taskStatus(queued.taskId)).toBe('queued');

    const done = await h.runtime.deleteProject(project.id);

    expect(done.cancelledTasks).toBe(2);
    expect(done.revokedPermissionId).toBe(grantId);
    // 取消在先：执行器收到取消信号的那一刻，项目还在，两条授权（要删的、别的项目的）都还有效
    expect(h.atCancel).toEqual([{ projectExists: true, activeGrants: 2 }]);
    for (const conversationId of [running.conversationId, queued.conversationId]) {
      const written = reports(conversationId);
      expect(written).toHaveLength(1);
      expect(written[0]!.content).toContain('取消了');
      expect(written[0]!.meta['status']).toBe('cancelled');
    }
    expect(audits('project.folder_unbound')).toEqual([
      { projectId: project.id, grantId, cancelledTasks: 2 },
    ]);
    // 任务跟着项目删了
    expect(taskStatus(running.taskId)).toBeUndefined();
    expect(taskStatus(queued.taskId)).toBeUndefined();
    expect(h.projects.get(project.id)).toBeNull();

    // 放行那个执行器：晚到的结果落在一个已经不在的任务上，不能留下未处理的错误，也不能一直占着
    h.releaseExecutor();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.coding.store.runningCount()).toBe(0);
    expect(h.executed).toEqual([running.taskId]);
    const next = await runToEnd(h, other.project.id, '别的项目照常做');
    expect(taskStatus(next)).toBe('pending_accept');
  });
});

describe('条件 6：拒绝；上下文失效', () => {
  it('项目不存在：拒绝，什么都不变；删除成功让正在用的对话上下文失效', async () => {
    const h = setup();
    const { project } = await bound(h);
    sourceUnder(h, h.permissions.activePermissionForPath(project.root_path!)!.id, project.id);
    const invalidate = vi.fn();
    const sessions = (h.runtime as unknown as { askSessions: Map<string, unknown> }).askSessions;
    sessions.set('合成会话', { invalidateContext: invalidate });
    const before = snapshot();

    await expect(h.runtime.deleteProject('no-such-project')).rejects.toThrow(/不存在/);
    expect(snapshot()).toEqual(before);
    expect(invalidate).not.toHaveBeenCalled();

    await h.runtime.deleteProject(project.id);
    expect(invalidate).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });
});

describe('条件 11：IPC', () => {
  it('registerIpc 注册的 deleteProject 调的是运行时上的方法，返回的和它一样；审计只记一条 deleted', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const spy = vi.spyOn(h.runtime, 'deleteProject');
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'ixaeon:deleteProject');
    if (!entry) throw new Error('没有注册 IPC：deleteProject');

    const viaIpc = await entry[1]({} as never, project.id);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(project.id);
    expect(viaIpc).toEqual({
      sourcesUnassigned: 0,
      itemsRemoved: 0,
      revokedPermissionId: grantId,
      cancelledTasks: 0,
      copiesRemoved: 0,
      copiesLeft: 0,
    });
    expect(h.projects.get(project.id)).toBeNull();
    expect(audits('project.deleted')).toHaveLength(1);
    await expect(entry[1]({} as never, project.id)).rejects.toThrow(/不存在/);
  });
});

/* ---- 清副本（条件 7、8、9）：整合方加的那一样。用户不要的话，这个 describe 整块拿掉 ---- */
describe('清副本（条件 7、8、9）', () => {
  it('条件 7：这个项目每个有副本的任务，副本目录都删掉、计数对、记一条审计；没有副本的项目不记', async () => {
    const h = setup();
    const { project } = await bound(h);
    draft(h, project.id, '一直是草案（没有副本）');
    const pending = await runToEnd(h, project.id, '做完等接受');
    const completed = await runToEnd(h, project.id, '做完也接受了');
    await h.runtime.acceptCodingTask(completed);
    const failed = await runToEnd(h, project.id, `${FAIL} 执行器说没做成`);
    const cancelled = draft(h, project.id, '批准后自己取消的').id;
    await h.runtime.approveCodingTask(cancelled);
    await h.runtime.finishCodingTask(cancelled, 'cancel');
    const queued = draft(h, project.id, '批准了排着的').id;
    await h.runtime.approveCodingTask(queued);
    const withCopies = [pending, completed, failed, cancelled, queued].sort();
    expect(copies(h)).toEqual(withCopies);
    // 再加一个：库里记着副本、目录却早就不在了的任务——不计数
    const gone = draft(h, project.id, '副本目录早就没了的').id;
    h.coding.store.prepareWorkspace(gone, h.dataDir);
    rmSync(workspaceOf(gone)!, { recursive: true, force: true });
    expect(copies(h)).toEqual(withCopies);

    const done = await h.runtime.deleteProject(project.id);

    expect(done.copiesRemoved).toBe(5);
    expect(done.copiesLeft).toBe(0);
    expect(done.cancelledTasks).toBe(1);
    expect(copies(h)).toEqual([]);
    expect(audits('project.task_copies_removed')).toEqual([
      { projectId: project.id, removed: 5, left: 0 },
    ]);
    expect(count('coding_tasks')).toBe(0);

    // 没有任何副本的项目：两个数都是 0，不记这条审计
    const bare = h.projects.create({ name: '没有副本的', rootPath: null, description: null });
    draft(h, bare.id, '只有草案');
    const again = await h.runtime.deleteProject(bare.id);
    expect(again.copiesRemoved).toBe(0);
    expect(again.copiesLeft).toBe(0);
    expect(audits('project.task_copies_removed')).toHaveLength(1);
  });

  it('条件 8：边界——别的项目的副本、项目文件夹本身、workspaces 之外的路径，一个字节都不碰', async () => {
    const h = setup();
    const { project, root } = await bound(h, '要删的');
    const other = await bound(h, '留着的');
    writeFileSync(join(root, 'extra.md'), '项目文件夹里的另一个文件\n');
    const mine = draft(h, project.id, '我的任务').id;
    await h.runtime.approveCodingTask(mine);
    const theirs = draft(h, other.project.id, '别的项目的任务').id;
    await h.runtime.approveCodingTask(theirs);
    // 三条记歪了的 workspace_path：指到项目文件夹本身、指到 workspaces 根、从 workspaces 里绕出去
    const outside = join(h.dataDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), '数据目录里别的东西\n');
    const strays = [
      root,
      join(h.dataDir, 'workspaces'),
      join(h.dataDir, 'workspaces', '..', 'outside'),
    ].map((path) => {
      const id = draft(h, project.id, '记歪了的任务').id;
      db.prepare('UPDATE coding_tasks SET workspace_path = ? WHERE id = ?').run(path, id);
      return id;
    });
    expect(strays).toHaveLength(3);
    const theirCopy = workspaceOf(theirs)!;

    const done = await h.runtime.deleteProject(project.id);

    expect(done.copiesRemoved).toBe(1);
    expect(done.copiesLeft).toBe(0);
    expect(audits('project.task_copies_removed')).toEqual([
      { projectId: project.id, removed: 1, left: 0 },
    ]);
    // 别的项目的副本原样还在
    expect(copies(h)).toEqual([theirs]);
    expect(readFileSync(join(theirCopy, 'note.txt'), 'utf8')).toContain('合成文件');
    // 项目文件夹原样还在，里面的文件一个没少
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('合成文件\n');
    expect(readFileSync(join(root, 'extra.md'), 'utf8')).toBe('项目文件夹里的另一个文件\n');
    expect(existsSync(join(root, '.git'))).toBe(true);
    // 数据目录里 workspaces 之外的东西原样还在
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('数据目录里别的东西\n');
    expect(existsSync(join(h.dataDir, '..', 'ixaeon.db'))).toBe(true);
  });

  it('条件 9：有一个副本目录删不掉：项目照样删了，copiesLeft 是 1，别的副本照删', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const first = draft(h, project.id, '删得掉的').id;
    await h.runtime.approveCodingTask(first);
    const stuck = draft(h, project.id, '删不掉的').id;
    await h.runtime.approveCodingTask(stuck);
    const last = draft(h, project.id, '也删得掉的').id;
    await h.runtime.approveCodingTask(last);
    fsHooks.undeletable.add(stuck);

    const done = await h.runtime.deleteProject(project.id);

    expect(done.copiesRemoved).toBe(2);
    expect(done.copiesLeft).toBe(1);
    expect(done.revokedPermissionId).toBe(grantId);
    expect(h.projects.get(project.id)).toBeNull();
    expect(copies(h)).toEqual([stuck]);
    expect(audits('project.task_copies_removed')).toEqual([
      { projectId: project.id, removed: 2, left: 1 },
    ]);
    expect(audits('project.deleted')).toHaveLength(1);
  });
});
