/**
 * CF4 整合方复审补的回归测试（不是锁定验收测试）。对应代审「必须改」中开发 42b1cf6 修掉、但没补测试的几条：
 * - 显式 scope: [] 拒绝（不悄悄扩大成项目根目录）；不传才用 ["."]；
 * - 任务页手建 IPC createCodingTask 附带来源字段无效，不能绕过校验与留痕；
 * - 审计写入失败时任务一起回滚（建任务与审计同一事务）。
 * 夹具照抄 apps/desktop/test/acceptance/cf4-task-from-conversation.test.ts。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
  },
}));

import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { ErrorCodes, defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

let dir: string;
let db: CoreDatabase;
let folder: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf4-'));
  folder = mkdtempSync(join(tmpdir(), 'ixaeon-cf4-folder-'));
  // 项目目录不能是空的：派发时要拿它做快照（条件 9）
  writeFileSync(join(folder, 'note.txt'), '合成项目文件\n', 'utf8');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});
afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

const Q1 = '合成暗号：蓝鲸七号';
const Q2 = '那先做记一笔这页';
const A1 = '合成回答一：记账要有记一笔和列表两页';
const A2 = '合成回答二：记一笔这页要填金额和备注';

interface Ctx {
  runtime: AppRuntime;
  convId: string;
  projectId: string;
  seqs: number[];
  ids: string[];
  contents: string[];
  /** 执行器每一次被调用时收到的任务与选项（条件 1 要 0 次，条件 9 要看内容）。 */
  seen: unknown[];
}

function fixture(opts: { personal?: boolean } = {}): Ctx {
  const conversations = new ConversationStore(db);
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const executor = new FakeCodingExecutor();
  const seen: unknown[] = [];
  const realRun = executor.run.bind(executor);
  executor.run = async (task, workspace, signal, options) => {
    seen.push({ task, options: options ?? null });
    return realRun(task, workspace, signal, options);
  };
  const base = defaultAppConfig();
  const config = {
    ...base,
    model: { ...base.model, modelName: '', chatModelName: '' },
    providers: [],
    uses: {},
  } as AppConfig;
  const answers = [A1, A2];
  let turn = 0;
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime as unknown as Record<string, unknown>, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    permissions,
    coding: new CodingOrchestrator(db, executor, join(dir, 'data')),
    dataDir: dir,
    config,
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    directAskAborts: new Map(),
    askDeltaSink: null,
    askProgressSink: null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    jobs: {
      enqueue: () => ({ id: 'job-1' }),
      enqueueExtract: () => undefined,
      hold: () => () => undefined,
      isHeld: () => false,
      kick: () => undefined,
      stop: () => undefined,
      idle: () => true,
      idleExecution: () => true,
      isExecuting: () => false,
      register: () => undefined,
    },
    imports: { captureAsk: () => ({ created: false as const }) },
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    chatStreamClient: () => ({
      modelName: 'demo-a',
      stream: async () => ({
        content: answers[turn++] ?? '合成回答：多出来的一轮',
        toolCalls: [],
        finishReason: 'stop',
      }),
    }),
  });
  const p = runtime.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKey: 'sk-synthetic-a1b2c3d4',
    savedModels: ['demo-a'],
  });
  runtime.saveModelUses({ chat: { providerId: p.id, model: 'demo-a' } });

  const project = projects.create({ name: '合成项目甲', rootPath: null, description: null });
  runtime.bindProjectFolder(project.id, folder);
  const conv = conversations.create({ projectId: opts.personal ? null : project.id });
  return {
    runtime,
    convId: conv.id,
    projectId: project.id,
    seqs: [],
    ids: [],
    contents: [],
    seen,
  };
}

async function chatTwoTurns(ctx: Ctx): Promise<void> {
  // 照界面那样传对话自己的项目：ask 在空对话第一问时以传入的 projectId 为准写回（G06），
  // 传 null 会把项目对话变成个人视角（原测试就是这样，条件 4 因此没测到）。
  const projectId = ctx.runtime.conversations.get(ctx.convId).projectId;
  await ctx.runtime.ask({ conversationId: ctx.convId, projectId, question: Q1 } as never);
  await ctx.runtime.ask({ conversationId: ctx.convId, projectId, question: Q2 } as never);
  expect(ctx.runtime.conversations.get(ctx.convId).projectId).toBe(projectId);
  const rows = ctx.runtime.conversations.messages(ctx.convId);
  // 前提：两轮正好四条，用户 / 助手交替且都 complete。不成立时后面的断言没有意义。
  expect(rows.map((m) => [m.role, m.status])).toEqual([
    ['user', 'complete'],
    ['assistant', 'complete'],
    ['user', 'complete'],
    ['assistant', 'complete'],
  ]);
  expect(rows.map((m) => m.content)).toEqual([Q1, A1, Q2, A2]);
  ctx.seqs = rows.map((m) => m.seq);
  ctx.ids = rows.map((m) => m.id);
  ctx.contents = rows.map((m) => m.content);
}

