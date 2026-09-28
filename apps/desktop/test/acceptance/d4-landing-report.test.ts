/**
 * D4 验收（规格 docs/委派/D4-接受后在项目里建分支.md 契约 6）
 *
 * 落地结果要回到发起任务的对话里（用 D3 的对话回报追加一条）：
 * - 建了分支 → 「已在项目仓库建分支 ixaeon/…（没有推送，也没动你的工作区）。要合并：git merge ixaeon/…」
 * - 没能建分支 → 「没能建分支（原因），改动包在 …」
 * - 没有改动 → 回报里写「没有改动」（契约 2）
 * 任务页同样显示：任务列表的行里有 applied_ref / apply_error（页面拿的就是 store.list()）。
 *
 * 接受走 runtime.acceptCodingTask（ipc 的 acceptCodingTask 应改为调它）：
 * 核心的 coding.accept 成功之后触发落地，再把落地结果追加回报。
 * 八条验收条件与契约 1–5、7 的核心部分见 packages/core/test/acceptance/d4-apply-branch.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type AgentSession,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-d4r-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(async () => {
  if (db.open) db.close();
  // 落地的工作树、副本可能还占着文件，删不掉就等一下再试
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
  conversations: ConversationStore;
  todos: TodoStore;
  coding: CodingOrchestrator;
  executor: FakeCodingExecutor;
  projectId: string;
  /** 替身派发时要写进副本的文件；派发（点「要做」）前改这里。 */
  files: Record<string, string>;
}

function setup(opts: { gitRepo?: boolean } = {}): Harness {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'note.txt'), '第一版');
  if (opts.gitRepo !== false) {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', '初始'],
      { cwd: root },
    );
  }
  const projects = new ProjectService(db);
  const project = projects.create({ name: '合成项目', rootPath: root, description: null });
  new PermissionService(db).grantFolder(root);
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const files: Record<string, string> = {};
  const executor = new FakeCodingExecutor({ claimedSuccess: true, files });
  const coding = new CodingOrchestrator(db, executor, join(dir, 'data'));
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    todos,
    coding,
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('d4'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, conversations, todos, coding, executor, projectId: project.id, files };
}

/** 走真实提问链路建一个带 origin_run_id 的编码任务草案，并挂成待办。 */
async function proposedTask(
  h: Harness,
  input: { goal: string; files: Record<string, string> },
): Promise<{ todoId: string; taskId: string; conversationId: string }> {
  Object.assign(h.files, input.files);
  const conv = h.conversations.create({ projectId: h.projectId });
  let taskId = '';
  h.runtime['askSessions'].set(conv.id, {
    run: async () => {
      const task = h.coding.create({
        projectId: h.projectId,
        goal: input.goal,
        scope: Object.keys(input.files).length > 0 ? Object.keys(input.files) : ['note.txt'],
        allowedCommands: [[process.execPath, '-e', 'process.exit(0)']],
      });
      taskId = task.id;
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
    getEngineSessionId: () => 's-d4',
  } as unknown as AgentSession);
  const r = await h.runtime.ask({
    conversationId: conv.id,
    projectId: h.projectId,
    question: '把这个做了',
  });
  const [todo] = h.todos.list({ status: ['proposed'] }).filter((t) => t.linked_id === taskId);
  return { todoId: todo!.id, taskId, conversationId: r.conversationId };
}

const taskStatus = (id: string) =>
  (db.prepare('SELECT status FROM coding_tasks WHERE id = ?').get(id) as { status: string }).status;

function reports(conversationId: string) {
  return (
    db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ content: string; meta_json: string }>
  )
    .map((r) => ({ content: r.content, meta: JSON.parse(r.meta_json) as Record<string, unknown> }))
    .filter((m) => m.meta['kind'] === 'task_report');
}

