/**
 * P5 验收（规格 docs/委派/P5-解除项目的文件夹绑定.md）。B 档：先只推测试，实现还没有，现在应失败。
 *
 * 钉住的接缝（规格写死）：
 * - `AppRuntime.previewUnbindProjectFolder(projectId)`、`AppRuntime.unbindProjectFolder(projectId)`。
 *   输入只有项目 id。IPC 只转一下，条件 12 另测 `registerIpc`。
 * - 解除次序：先取消排队/执行中/验证中的任务（`coding.cancel` + `codingDispatch.onTaskSettled`），
 *   再清空 `root_path`，再按契约 3 撤销那一条授权，再记审计 `project.folder_unbound`，
 *   再 `invalidateContext()`。
 * - 拒绝文案逐字：「这个项目没有绑定文件夹」。项目不存在沿用现有的「项目不存在」。
 * - 解除之后派不了编码任务，报 P4 那句（见 UNBOUND_MESSAGE）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '@ixaeon/core';
import type { CodingTask, Project } from '@ixaeon/contracts';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { UNBOUND_MESSAGE } from './p4-project-folder.test.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

const NO_FOLDER = '这个项目没有绑定文件夹';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p5-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function folder(label: string): string {
  const f = join(dir, label);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, 'note.txt'), '合成文件');
  return f;
}

function setup() {
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const coding = new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data'));
  const settled: string[] = [];
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const invalidated: number[] = [];
  Object.assign(runtime, {
    db,
    projects,
    permissions,
    conversations,
    todos,
    coding,
    items: new ItemService(db),
    search: new SearchService(db),
    codingDispatchRef: { onTaskSettled: (id: string) => settled.push(id), kick: () => undefined },
    invalidateContext: () => invalidated.push(1),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    getProvider: () => ({ chat: vi.fn(async () => ({})), chatStructured: vi.fn(async () => ({})) }),
    hermesFound: () => false,
    logger: { warn: () => undefined, info: () => undefined },
  });
  return { runtime, projects, permissions, conversations, coding, settled, invalidated };
}

type H = ReturnType<typeof setup>;

/** 开一轮正在回答的提问，好让对话里的「要做」认得出当前项目。 */
function startAsk(runtime: AppRuntime, conversationId: string, projectId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  runtime['askSessions'].set(conversationId, {
    run: async () => {
      await gate;
      return {
        answer: '好。',
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
  } as unknown as AgentSession);
  const done = runtime
    .ask({ conversationId, projectId, question: '加个文件' })
    .catch(() => undefined);
  return {
    finish: async () => {
      release();
      await done;
    },
  };
}

async function waitActive(runtime: AppRuntime, n: number): Promise<void> {
  const map = runtime['activeAskRuns'] as Map<string, string>;
  for (let i = 0; i < 300 && map.size < n; i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(map.size).toBe(n);
}

function audits(action: string): Array<Record<string, unknown>> {
  return (
    db.prepare('SELECT detail_json FROM audit_events WHERE kind = ?').all(action) as Array<{
      detail_json: string;
    }>
  ).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);
}

function snapshot() {
  return {
    projects: db.prepare('SELECT id, root_path FROM projects ORDER BY id').all(),
    permissions: db.prepare('SELECT id, status, locator FROM permissions ORDER BY id').all(),
    tasks: db.prepare('SELECT id, status FROM coding_tasks ORDER BY id').all(),
    audits: db.prepare('SELECT kind FROM audit_events ORDER BY id').all(),
  };
}

function makeTask(h: H, projectId: string, status: CodingTask['status']): CodingTask {
  const task = h.coding.create({
    projectId,
    goal: `合成任务 ${status}`,
    scope: ['note.txt'],
    allowedCommands: [],
  });
  if (status === 'draft') return task;
  if (status === 'waiting_approval')
    return h.coding.store.prepareWorkspace(task.id, join(dir, 'data'));
  const queued = h.coding.approveAndQueue(task.id);
  if (status === 'queued') return queued;
  return h.coding.store.setStatus(task.id, status);
}

function addSource(permissionId: string, projectId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sources (id, kind, provider, account_namespace, external_id, title, content_hash, raw_path,
      captured_at, imported_at, permission_id, project_id, metadata_json, content_revision)
     VALUES (?, 'document', 'local_file', 'local', ?, '合成资料', ?, ?, ?, ?, ?, ?, '{}', 1)`,
  ).run(id, id, id, join(dir, 'note.txt'), now, now, permissionId, projectId);
  return id;
}

function addItem(projectId: string, sourceId: string): void {
  const itemId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
      origin, observed_at, created_at, updated_at, needs_review)
     VALUES (?, ?, 'project', 'decision', '合成条目', NULL, 'current', 1.0, 'user', ?, ?, ?, 0)`,
  ).run(itemId, projectId, now, now, now);
  db.prepare('UPDATE items SET extracted_from_source_id = ? WHERE id = ?').run(sourceId, itemId);
}

async function bind(
  h: H,
  name = '合成项目',
): Promise<{ project: Project; folder: string; grantId: string }> {
  const project = h.projects.create({ name, rootPath: null, description: null });
  const f = folder(name);
  await h.runtime.bindProjectFolder(project.id, f);
  const grantId = h.permissions
    .list()
    .find((p) => p.status === 'active' && p.scope_type === 'folder')!.id;
  return { project: h.projects.get(project.id)!, folder: f, grantId };
}

describe('P5 解除绑定', () => {
  it('条件 1：路径清空、授权撤销、审计一条、返回带授权 id', async () => {
    const h = setup();
    const { project, grantId } = await bind(h);
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    expect(done.project.root_path).toBeNull();
    expect(done.revokedPermissionId).toBe(grantId);
    const rows = audits('project.folder_unbound');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: project.id, grantId, cancelled: 0 });
  });

  it('条件 2：解除之后三处都派不了编码任务', async () => {
    const h = setup();
    const { project } = await bind(h);
    await h.runtime.unbindProjectFolder(project.id);
    const draft = h.coding.create({
      projectId: project.id,
      goal: '再做一个',
      scope: ['note.txt'],
      allowedCommands: [],
    });
    const conv = h.conversations.create({ projectId: project.id });
    const ask = startAsk(h.runtime, conv.id, project.id);
    await waitActive(h.runtime, 1);
    await expect(
      h.runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow(UNBOUND_MESSAGE);
    await ask.finish();
    await expect(h.runtime.approveCodingTask(draft.id)).rejects.toThrow(UNBOUND_MESSAGE);
    const todo = h.todos.propose({
      title: '再做一个',
      linked: { kind: 'coding_task', id: draft.id },
    });
    await expect(h.runtime.acceptTodo(todo!.id)).rejects.toThrow(UNBOUND_MESSAGE);
    expect(h.coding.store.get(draft.id).status).toBe('draft');
    expect(h.todos.get(todo!.id).status).toBe('proposed');
  });

  it('条件 3：在途的取消并回报；别的状态不动；副本目录都还在', async () => {
    const h = setup();
    const { project } = await bind(h);
    const conv = h.conversations.create({ projectId: project.id, title: '合成对话' });
    const statuses = [
      'draft',
      'waiting_approval',
      'queued',
      'running',
      'pending_verify',
      'pending_accept',
      'completed',
      'failed',
      'cancelled',
    ] as const;
    const tasks = Object.fromEntries(
      statuses.map((s) => [s, makeTask(h, project.id, s)]),
    ) as Record<(typeof statuses)[number], CodingTask>;
    const copies = Object.fromEntries(
      Object.values(tasks).map((t) => [t.id, h.coding.store.get(t.id).workspace_path]),
    );
    db.prepare('UPDATE coding_tasks SET origin_run_id = ? WHERE id IN (?, ?, ?)').run(
      'run-1',
      tasks.queued.id,
      tasks.running.id,
      tasks.pending_verify.id,
    );
    h.conversations.appendMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: '提了任务',
      runId: 'run-1',
    });
    const done = await h.runtime.unbindProjectFolder(project.id);
    for (const s of ['queued', 'running', 'pending_verify'] as const) {
      expect(h.coding.store.get(tasks[s].id).status).toBe('cancelled');
      expect(done.cancelledTaskIds).toContain(tasks[s].id);
      expect(h.settled).toContain(tasks[s].id);
    }
    for (const s of [
      'draft',
      'waiting_approval',
      'pending_accept',
      'completed',
      'failed',
      'cancelled',
    ] as const) {
      expect(h.coding.store.get(tasks[s].id).status).toBe(s);
    }
    const reports = h.conversations
      .getWithMessages(conv.id)
      .messages.filter((m) => m.meta['kind'] === 'task_report');
    expect(reports.map((m) => m.content).join('\n')).toContain('取消了');
    for (const t of Object.values(tasks)) {
      const path = copies[t.id];
      if (path) expect(realpathSync.native(path)).toBeTruthy();
    }
  });

  it('条件 4：授权下的资料变成已撤销，提炼出的条目还在', async () => {
    const h = setup();
    const { project, grantId } = await bind(h);
    const sourceId = addSource(grantId, project.id);
    addItem(project.id, sourceId);
    const itemsBefore = db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    await h.runtime.unbindProjectFolder(project.id);
    const listed = new SourceStore(db).listWithPermission();
    expect(listed.find((s) => s.id === sourceId)?.permissionStatus).toBe('revoked');
    const itemsAfter = db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    expect(itemsAfter.n).toBe(itemsBefore.n);
  });

  it('条件 5：另一个项目也绑着同一个文件夹，授权不撤销', async () => {
    const h = setup();
    const { project, folder: f, grantId } = await bind(h, '甲');
    const other = h.projects.create({ name: '乙', rootPath: null, description: null });
    const variant = f
      .replaceAll('\\', '/')
      .replace(/\/([^/]+)$/, (_, name: string) => `/${name.toUpperCase()}`);
    db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(variant, other.id);
    const sourceId = addSource(grantId, project.id);
    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('kept_other_project');
    expect(preview.sourcesUnderGrant).toBe(0);
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    expect(h.permissions.get(grantId)!.status).toBe('active');
    expect(done.revokedPermissionId).toBeNull();
    expect(
      new SourceStore(db).listWithPermission().find((s) => s.id === sourceId)?.permissionStatus,
    ).toBe('active');
  });

  it('条件 6：没有单独的有效授权，或只有上级文件夹的授权，照样解除', async () => {
    const h = setup();
    const { project, grantId } = await bind(h);
    h.permissions.revoke(grantId);
    const parent = h.permissions.grantFolder(dir);
    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.grant).toBe('none');
    const done = await h.runtime.unbindProjectFolder(project.id);
    expect(h.projects.get(project.id)!.root_path).toBeNull();
    expect(done.revokedPermissionId).toBeNull();
    expect(h.permissions.get(parent.id)!.status).toBe('active');
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
  });

  it('条件 7：预览不改任何东西，数字对', async () => {
    const h = setup();
    const { project, folder: f, grantId } = await bind(h);
    makeTask(h, project.id, 'queued');
    makeTask(h, project.id, 'running');
    makeTask(h, project.id, 'pending_accept');
    makeTask(h, project.id, 'draft');
    addSource(grantId, project.id);
    addSource(grantId, project.id);
    const before = snapshot();
    const preview = await h.runtime.previewUnbindProjectFolder(project.id);
    expect(preview.rootPath).toBe(h.projects.get(project.id)!.root_path);
    expect(preview.inFlightTasks).toBe(2);
    expect(preview.pendingAcceptTasks).toBe(1);
    expect(preview.sourcesUnderGrant).toBe(2);
    expect(preview.grant).toBe('revoke');
    expect(preview.rootPath.replaceAll('\\', '/')).toContain(f.split(/[/\\]/).pop()!);
    expect(snapshot()).toEqual(before);
  });

  it('条件 8：项目不存在、没绑文件夹，两个接口都拒绝且什么都不变', async () => {
    const h = setup();
    const bare = h.projects.create({ name: '没绑', rootPath: null, description: null });
    const before = snapshot();
    await expect(h.runtime.previewUnbindProjectFolder('no-such')).rejects.toThrow(/不存在/);
    await expect(h.runtime.unbindProjectFolder('no-such')).rejects.toThrow(/不存在/);
    await expect(h.runtime.previewUnbindProjectFolder(bare.id)).rejects.toThrow(NO_FOLDER);
    await expect(h.runtime.unbindProjectFolder(bare.id)).rejects.toThrow(NO_FOLDER);
    expect(snapshot()).toEqual(before);
  });

  it('条件 9：重新绑定是一条新授权；等接受的任务这时接受，改动能落进去', async () => {
    const h = setup();
    const { project, folder: f, grantId } = await bind(h);
    const waiting = makeTask(h, project.id, 'pending_accept');
    db.prepare(
      `UPDATE coding_tasks SET executor_report_json = ?, verify_status = 'passed' WHERE id = ?`,
    ).run(
      JSON.stringify({
        claimedSuccess: true,
        summary: '',
        changedPaths: [],
        testsModified: false,
        raw: '',
      }),
      waiting.id,
    );
    await h.runtime.unbindProjectFolder(project.id);
    const again = await h.runtime.bindProjectFolder(project.id, f);
    expect(again.root_path).toBeTruthy();
    const active = h.permissions
      .list()
      .filter((p) => p.status === 'active' && p.scope_type === 'folder');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(grantId);
    expect(h.permissions.get(grantId)!.status).toBe('revoked');
    const accepted = await h.runtime.acceptCodingTask(waiting.id);
    expect(accepted.status).toBe('completed');
    expect(accepted.applied_ref).toMatch(/^ixaeon\//);
  });

  it('条件 10：解除绑定让对话上下文失效', async () => {
    const h = setup();
    const { project } = await bind(h);
    expect(h.invalidated).toHaveLength(0);
    await h.runtime.unbindProjectFolder(project.id);
    expect(h.invalidated).toHaveLength(1);
  });
});

