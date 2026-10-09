/**
 * P8 验收（规格 docs/委派/P8-删除项目时撤销授权并清副本.md，条件 1–6、11 与清副本条件 7–9；
 * 界面条件 10 在 p8-delete-page.test.ts）。B 档：先只交测试，整合方锁定后再写实现。
 *
 * 钉住的接缝：`AppRuntime.deleteProject(projectId)` 返回
 * { sourcesUnassigned, itemsRemoved, revokedPermissionId, cancelledTasks, copiesRemoved, copiesLeft }；
 * 次序照契约 3：先照 P5 的 unbindProjectFolder（没绑的也取消在途任务并回报），再删项目，
 * 只删数据目录 workspaces/ 之内的副本，删不掉的算 copiesLeft；有副本要清时记审计
 * project.task_copies_removed { projectId, removed, left }；最后 invalidateContext。
 *
 * 清副本（条件 7、8、9）单独放在一个 describe：这是整合方加的第三样，用户还没最后点头，可能拿掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const HOLD = '[卡住]';
const WAIT = { timeout: 60_000 };

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};
let releases: Array<() => void> = [];

beforeEach(() => {
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'nul';
  }
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p8-'));
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
  executed: string[];
  atCancel: Array<{ projectExists: number; activeGrants: number }>;
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
  const executor = {
    name: 'scripted',
    async run(
      task: { id: string; goal: string; project_id: string },
      workspace: string,
      signal?: AbortSignal,
    ) {
      executed.push(task.id);
      if (task.goal.startsWith(HOLD)) {
        signal?.addEventListener('abort', () => {
          atCancel.push({
            projectExists: (
              db
                .prepare('SELECT count(*) AS n FROM projects WHERE id = ?')
                .get(task.project_id) as {
                n: number;
              }
            ).n,
            activeGrants: (
              db.prepare("SELECT count(*) AS n FROM permissions WHERE status = 'active'").get() as {
                n: number;
              }
            ).n,
          });
        });
        await gate;
      }
      if (task.goal.startsWith('[失败]')) {
        return {
          claimedSuccess: false,
          summary: '合成的失败',
          changedPaths: [],
          testsModified: false,
          raw: '',
        };
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
  const sources = new SourceStore(db);
  const items = new ItemService(db);
  const coding = new CodingOrchestrator(
    db,
    executor as unknown as never,
    dataDir,
    runCheck as never,
  );
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

async function bound(
  h: Harness,
  name = '合成项目',
): Promise<{ project: Project; root: string; grantId: string }> {
  const created = h.projects.create({ name, rootPath: null, description: null });
  const root = gitFolder(`repo-${name}`);
  const project = await h.runtime.bindProjectFolder(created.id, root);
  return { project, root, grantId: h.permissions.activePermissionForPath(root)!.id };
}

const taskRow = (id: string) =>
  db.prepare('SELECT status, workspace_path FROM coding_tasks WHERE id = ?').get(id) as {
    status: string;
    workspace_path: string | null;
  };
const audits = (kind: string): Array<Record<string, unknown>> =>
  (
    db.prepare('SELECT detail_json FROM audit_events WHERE kind = ? ORDER BY rowid').all(kind) as {
      detail_json: string;
    }[]
  ).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);
const kinds = (): string[] =>
  (db.prepare('SELECT kind FROM audit_events ORDER BY rowid').all() as Array<{ kind: string }>).map(
    (r) => r.kind,
  );

const draft = (h: Harness, projectId: string, goal: string) =>
  h.coding.create({ projectId, goal, scope: ['note.txt'], allowedCommands: [] });

const reports = (conversationId: string) =>
  (
    db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ content: string; meta_json: string }>
  )
    .map((m) => ({ content: m.content, meta: JSON.parse(m.meta_json) as Record<string, unknown> }))
    .filter((m) => m.meta['kind'] === 'task_report');

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
  await h.runtime.ask({ conversationId: conv.id, projectId, question: '把这个做了' });
  const todo = h.todos.list({ status: ['proposed'] }).find((t) => t.linked_id === taskId);
  return { taskId, todoId: todo!.id, conversationId: conv.id };
}

function sourceUnder(h: Harness, permissionId: string, projectId: string | null): string {
  return h.sources.insertParsed(
    {
      kind: 'project_snapshot',
      provider: 'project',
      accountNamespace: 'local',
      externalId: String(Math.random()).slice(2),
      title: '合成资料',
      contentHash: 'a'.repeat(64),
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

describe('条件 1：绑着文件夹、有自己授权', () => {
  it('删除：项目没了、授权 revoked、audit 先 folder_unbound 后 deleted、返回对', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    const out = await h.runtime.deleteProject(project.id);
    expect(out.revokedPermissionId).toBe(grantId);
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    await expect(h.projects.get(project.id)).rejects.toThrow(/不存在/);
    const list = kinds();
    expect(list).toContain('project.folder_unbound');
    expect(list).toContain('project.deleted');
    expect(list.indexOf('project.folder_unbound')).toBeLessThan(list.indexOf('project.deleted'));
    expect(audits('project.folder_unbound')).toEqual([
      { projectId: project.id, grantId, cancelledTasks: 0 },
    ]);
    expect(audits('project.deleted')).toEqual([
      { projectId: project.id, sourcesUnassigned: 0, itemsRemoved: 0 },
    ]);
  });
});

describe('条件 2：这条授权下的资料', () => {
  it('变成未归属、授权状态已撤销、一份不少；itemsRemoved 照原算法；无主条目不动', async () => {
    const h = setup();
    const { project, grantId } = await bound(h);
    sourceUnder(h, grantId, project.id);
    sourceUnder(h, grantId, project.id);
    h.items.createManual({
      projectId: project.id,
      type: 'decision',
      statement: '属于项目的理解',
      rationale: null,
    });
    h.items.createManual({ projectId: null, type: 'note', statement: '无主条目', rationale: null });
    const out = await h.runtime.deleteProject(project.id);
    expect(out.sourcesUnassigned).toBe(2);
    expect(out.itemsRemoved).toBe(1);
    const rows = db.prepare('SELECT project_id FROM sources').all() as Array<{
      project_id: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.project_id === null)).toBe(true);
    expect(h.sources.list({ projectId: null }).every((s) => s.permissionStatus === 'revoked')).toBe(
      true,
    );
    expect(db.prepare('SELECT count(*) AS n FROM items WHERE project_id IS NULL').get()).toEqual({
      n: 1,
    });
  });
});

describe('条件 3：授权不撤销的两种情况', () => {
  it('别的项目也绑着同一个文件夹（路径写法不同也算）：授权还有效、revokedPermissionId null', async () => {
    const h = setup();
    const a = await bound(h, '甲');
    const b = await bound(h, '乙');
    // 让甲和乙绑同一个文件夹（P4 的绑定不许，这里直接落库造，老数据才有的样子）
    const variant = process.platform === 'win32' ? b.root.toUpperCase() : b.root;
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(variant, a.project.id);
    const out = await h.runtime.deleteProject(a.project.id);
    expect(out.revokedPermissionId).toBeNull();
    expect(h.permissions.get(b.grantId)!.status).toBe('active');
  });

  it('只有上级文件夹的授权：上级那条不动，revokedPermissionId null', async () => {
    const h = setup();
    const a = await bound(h, '甲');
    h.permissions.revoke(a.grantId);
    const parentGrant = h.permissions.grantFolder(join(a.root, '..'));
    const out = await h.runtime.deleteProject(a.project.id);
    expect(out.revokedPermissionId).toBeNull();
    expect(h.permissions.get(parentGrant.id)!.status).toBe('active');
  });
});

describe('条件 4：没绑文件夹的项目', () => {
  it('照原来删掉；revokedPermissionId null、cancelledTasks 0；没有 folder_unbound 审计', async () => {
    const h = setup();
    const bare = h.projects.create({ name: '没绑的', rootPath: null, description: null });
    const out = await h.runtime.deleteProject(bare.id);
    expect(out.revokedPermissionId).toBeNull();
    expect(out.cancelledTasks).toBe(0);
    await expect(h.projects.get(bare.id)).rejects.toThrow(/不存在/);
    expect(audits('project.folder_unbound')).toEqual([]);
  });
});

describe('条件 5：删除时在途的任务先取消', () => {
  it('执行中的先收取消信号（那一刻项目还在、授权有效），对话里「取消了」，放行后编排器不占着', async () => {
    const h = setup();
    const { project } = await bound(h);
    const running = await chatDraft(h, project.id, `${HOLD} 执行到一半`);
    await h.runtime.acceptTodo(running.todoId);
    await vi.waitFor(() => expect(taskRow(running.taskId).status).toBe('running'), WAIT);
    await vi.waitFor(() => expect(h.executed).toContain(running.taskId), WAIT);
    const queued = await chatDraft(h, project.id, '排在后面的');
    await h.runtime.approveCodingTask(queued.taskId);
    expect(taskRow(queued.taskId).status).toBe('queued');

    const out = await h.runtime.deleteProject(project.id);
    expect(out.cancelledTasks).toBe(2);
    expect(h.atCancel).toEqual([{ projectExists: 1, activeGrants: 1 }]);
    expect(taskRow(running.taskId).status).toBe('cancelled');
    expect(taskRow(queued.taskId).status).toBe('cancelled');
    for (const cid of [running.conversationId, queued.conversationId]) {
      const rs = reports(cid);
      expect(rs.some((r) => r.meta['status'] === 'cancelled' && r.content.includes('取消了'))).toBe(
        true,
      );
    }
    h.releaseExecutor();
    await vi.waitFor(() => expect(h.coding.store.runningCount()).toBe(0), WAIT);
    const y = await bound(h, '别的项目');
    const yt = draft(h, y.project.id, '照常');
    await h.runtime.approveCodingTask(yt.id);
    await h.runtime.finishCodingTask(yt.id, 'dispatch');
    await vi.waitFor(() => expect(taskRow(yt.id).status).toBe('pending_accept'), WAIT);
  });
});

describe('条件 6：拒绝与上下文失效', () => {
  it('项目不存在：拒绝，什么都不变；删除让对话上下文失效', async () => {
    const h = setup();
    const invalidate = vi.fn();
    (h.runtime as unknown as { askSessions: Map<string, unknown> }).askSessions.set('会话', {
      invalidateContext: invalidate,
    });
    const before = db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number };
    await expect(h.runtime.deleteProject('no-such')).rejects.toThrow(/不存在/);
    expect((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n).toBe(
      before.n,
    );
    expect(invalidate).not.toHaveBeenCalled();
    const b = await bound(h);
    await h.runtime.deleteProject(b.project.id);
    expect(invalidate).toHaveBeenCalled();
  });
});

describe('条件 11：IPC', () => {
  it('registerIpc 注册的 deleteProject 就是 AppRuntime.deleteProject，返回一样', async () => {
    const h = setup();
    const { project } = await bound(h);
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const spy = vi.spyOn(h.runtime, 'deleteProject');
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([ch]) => ch === 'ixaeon:deleteProject');
    if (!entry) throw new Error('没有注册 IPC：deleteProject');
    const viaIpc = await entry[1]({} as never, project.id);
    expect(spy).toHaveBeenCalledWith(project.id);
    await expect(h.projects.get(project.id)).rejects.toThrow(/不存在/);
    expect(viaIpc).toMatchObject({
      sourcesUnassigned: expect.any(Number),
      itemsRemoved: expect.any(Number),
      revokedPermissionId: expect.any(String),
      cancelledTasks: expect.any(Number),
      copiesRemoved: expect.any(Number),
      copiesLeft: expect.any(Number),
    });
  });
});

/* ---- 清副本（条件 7、8、9）：整合方加的第三样，用户还没最后点头，可能拿掉 ---- */
describe('清副本（条件 7、8、9）', () => {
  it('条件 7：每个有副本的任务目录都删掉、计数对；有副本时记 task_copies_removed；没有副本不记、两数都是 0', async () => {
    const h = setup();
    const { project } = await bound(h);
    const done = draft(h, project.id, '做完等接受的');
    await h.runtime.approveCodingTask(done.id);
    await h.runtime.finishCodingTask(done.id, 'dispatch');
    await vi.waitFor(() => expect(taskRow(done.id).status).toBe('pending_accept'), WAIT);
    const failed = draft(h, project.id, '[失败] 没做成的');
    await h.runtime.approveCodingTask(failed.id);
    await h.runtime.finishCodingTask(failed.id, 'dispatch');
    await vi.waitFor(() => expect(taskRow(failed.id).status).toBe('failed'), WAIT);
    for (const id of [done.id, failed.id]) {
      expect(taskRow(id).workspace_path).not.toBeNull();
      expect(existsSync(join(h.dataDir, 'workspaces', id))).toBe(true);
    }

    const out = await h.runtime.deleteProject(project.id);
    expect(out.copiesRemoved).toBe(2);
    expect(out.copiesLeft).toBe(0);
    for (const id of [done.id, failed.id]) {
      expect(existsSync(join(h.dataDir, 'workspaces', id))).toBe(false);
    }
    expect(audits('project.task_copies_removed')).toEqual([
      { projectId: project.id, removed: 2, left: 0 },
    ]);

    const bare = h.projects.create({ name: '裸的', rootPath: null, description: null });
    const out2 = await h.runtime.deleteProject(bare.id);
    expect(out2.copiesRemoved).toBe(0);
    expect(out2.copiesLeft).toBe(0);
    expect(audits('project.task_copies_removed')).toHaveLength(1);
  });

  it('条件 8：边界——别的项目的副本原样、项目文件夹原样；workspaces 之外的路径不删也不计数', async () => {
    const h = setup();
    const { project, root } = await bound(h, '要删的');
    const other = await bound(h, '留着的');
    const mine = draft(h, project.id, '我的任务');
    await h.runtime.approveCodingTask(mine.id);
    const theirs = draft(h, other.project.id, '他们的任务');
    await h.runtime.approveCodingTask(theirs.id);
    const stray = draft(h, project.id, '跑偏的任务');
    await h.runtime.approveCodingTask(stray.id);
    db.prepare('UPDATE coding_tasks SET workspace_path = ? WHERE id = ?').run(root, stray.id);
    writeFileSync(join(root, 'extra.md'), '项目文件夹里的文件\n');

    const out = await h.runtime.deleteProject(project.id);
    expect(out.copiesRemoved).toBe(1);
    expect(out.copiesLeft).toBe(0);
    expect(existsSync(join(h.dataDir, 'workspaces', theirs.id))).toBe(true);
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toContain('合成文件');
    expect(readFileSync(join(root, 'extra.md'), 'utf8')).toContain('项目文件夹里的文件');
  });

  it('条件 9：一个副本删不掉（文件被占用）：项目照样删、copiesLeft 1、别的照删', async () => {
    const h = setup();
    const { project } = await bound(h);
    const a = draft(h, project.id, '删得掉的');
    await h.runtime.approveCodingTask(a.id);
    const b = draft(h, project.id, '删不掉的');
    await h.runtime.approveCodingTask(b.id);
    const wsB = join(h.dataDir, 'workspaces', b.id);
    const locked = openSync(join(wsB, 'locked.txt'), 'w');
    try {
      const out = await h.runtime.deleteProject(project.id);
      expect(out.copiesRemoved).toBe(1);
      expect(out.copiesLeft).toBe(1);
      await expect(h.projects.get(project.id)).rejects.toThrow(/不存在/);
      expect(audits('project.task_copies_removed')).toEqual([
        { projectId: project.id, removed: 1, left: 1 },
      ]);
    } finally {
      try {
        closeSync(locked);
      } catch {
        /* noop */
      }
      try {
        rmSync(wsB, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });
});
