/**
 * T2b 验收（整合方写死，执行方不改）：聊天里提出的编码任务进待办，拍板即批准。
 * 委派单：docs/委派/T2b-编码任务进待办.md
 * 设计决定 3：待办是薄的一层，底下指向已有的编码任务；状态以任务表为准。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type AgentSession,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t2b-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 真实 ask()；会话替身在这一轮里提出一个编码任务（像 Core 工具 propose_task 那样）。 */
function setup(goal = '修掉导入时的乱码\n细节：只动 note.txt') {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'note.txt'), '合成文件');
  const projects = new ProjectService(db);
  const project = projects.create({ name: '合成项目', rootPath: root, description: null });
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const coding = new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data'));
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
    getProvider: () => new FakeProvider('t2b'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  const conv = conversations.create({ projectId: project.id });
  let taskId = '';
  runtime['askSessions'].set(conv.id, {
    run: async () => {
      taskId = coding.create({
        projectId: project.id,
        goal,
        scope: ['note.txt'],
        allowedCommands: [[process.execPath, '-e', "require('fs').existsSync('note.txt')"]],
      }).id;
      return {
        answer: '可以，我起草了一个编码任务，等你拍板。',
        citations: [],
        notice: '本轮经 Hermes TUI gateway',
        usedChars: 1,
        modelName: 'hermes',
        engine: 'hermes',
        runId: 'run',
        steps: [],
        memoryUsed: [],
      };
    },
    cancel: () => undefined,
    getEngineSessionId: () => 's-test',
  } as unknown as AgentSession);
  const ask = async () => {
    const r = await runtime.ask({
      conversationId: conv.id,
      projectId: project.id,
      question: '把乱码修了',
    });
    return { r, taskId };
  };
  return { runtime, conversations, todos, coding, conv, ask };
}

const taskStatus = (id: string) =>
  (db.prepare('SELECT status FROM coding_tasks WHERE id = ?').get(id) as { status: string }).status;

describe('编码任务进待办', () => {
  it('这一轮提出的编码任务成了等你拍板的待办，标题取任务第一行，记在这条回答上', async () => {
    const { conversations, todos, conv, ask } = setup();
    const { r, taskId } = await ask();
    const [t] = todos.list({ status: ['proposed'] });
    expect(t).toMatchObject({
      title: '修掉导入时的乱码',
      origin: 'agent',
      linked_kind: 'coding_task',
      linked_id: taskId,
      linkedStatus: 'draft',
      conversation_id: conv.id,
      message_id: r.messageId,
    });
    const meta = conversations.getMessage(r.messageId).meta['proposedTodos'] as Array<{
      id: string;
    }>;
    expect(meta.map((m) => m.id)).toEqual([t!.id]);
  });

  it('拍板「要做」= 批准编码任务并排队', async () => {
    const { runtime, todos, ask } = setup();
    const { taskId } = await ask();
    const [t] = todos.list({ status: ['proposed'] });
    await runtime.acceptTodo(t!.id);
    expect(todos.get(t!.id).status).toBe('accepted');
    expect(taskStatus(taskId)).toBe('queued');
  });

  it('「不做」= 取消还没开始的编码任务', async () => {
    const { runtime, todos, ask } = setup();
    const { taskId } = await ask();
    const [t] = todos.list({ status: ['proposed'] });
    await runtime.rejectTodo(t!.id);
    expect(todos.get(t!.id).status).toBe('rejected');
    expect(taskStatus(taskId)).toBe('cancelled');
  });

  it('编码任务完成了，待办跟着算做完', async () => {
    const { runtime, todos, ask } = setup();
    const { taskId } = await ask();
    const [t] = todos.list({ status: ['proposed'] });
    await runtime.acceptTodo(t!.id);
    db.prepare(`UPDATE coding_tasks SET status = 'completed' WHERE id = ?`).run(taskId);
    const list = runtime.listTodos({});
    expect(list.find((x) => x.id === t!.id)).toMatchObject({
      status: 'done',
      linkedStatus: 'completed',
    });
  });

  it('你拒绝过的同样的事又被提出来：不进待办，起草的编码任务自动取消', async () => {
    const { conversations, todos, ask } = setup();
    todos.reject(todos.propose({ title: '修掉导入时的乱码' })!.id);
    const { r, taskId } = await ask();
    expect(todos.list({ status: ['proposed'] })).toEqual([]);
    expect(taskStatus(taskId)).toBe('cancelled');
    expect(conversations.getMessage(r.messageId).meta['proposedTodos']).toBeUndefined();
  });
});