describe('P5 IPC', () => {
  it('条件 12：registerIpc 注册了这两个接口，得到的和 AppRuntime 上的方法一样', async () => {
    const { ipcMain } = await import('electron');
    const { registerIpc } = await import('../../src/main/ipc.js');
    const preview = {
      rootPath: 'D:/synth',
      inFlightTasks: 0,
      pendingAcceptTasks: 0,
      sourcesUnderGrant: 0,
      grant: 'none',
    };
    const result = {
      project: { id: 'p1', root_path: null },
      revokedPermissionId: null,
      cancelledTaskIds: [],
    };
    const registered: Array<[string, (e: unknown, ...args: unknown[]) => unknown]> = [];
    (
      ipcMain as { handle: (c: string, f: (e: unknown, ...a: unknown[]) => unknown) => void }
    ).handle = (channel, fn) => {
      registered.push([channel, fn]);
    };
    const runtime = {
      previewUnbindProjectFolder: vi.fn(async () => preview),
      unbindProjectFolder: vi.fn(async () => result),
      db: db,
    };
    registerIpc(runtime as unknown as AppRuntime);
    const previewFn = registered.find((c) => c[0] === 'ixaeon:previewUnbindProjectFolder')?.[1];
    const unbindFn = registered.find((c) => c[0] === 'ixaeon:unbindProjectFolder')?.[1];
    expect(previewFn).toBeTypeOf('function');
    expect(unbindFn).toBeTypeOf('function');
    await expect(previewFn!({}, 'p1')).resolves.toEqual(preview);
    await expect(unbindFn!({}, 'p1')).resolves.toEqual(result);
    expect(runtime.previewUnbindProjectFolder).toHaveBeenCalledWith('p1');
    expect(runtime.unbindProjectFolder).toHaveBeenCalledWith('p1');
  });
});
