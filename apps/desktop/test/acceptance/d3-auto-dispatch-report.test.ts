/**
 * D3 验收（规格 docs/委派/D3-点要做就开工并回报.md 条件 1–6）
 *
 * 条件 1：点「要做」→ 任务被派发（执行器替身被调用），不用再点「派发」；
 *   这次点击立即返回，不等执行结束。
 * 条件 2：第一个任务执行中又点了第二个「要做」：第二个等第一个结束后才开始，
 *   顺序按批准先后。
 * 条件 3：执行器替身做完、验证通过 → 发起的对话里多一条回报：含目标、每条验收条件、
 *   「验证通过」、改动文件；同一状态不重复写。
 * 条件 4：验证失败 / 执行失败 → 回报含原因；取消 → 一句话回报。
 * 条件 5：找不到 Codex：不派发，任务停在已批准，对话里回报「没找到 Codex…」。
 * 条件 6：没有 origin_run_id 的任务做完：不往任何对话写。
 *
 * 执行器用替身（FakeCodingExecutor），不调用真 Codex。
 * 任务的 origin_run_id 由真实提问链路写下（替身会话在 withAskRun 里建任务）。
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-d3-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(async () => {
  if (db.open) db.close();
  // 自动派发的工作区复制可能还占着文件，删不掉就等一下再试
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
}

function setup(
  behavior: ConstructorParameters<typeof FakeCodingExecutor>[0] = {},
  runCheck?: CodingOrchestrator['runCheck'],
): Harness {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'note.txt'), '合成文件');
  const projects = new ProjectService(db);
  const project = projects.create({ name: '合成项目', rootPath: root, description: null });
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const executor = new FakeCodingExecutor(behavior);
  const coding = new CodingOrchestrator(db, executor, join(dir, 'data'), runCheck as never);
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
    getProvider: () => new FakeProvider('d3'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, conversations, todos, coding, executor, projectId: project.id };
}

/** 走真实提问链路建一个带 origin_run_id 的编码任务草案，并挂成待办。 */
async function proposedTask(
  h: Harness,
  input: { goal: string; acceptance?: string[]; commands?: string[][]; conversationId?: string },
): Promise<{ todoId: string; taskId: string; conversationId: string }> {
  const conv =
    input.conversationId != null
      ? h.conversations.get(input.conversationId)
      : h.conversations.create({ projectId: h.projectId });
  let taskId = '';
  h.runtime['askSessions'].set(conv.id, {
    run: async () => {
      const task = h.coding.create({
        projectId: h.projectId,
        goal: input.goal,
        scope: ['note.txt'],
        allowedCommands: input.commands ?? [],
      });
      if (input.acceptance) {
        db.prepare('UPDATE coding_tasks SET acceptance_json = ? WHERE id = ?').run(
          JSON.stringify(input.acceptance),
          task.id,
        );
      }
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
    getEngineSessionId: () => 's-d3',
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

function h_messages(conversationId: string) {
  return db
    .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
    .all(conversationId) as Array<{ content: string; meta_json: string }>;
}

const withMeta = (rows: Array<{ content: string; meta_json: string }>) =>
  rows.map((r) => ({
    content: r.content,
    meta: JSON.parse(r.meta_json) as Record<string, unknown>,
  }));

const passingCheck = async () => ({ argv: ['node'], exitCode: 0, output: 'ok', ran: true });
const failingCheck = async () => ({ argv: ['node'], exitCode: 1, output: '断言没过', ran: true });

describe('点「要做」就开工并回报', () => {
  it('条件 1：点「要做」就派发，点击立即返回不等执行结束', async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const h = setup({
      files: { 'note.txt': '改过了' },
      claimedSuccess: true,
    });
    // 执行器卡住，证明点击不等它结束；调用时先记下目标
    const original = h.executor.run.bind(h.executor);
    h.executor.run = async (task, workspace, signal) => {
      h.executor.lastGoal = task.goal;
      await gate;
      return original(task, workspace, signal);
    };
    const { todoId, taskId, conversationId } = await proposedTask(h, {
      goal: '修掉导入时的乱码',
      commands: [[process.execPath, '-e', 'process.exit(0)']],
    });
    const started = Date.now();
    const accepted = await h.runtime.acceptTodo(todoId);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(accepted.status).toBe('accepted');
    // 点击返回时执行器已经被调用（任务在跑），不用再点派发
    await vi.waitFor(() => expect(taskStatus(taskId)).toBe('running'));
    await vi.waitFor(() => expect(h.executor.lastGoal).toContain('修掉导入时的乱码'));
    releaseRun();
    // 等执行结束再退出：否则库先关，迟到的派发会撞上已关闭的连接
    await vi.waitFor(() => expect(reports(conversationId)).toHaveLength(1));
    expect(taskStatus(taskId)).not.toBe('running');
  });

  it('条件 2：第二个等第一个结束后才开始，顺序按批准先后', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    let runs = 0;
    const original = h.executor.run.bind(h.executor);
    h.executor.run = async (task, workspace, signal) => {
      runs += 1;
      order.push(task.goal.split('\n')[0]!);
      if (runs === 1) await firstGate;
      return original(task, workspace, signal);
    };
    const first = await proposedTask(h, { goal: '第一个任务' });
    const second = await proposedTask(h, {
      goal: '第二个任务',
      conversationId: first.conversationId,
    });
    await h.runtime.acceptTodo(first.todoId);
    await vi.waitFor(() => expect(order).toEqual(['第一个任务']));
    // 第一个还在执行时批准第二个：先排队，不抢跑
    await h.runtime.acceptTodo(second.todoId);
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['第一个任务']);
    expect(taskStatus(second.taskId)).toBe('queued');
    releaseFirst();
    await vi.waitFor(() => expect(order).toEqual(['第一个任务', '第二个任务']));
    await vi.waitFor(() => expect(taskStatus(second.taskId)).not.toBe('running'));
  });

  it('条件 3：做完验证通过 → 对话里回报含目标、验收条件、验证通过、改动文件，不重复写', async () => {
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true }, passingCheck);
    const { todoId, conversationId } = await proposedTask(h, {
      goal: '修掉导入时的乱码\n细节不进回报',
      acceptance: ['打开不再乱码', '别的文件不动'],
      commands: [[process.execPath, '-e', 'process.exit(0)']],
    });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => {
      const reports = withMeta(h_messages(conversationId)).filter(
        (m) => m.meta['kind'] === 'task_report',
      );
      expect(reports).toHaveLength(1);
    });
    const [report] = withMeta(h_messages(conversationId)).filter(
      (m) => m.meta['kind'] === 'task_report',
    );
    expect(report!.content).toContain('修掉导入时的乱码');
    expect(report!.content).not.toContain('细节不进回报');
    expect(report!.content).toContain('打开不再乱码');
    expect(report!.content).toContain('别的文件不动');
    expect(report!.content).toContain('验证通过');
    // note.txt 不在验收条件里：这条断言只可能被「改动文件」那一行满足
    expect(report!.content).toContain('note.txt');
    expect(report!.content).toContain('去任务页看改动，点接受');
    expect(report!.meta).toMatchObject({ kind: 'task_report', status: 'pending_accept' });
    // 同一状态不重复写：任务还停在 pending_accept，再结算一次，回报仍是一条
    h.runtime['codingDispatch'].onTaskSettled(report!.meta['taskId'] as string);
    const again = withMeta(h_messages(conversationId)).filter(
      (m) => m.meta['kind'] === 'task_report',
    );
    expect(again).toHaveLength(1);
  });

  it('条件 3：没有验收条件时回报不列验收条件，没有独立验收如实写', async () => {
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    const { todoId, conversationId } = await proposedTask(h, { goal: '加个说明文件' });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(reports(conversationId)).toHaveLength(1));
    const [report] = reports(conversationId);
    expect(report!.content).toContain('加个说明文件');
    expect(report!.content).toContain('还没有独立验收');
    expect(report!.content).not.toContain('验收条件');
  });

  it('条件 4：验证失败 → 回报含原因', async () => {
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true }, failingCheck);
    const { todoId, conversationId } = await proposedTask(h, {
      goal: '修乱码',
      commands: [[process.execPath, '-e', 'process.exit(1)']],
    });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(reports(conversationId)).toHaveLength(1));
    const [report] = reports(conversationId);
    expect(report!.content).toContain('修乱码');
    expect(report!.content).toContain('没做成');
    expect(report!.content).toContain('独立验证失败');
    expect(report!.meta).toMatchObject({ status: 'failed' });
  });

  it('条件 4：执行失败 → 回报含原因', async () => {
    const h = setup({ claimedSuccess: false, summary: '写文件失败' });
    const { todoId, conversationId } = await proposedTask(h, { goal: '修乱码' });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(reports(conversationId)).toHaveLength(1));
    const [report] = reports(conversationId);
    expect(report!.content).toContain('没做成');
    expect(report!.content).toContain('执行器未声称成功');
    expect(report!.meta).toMatchObject({ status: 'failed' });
  });

  it('条件 4：取消 → 一句话回报', async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    const original = h.executor.run.bind(h.executor);
    h.executor.run = async (task, workspace, signal) => {
      await gate;
      return original(task, workspace, signal);
    };
    const { todoId, taskId, conversationId } = await proposedTask(h, { goal: '修乱码' });
    await h.runtime.acceptTodo(todoId);
    await vi.waitFor(() => expect(taskStatus(taskId)).toBe('running'));
    h.coding.cancel(taskId);
    releaseRun();
    await vi.waitFor(() => expect(reports(conversationId)).toHaveLength(1));
    const [report] = reports(conversationId);
    expect(report!.content).toBe('「修乱码」取消了。');
    expect(report!.meta).toMatchObject({ status: 'cancelled' });
  });

  it('条件 5：找不到 Codex → 不派发，任务停在已批准，对话里回报', async () => {
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    h.runtime.codexLocator = () => null;
    const { todoId, taskId, conversationId } = await proposedTask(h, { goal: '修乱码' });
    await h.runtime.acceptTodo(todoId);
    // 点击返回时任务停在已批准；随后才回报「没找到 Codex」
    expect(taskStatus(taskId)).toBe('queued');
    await vi.waitFor(() => expect(reports(conversationId)).toHaveLength(1));
    expect(taskStatus(taskId)).toBe('queued');
    expect(h.executor.lastGoal).toBe('');
    const [report] = reports(conversationId);
    expect(report!.content).toContain('没找到 Codex');
    expect(report!.content).toContain('任务页点派发');
    expect(report!.meta).toMatchObject({ kind: 'task_report', status: 'codex_missing' });
  });

  it('条件 6：没有 origin_run_id 的任务做完 → 不往任何对话写', async () => {
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    const conv = h.conversations.create({ projectId: h.projectId });
    // 任务页手建：不在提问上下文里，origin_run_id 为空
    const task = h.coding.create({
      projectId: h.projectId,
      goal: '手建的任务',
      scope: ['note.txt'],
      allowedCommands: [],
    });
    const todo = h.todos.propose({
      title: '手建的任务',
      conversationId: conv.id,
      linked: { kind: 'coding_task', id: task.id },
    });
    const before = h_messages(conv.id).length;
    await h.runtime.acceptTodo(todo!.id);
    await vi.waitFor(() => expect(taskStatus(task.id)).toBe('pending_accept'));
    expect(h_messages(conv.id)).toHaveLength(before);
    const anyReport = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE json_extract(meta_json, '$.kind') = 'task_report'",
        )
        .get() as {
        n: number;
      }
    ).n;
    expect(anyReport).toBe(0);
  });

  it('任务页手动派发的任务还在执行时点「要做」：那个任务结束后自动续上', async () => {
    let releaseManual!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseManual = resolve;
    });
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    const original = h.executor.run.bind(h.executor);
    h.executor.run = async (task, workspace, signal) => {
      if (task.goal.startsWith('手动')) await gate;
      return original(task, workspace, signal);
    };
    // 任务页手动建一个已批准的任务并派发（没有 origin_run_id，不写回报）
    const manual = h.coding.create({
      projectId: h.projectId,
      goal: '手动派发的任务',
      scope: ['note.txt'],
      allowedCommands: [],
    });
    await h.coding.approveAndQueue(manual.id);
    const running = h.runtime.finishCodingTask(manual.id, 'dispatch');
    await vi.waitFor(() => expect(taskStatus(manual.id)).toBe('running'));
    // 手动任务执行中点「要做」：先排队
    const queued = await proposedTask(h, { goal: '排队的任务' });
    await h.runtime.acceptTodo(queued.todoId);
    await new Promise((r) => setTimeout(r, 50));
    expect(taskStatus(queued.taskId)).toBe('queued');
    releaseManual();
    await running;
    await vi.waitFor(() => expect(taskStatus(queued.taskId)).not.toBe('queued'));
    await vi.waitFor(() => expect(reports(queued.conversationId)).toHaveLength(1));
  });

  it('排队中的任务被取消：对话里有一句话回报，下一个照常开始', async () => {
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    const first = await proposedTask(h, { goal: '先取消的' });
    const second = await proposedTask(h, {
      goal: '后开始的',
      conversationId: first.conversationId,
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const original = h.executor.run.bind(h.executor);
    h.executor.run = async (task, workspace, signal) => {
      if (task.goal.startsWith('先取消')) await gate;
      return original(task, workspace, signal);
    };
    await h.runtime.acceptTodo(first.todoId);
    await vi.waitFor(() => expect(taskStatus(first.taskId)).toBe('running'));
    await h.runtime.acceptTodo(second.todoId);
    expect(taskStatus(second.taskId)).toBe('queued');
    // 第二个还在排队时从任务页取消：要有取消回报（走真实入口）
    await h.runtime.finishCodingTask(second.taskId, 'cancel');
    const [report] = reports(first.conversationId);
    expect(report!.content).toBe('「后开始的」取消了。');
    releaseFirst();
    await vi.waitFor(() => expect(taskStatus(first.taskId)).not.toBe('running'));
  });

  it('同一时间戳的两个排队任务按批准先后派发', async () => {
    const order: string[] = [];
    const h = setup({ files: { 'note.txt': '改过了' }, claimedSuccess: true });
    const original = h.executor.run.bind(h.executor);
    h.executor.run = async (task, workspace, signal) => {
      order.push(task.goal.split('\n')[0]!);
      return original(task, workspace, signal);
    };
    const a = await proposedTask(h, { goal: '甲' });
    const b = await proposedTask(h, { goal: '乙', conversationId: a.conversationId });
    await h.runtime.acceptTodo(a.todoId);
    await h.runtime.acceptTodo(b.todoId);
    // 两个批准写成同一个时间：顺序只能靠批准记录的先后
    db.prepare('UPDATE coding_approvals SET granted_at = ?').run('2026-09-27T00:00:00.000Z');
    await vi.waitFor(() => expect(order).toEqual(['甲', '乙']));
  });

  it('正在执行的任务失败后，排队的下一个照常开始', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = setup({ claimedSuccess: false, summary: '写失败了' });
    const original = h.executor.run.bind(h.executor);
    let runs = 0;
    h.executor.run = async (task, workspace, signal) => {
      runs += 1;
      order.push(task.goal.split('\n')[0]!);
      if (runs === 1) await gate;
      return original(task, workspace, signal);
    };
    const first = await proposedTask(h, { goal: '会失败的' });
    const second = await proposedTask(h, {
      goal: '失败后的',
      conversationId: first.conversationId,
    });
    await h.runtime.acceptTodo(first.todoId);
    await vi.waitFor(() => expect(order).toEqual(['会失败的']));
    await h.runtime.acceptTodo(second.todoId);
    releaseFirst();
    await vi.waitFor(() => expect(order).toEqual(['会失败的', '失败后的']));
    const [report] = reports(first.conversationId);
    expect(report!.content).toContain('没做成');
  });
});

function reports(conversationId: string) {
  return withMeta(h_messages(conversationId)).filter((m) => m.meta['kind'] === 'task_report');
}