type FromConvInput = {
  conversationId: string;
  fromMessageId: string;
  toMessageId: string;
  goal: string;
  acceptance: string[];
  scope?: string[];
  projectId?: string;
};

function fromConv(ctx: Ctx, input: FromConvInput): Promise<Record<string, unknown>> {
  return (
    ctx.runtime as never as {
      createTaskFromConversation: (i: FromConvInput) => Promise<Record<string, unknown>>;
    }
  ).createTaskFromConversation(input);
}

/** 这一轮（第 1 轮用户消息到第 2 轮助手消息）的标准参数。 */
const whole = (ctx: Ctx, patch: Partial<FromConvInput> = {}): FromConvInput => ({
  conversationId: ctx.convId,
  fromMessageId: ctx.ids[0]!,
  toMessageId: ctx.ids[3]!,
  goal: '做一个记账小程序',
  acceptance: ['记一笔能保存'],
  ...patch,
});

const count = (sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;
const taskCount = (): number => count('SELECT COUNT(*) AS n FROM coding_tasks');
const createdAudits = (): number =>
  count("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'conversation.task_created'");

function originRow(taskId: unknown): {
  project_id: string;
  origin_conversation_id: string | null;
  origin_from_seq: number | null;
  origin_to_seq: number | null;
} {
  return db
    .prepare(
      'SELECT project_id, origin_conversation_id, origin_from_seq, origin_to_seq FROM coding_tasks WHERE id = ?',
    )
    .get(taskId) as never;
}

/** 取 registerIpc 注册的某个 IPC 处理器。 */
function ipcHandler(runtime: AppRuntime, name: string): (...args: unknown[]) => Promise<unknown> {
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
  expect(entry, `IPC ixaeon:${name} 没注册`).toBeDefined();
  return (...args: unknown[]) =>
    (entry![1] as (e: unknown, ...a: unknown[]) => Promise<unknown>)({}, ...args);
}


describe('CF4 回归：范围、手建 IPC、事务', () => {
  it('显式 scope: [] 抛 VALIDATION_FAILED，什么都不建', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const before = taskCount();
    await expect(fromConv(ctx, whole(ctx, { scope: [] }))).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(taskCount()).toBe(before);
    expect(createdAudits()).toBe(0);
  });

  it('不传 scope 用 ["."]；传了就照用', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const a = await fromConv(ctx, whole(ctx));
    expect(a['scope_json']).toBe('["."]');
    const b = await fromConv(ctx, whole(ctx, { scope: ['src', 'docs'] }));
    expect(b['scope_json']).toBe('["src","docs"]');
  });

  it('手建 IPC createCodingTask 附带来源字段无效，也不留 conversation.task_created', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const create = ipcHandler(ctx.runtime, 'createCodingTask');
    const task = (await create({
      projectId: ctx.projectId,
      goal: '手建目标',
      scope: ['.'],
      allowedCommands: [],
      originConversationId: ctx.convId,
      originFromSeq: 1,
      originToSeq: 4,
    })) as { id: string };
    expect(originRow(task.id)).toEqual({
      project_id: ctx.projectId,
      origin_conversation_id: null,
      origin_from_seq: null,
      origin_to_seq: null,
    });
    expect(createdAudits()).toBe(0);
  });

  it('审计写入失败时任务也不留', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const before = taskCount();
    db.exec(
      "CREATE TRIGGER cf4_audit_fail BEFORE INSERT ON audit_events WHEN NEW.kind = 'conversation.task_created' BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    await expect(fromConv(ctx, whole(ctx))).rejects.toThrow();
    expect(taskCount()).toBe(before);
    db.exec('DROP TRIGGER cf4_audit_fail');
    await fromConv(ctx, whole(ctx));
    expect(taskCount()).toBe(before + 1);
  });
});