describe('接受之后把落地结果回报给原对话', () => {
  it('建了分支：追加一条回报，说清分支名、没推送、怎么合并；任务页看得到', async () => {
    const h = setup({ gitRepo: true });
    const { todoId, taskId, conversationId } = await proposedTask(h, {
      goal: '把说明写清楚',
      files: { 'note.txt': '改过了' },
    });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(taskStatus(taskId)).toBe('pending_accept'));
    const before = reports(conversationId);
    expect(before.length).toBeGreaterThan(0); // D3 的「等你验收」回报已在
    await h.runtime.acceptCodingTask(taskId);
    const branch = `ixaeon/${taskId.slice(0, 8)}`;
    expect(taskStatus(taskId)).toBe('completed');
    const after = reports(conversationId);
    expect(after.length).toBe(before.length + 1); // 追加一条，不是改写
    const landing = after[after.length - 1]!;
    expect(landing.meta['taskId']).toBe(taskId);
    expect(landing.content).toContain(`已在项目仓库建分支 ${branch}`);
    expect(landing.content).toContain('没有推送');
    expect(landing.content).toContain('没动你的工作区');
    expect(landing.content).toContain(`git merge ${branch}`);
    // 任务页同样显示：列表行里能看到落地结果（页面拿的就是 store.list()）
    const listed = h.coding.store.list().find((t) => t.id === taskId) as unknown as
      | { applied_ref: string | null; applied_at: string | null; apply_error: string | null }
      | undefined;
    expect(listed?.applied_ref).toBe(branch);
    expect(listed?.applied_at).not.toBeNull();
    expect(listed?.apply_error).toBeNull();
  });

  it('没能建分支（不是 git 仓库）：回报原因和改动包位置，追加不改写', async () => {
    const h = setup({ gitRepo: false });
    const { todoId, taskId, conversationId } = await proposedTask(h, {
      goal: '把说明写清楚',
      files: { 'note.txt': '改过了' },
    });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(taskStatus(taskId)).toBe('pending_accept'));
    const before = reports(conversationId);
    await h.runtime.acceptCodingTask(taskId);
    const all = reports(conversationId);
    expect(all.length).toBe(before.length + 1); // 追加一条，不是改写
    const landing = all[all.length - 1]!;
    expect(landing.meta['taskId']).toBe(taskId);
    // 按规格的句式「没能建分支（原因），改动包在 …」：原因非空，路径是真的补丁目录
    expect(landing.content).toMatch(/没能建分支（[^）]+），改动包在/);
    expect(landing.content).toContain('不是 git 仓库');
    const patchPath = join(dir, 'data', 'patches', taskId);
    expect(landing.content.replaceAll('\\', '/')).toContain(patchPath.replaceAll('\\', '/'));
  });

  it('没有改动：回报里如实写「没有改动」，追加不改写', async () => {
    const h = setup({ gitRepo: true });
    const { todoId, taskId, conversationId } = await proposedTask(h, {
      goal: '看看就好',
      files: {},
    });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(taskStatus(taskId)).toBe('pending_accept'));
    const before = reports(conversationId);
    await h.runtime.acceptCodingTask(taskId);
    const all = reports(conversationId);
    expect(all.length).toBe(before.length + 1); // 追加一条，不是改写
    const landing = all[all.length - 1]!;
    expect(landing.meta['taskId']).toBe(taskId);
    expect(landing.content).toContain('没有改动');
  });

  it('真实 IPC 入口：点「接受」走的那条通道也触发落地回报', async () => {
    // 契约 1 的触发点是用户在任务页点「接受」：ipc 的 acceptCodingTask 通道必须接
    // runtime.acceptCodingTask（落地 + 回报），不能仍直调 runtime.coding.accept。
    const h = setup({ gitRepo: true });
    const { todoId, taskId, conversationId } = await proposedTask(h, {
      goal: '把说明写清楚',
      files: { 'note.txt': '改过了' },
    });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(taskStatus(taskId)).toBe('pending_accept'));
    const before = reports(conversationId);
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([ch]) => ch === 'ixaeon:acceptCodingTask');
    expect(entry).toBeDefined();
    await entry![1]({} as never, taskId);
    const after = reports(conversationId);
    expect(after.length).toBe(before.length + 1); // 走 IPC 通道同样追加落地回报
    const landing = after[after.length - 1]!;
    expect(landing.content).toContain(`ixaeon/${taskId.slice(0, 8)}`);
    const branch = `ixaeon/${taskId.slice(0, 8)}`;
    const listed = h.coding.store.list().find((t) => t.id === taskId) as unknown as
      { applied_ref: string | null; apply_error: string | null } | undefined;
    expect(listed?.applied_ref).toBe(branch);
    expect(listed?.apply_error).toBeNull();
  });
});
