/**
 * G04 验收（规格 docs/委派/G04-编码任务按运行归属.md）
 *
 * 条件 1：对话 A 等回答时，另一个运行（对话 B、项目 B）建的任务不出现在 A 的回答里，
 *         出现在 B 的回答里。
 * 条件 2：同一项目两轮并发，各自建的任务各归各的。
 * 条件 3：propose_task 建任务时写上这次调用的 runId（origin_run_id）；
 *         A 这一轮自己建的任务照常出现在 A 的回答上并进待办。
 * 条件 4：没有 origin_run_id 的旧任务不出现在任何回答上。
 *
 * 归属的断言点是回答消息 meta.proposedTodos（T2b 的待办卡同一条路径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  CodingTaskStore,
  ConversationStore,
  CoreToolBroker,
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g04-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ANSWER = {
  answer: '好的',
  citations: [],
  notice: '本轮经 Hermes TUI gateway',
  usedChars: 1,
  modelName: 'hermes',
  engine: 'hermes',
  runId: 'run',
  steps: [],
  memoryUsed: [],
};

/** 建一条编码任务并写上归属的运行（originRunId 为 null 表示旧数据）。 */
function makeTask(
  tasks: CodingTaskStore,
  projectId: string,
  goal: string,
  originRunId: string | null,
) {
  const task = tasks.create({
    projectId,
    goal,
    scope: ['a.txt'],
    allowedCommands: [['node', '-e', 'process.exit(0)']],
  });
  db.prepare('UPDATE coding_tasks SET origin_run_id = ? WHERE id = ?').run(originRunId, task.id);
  return task;
}

function titlesOf(conversations: ConversationStore, messageId: string): string[] {
  const meta = conversations.getMessage(messageId).meta['proposedTodos'] as
    Array<{ title: string }> | undefined;
  return (meta ?? []).map((t) => t.title).sort();
}

function runtime() {
  const projects = new ProjectService(db);
  const projectA = projects.create({ name: '项目A', rootPath: null, description: null });
  const projectB = projects.create({ name: '项目B', rootPath: null, description: null });
  const conversations = new ConversationStore(db);
  const convA = conversations.create({ projectId: projectA.id });
  const convB = conversations.create({ projectId: projectB.id });
  const tasks = new CodingTaskStore(db);
  const rt = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(rt, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('g04'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { rt, conversations, tasks, projectA, projectB, convA, convB };
}

describe('G04 编码任务按运行归属', () => {
  it('条件 3：propose_task 建任务时记下这次调用的 runId', async () => {
    const projects = new ProjectService(db);
    const project = projects.create({ name: '项目A', rootPath: null, description: null });
    const broker = new CoreToolBroker(
      db,
      new ItemService(db),
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      projects,
    );
    const created = (await broker.invoke(
      'propose_task',
      { projectId: project.id, goal: '本轮的任务' },
      { audience: 'model', runId: 'run-A' },
    )) as { id: string };
    const row = db
      .prepare('SELECT origin_run_id FROM coding_tasks WHERE id = ?')
      .get(created.id) as {
      origin_run_id: string | null;
    };
    expect(row.origin_run_id).toBe('run-A');
  });

  it('条件 1 与 4：别人运行建的任务和没有归属的旧任务都不进 A 的回答，A 自己的照进', async () => {
    const { rt, conversations, tasks, projectA, projectB, convA } = runtime();
    rt['askSessions'].set(convA.id, {
      run: async (input: { runId?: string }) => {
        // 都在本轮等待期间建：时间窗口分不出它们，只有 origin_run_id 分得出
        makeTask(tasks, projectB.id, '别人运行的任务', 'run-other');
        makeTask(tasks, projectA.id, '没有归属的旧任务', null);
        makeTask(tasks, projectA.id, 'A这一轮的任务', input.runId ?? null);
        return ANSWER;
      },
      cancel: () => undefined,
      getEngineSessionId: () => 's-test',
    } as unknown as AgentSession);
    const r = await rt.ask({
      conversationId: convA.id,
      projectId: projectA.id,
      question: '帮我做',
    });
    expect(titlesOf(conversations, r.messageId)).toEqual(['A这一轮的任务']);
  });

  it('条件 1：那个任务出现在它自己的运行（对话 B）的回答里', async () => {
    const { rt, conversations, tasks, projectB, convB } = runtime();
    rt['askSessions'].set(convB.id, {
      run: async (input: { runId?: string }) => {
        makeTask(tasks, projectB.id, 'B这一轮的任务', input.runId ?? null);
        return ANSWER;
      },
      cancel: () => undefined,
      getEngineSessionId: () => 's-test',
    } as unknown as AgentSession);
    const r = await rt.ask({
      conversationId: convB.id,
      projectId: projectB.id,
      question: '帮我做',
    });
    expect(titlesOf(conversations, r.messageId)).toEqual(['B这一轮的任务']);
  });

  it('条件 2：同一项目两轮并发，各自的任务各归各的回答', async () => {
    const { rt, conversations, tasks, projectA, convA, convB } = runtime();
    let resolveA: () => void = () => undefined;
    let resolveB: () => void = () => undefined;
    const aInserted = new Promise<void>((r) => {
      resolveA = r;
    });
    const bInserted = new Promise<void>((r) => {
      resolveB = r;
    });
    const session = (goal: string, signal: () => void, waitFor: Promise<void>) =>
      ({
        run: async (input: { runId?: string }) => {
          makeTask(tasks, projectA.id, goal, input.runId ?? null);
          signal();
          await waitFor;
          return ANSWER;
        },
        cancel: () => undefined,
        getEngineSessionId: () => 's-test',
      }) as unknown as AgentSession;
    rt['askSessions'].set(convA.id, session('并发任务A', resolveA, bInserted));
    rt['askSessions'].set(convB.id, session('并发任务B', resolveB, aInserted));
    const [a, b] = await Promise.all([
      rt.ask({ conversationId: convA.id, projectId: projectA.id, question: '问A' }),
      rt.ask({ conversationId: convB.id, projectId: projectA.id, question: '问B' }),
    ]);
    expect(titlesOf(conversations, a.messageId)).toEqual(['并发任务A']);
    expect(titlesOf(conversations, b.messageId)).toEqual(['并发任务B']);
  });
});
