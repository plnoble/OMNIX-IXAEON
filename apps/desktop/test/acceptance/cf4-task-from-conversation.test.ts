/**
 * CF4 验收条件 1–9（主进程侧）：用户点一下把一段聊天转成编码任务草案。规格 docs/委派/CF4-讨论转任务.md。
 *
 * 1. 建出来的任务记着来源（draft、origin_conversation_id、from/to seq、origin_run_id null、
 *    allowed_commands_json '[]'、acceptance_json 就是传入的）；coding_approvals 不变、执行器替身 0 次。
 * 2. 原消息不动（content/status/meta_json/updated_at 逐条相同；对话 archived_at 仍为 null）。
 * 3. 校验：消息不属于本对话（用另一个对话的消息 id）、开始 seq > 结束、结束是用户消息或 failed/streaming
 *    的助手消息、目标为空或超过 2000 字、验收条件 0 条 / 9 条 / 某条超过 200 字、个人视角没给项目、
 *    项目没绑文件夹（文案跟任务页批准时那句一样）—— 都抛 VALIDATION_FAILED，coding_tasks 行数不变。
 * 4. 对话属于项目甲时传项目乙，任务的 project_id 是项目甲。
 * 5. 个人视角对话传项目甲（已绑文件夹），任务的 project_id 是项目甲。
 * 6. audit_events 多一行 conversation.task_created，详情 { taskId, conversationId, messageCount: 4 }，
 *    不含目标原文、不含任何一条消息的正文。
 * 7. 删掉对话后任务还在，origin_conversation_id 为 null，两个 seq 不变。
 * 8. 任务页手建的（IPC createCodingTask）三列都是 null。
 * 9. 派发转出来的任务（假执行器），交给执行器的内容里不含两轮对话的任何一句正文（含「合成暗号：蓝鲸七号」）。
 * 另：规格「要什么」3、5 写死的 IPC createTaskFromConversation / listConversationTasks 要注册，
 *     同一段再转一次会多建一条。
 *
 * 替补整合方 2026-11-05 锁定前改严：校验错误码用 ErrorCodes（原来比的是字面量 'VALIDATION_FAILED'，
 * 真实现永远过不了）；条件 3 补齐规格列的每一种；条件 8 走任务页那条 IPC；条件 9 原来调一个不存在的
 * 方法、读一个不存在的字段，什么都不派发也会过，改成真批准、真派发、记下执行器收到的每一次调用。
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

  const project = projects.create({ name: '合成项目甲' });
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

describe('CF4 条件 1：建出来记着来源，draft、不派发', () => {
  it('origin 三列、origin_run_id null、allowed_commands_json []、acceptance 原样；没批准、执行器 0 次', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const before = taskCount();
    const approvalsBefore = count('SELECT COUNT(*) AS n FROM coding_approvals');
    const task = await fromConv(ctx, whole(ctx, { acceptance: ['记一笔能保存', '列表能看到'] }));
    expect(task['status']).toBe('draft');
    expect(task['origin_conversation_id']).toBe(ctx.convId);
    expect(task['origin_from_seq']).toBe(ctx.seqs[0]);
    expect(task['origin_to_seq']).toBe(ctx.seqs[3]);
    // CodingTask 类型里没有 origin_run_id（规格只加三个字段）：返回值上有就得是 null，库里那一行下面严格查。
    expect(task['origin_run_id'] ?? null).toBeNull();
    expect(task['allowed_commands_json']).toBe('[]');
    expect(task['acceptance_json']).toBe(JSON.stringify(['记一笔能保存', '列表能看到']));
    expect(task['scope_json']).toBe(JSON.stringify(['.']));
    // 库里那一行也是这样（不是只在返回值上拼出来的）
    const row = db
      .prepare(
        'SELECT status, origin_conversation_id, origin_from_seq, origin_to_seq, origin_run_id, allowed_commands_json, acceptance_json FROM coding_tasks WHERE id = ?',
      )
      .get(task['id']);
    expect(row).toEqual({
      status: 'draft',
      origin_conversation_id: ctx.convId,
      origin_from_seq: ctx.seqs[0],
      origin_to_seq: ctx.seqs[3],
      origin_run_id: null,
      allowed_commands_json: '[]',
      acceptance_json: JSON.stringify(['记一笔能保存', '列表能看到']),
    });
    expect(taskCount()).toBe(before + 1);
    expect(count('SELECT COUNT(*) AS n FROM coding_approvals')).toBe(approvalsBefore);
    expect(ctx.seen.length).toBe(0);
  });

  it('IPC createTaskFromConversation / listConversationTasks 已注册；同一段再转一次多建一条', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const other = ctx.runtime.conversations.create({ projectId: ctx.projectId });
    const create = ipcHandler(ctx.runtime, 'createTaskFromConversation');
    const list = ipcHandler(ctx.runtime, 'listConversationTasks');
    const a = (await create(whole(ctx))) as { id: string };
    const b = (await create(whole(ctx))) as { id: string };
    expect(a.id).not.toBe(b.id);
    const listed = (await list(ctx.convId)) as Array<{ id: string; origin_to_seq: number }>;
    expect(listed.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(listed.every((t) => t.origin_to_seq === ctx.seqs[3])).toBe(true);
    expect(await list(other.id)).toEqual([]);
  });
});

describe('CF4 条件 2：原消息不动', () => {
  it('建前后消息逐条 content/status/meta_json/updated_at 相同，对话未归档', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const snap = () =>
      db
        .prepare(
          'SELECT id, content, status, meta_json, updated_at FROM messages WHERE conversation_id = ? ORDER BY seq',
        )
        .all(ctx.convId);
    const before = snap();
    await fromConv(ctx, whole(ctx));
    expect(snap()).toEqual(before);
    const conv = db
      .prepare('SELECT archived_at FROM conversations WHERE id = ?')
      .get(ctx.convId) as { archived_at: string | null } | undefined;
    expect(conv).toBeDefined();
    expect(conv!.archived_at).toBeNull();
  });
});

describe('CF4 条件 3：校验不通过就什么都不建', () => {
  type Case = {
    name: string;
    personal?: boolean;
    input: (c: Ctx) => FromConvInput;
  };
  const otherConversationMessages = (c: Ctx): { user: string; assistant: string } => {
    const other = c.runtime.conversations.create({ projectId: c.projectId });
    const user = c.runtime.conversations.appendMessage(other.id, {
      role: 'user',
      content: '另一个对话的合成问题',
    });
    const assistant = c.runtime.conversations.appendMessage(other.id, {
      role: 'assistant',
      content: '另一个对话的合成回答',
      status: 'complete',
    });
    return { user: user.id, assistant: assistant.id };
  };
  const cases: Case[] = [
    {
      name: '结束那条是另一个对话的消息',
      input: (c) => whole(c, { toMessageId: otherConversationMessages(c).assistant }),
    },
    {
      name: '开始那条是另一个对话的消息',
      input: (c) => whole(c, { fromMessageId: otherConversationMessages(c).user }),
    },
    { name: '消息不存在', input: (c) => whole(c, { fromMessageId: 'no-such-message' }) },
    {
      name: '开始 seq 大于结束（结束是 complete 助手消息）',
      input: (c) => whole(c, { fromMessageId: c.ids[2]!, toMessageId: c.ids[1]! }),
    },
    { name: '结束是用户消息', input: (c) => whole(c, { toMessageId: c.ids[2]! }) },
    {
      name: '结束是 failed 的助手消息',
      input: (c) => {
        const m = c.runtime.conversations.appendMessage(c.convId, {
          role: 'assistant',
          content: '合成的半截回答',
          status: 'failed',
          errorMessage: '合成失败',
        });
        return whole(c, { toMessageId: m.id });
      },
    },
    {
      name: '结束是 streaming 的助手消息',
      input: (c) => {
        const m = c.runtime.conversations.appendMessage(c.convId, {
          role: 'assistant',
          content: '',
          status: 'streaming',
        });
        return whole(c, { toMessageId: m.id });
      },
    },
    { name: '目标为空', input: (c) => whole(c, { goal: '' }) },
    { name: '目标只有空白', input: (c) => whole(c, { goal: '   ' }) },
    { name: '目标超过 2000 字', input: (c) => whole(c, { goal: '甲'.repeat(2001) }) },
    { name: '验收条件 0 条', input: (c) => whole(c, { acceptance: [] }) },
    {
      name: '验收条件 9 条',
      input: (c) => whole(c, { acceptance: Array.from({ length: 9 }, (_, i) => `条件${i + 1}`) }),
    },
    {
      name: '某条验收条件超过 200 字',
      input: (c) => whole(c, { acceptance: ['正常的一条', '乙'.repeat(201)] }),
    },
    { name: '某条验收条件是空白', input: (c) => whole(c, { acceptance: ['正常的一条', '  '] }) },
    { name: '个人视角的对话没传 projectId', personal: true, input: (c) => whole(c) },
    {
      name: '个人视角的对话传了不存在的项目',
      personal: true,
      input: (c) => whole(c, { projectId: '00000000-0000-4000-8000-000000000000' }),
    },
  ];
  for (const k of cases) {
    it(`${k.name} → VALIDATION_FAILED，任务行数不变，不留痕`, async () => {
      const ctx = fixture({ personal: k.personal });
      await chatTwoTurns(ctx);
      const input = k.input(ctx);
      const before = taskCount();
      await expect(fromConv(ctx, input)).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION_FAILED,
      });
      expect(taskCount()).toBe(before);
      expect(createdAudits()).toBe(0);
    });
  }

  it('项目没绑文件夹 → VALIDATION_FAILED，文案跟任务页批准时那句一样', async () => {
    const ctx = fixture({ personal: true });
    await chatTwoTurns(ctx);
    const unbound = ctx.runtime.projects.create({ name: '合成项目乙' });
    // 任务页批准时的那句：拿一条乙的草案去批准
    const probe = ctx.runtime.coding.create({
      projectId: unbound.id,
      goal: '合成探针任务',
      scope: ['.'],
      allowedCommands: [],
    });
    const approveErr = await ctx.runtime.approveCodingTask(probe.id).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(approveErr).not.toBeNull();
    const before = taskCount();
    const err = await fromConv(ctx, whole(ctx, { projectId: unbound.id })).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err).not.toBeNull();
    expect(err!.code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(err!.message).toBe(approveErr!.message);
    expect(taskCount()).toBe(before);
    expect(createdAudits()).toBe(0);
  });

  it('边界值照收：目标正好 2000 字、验收条件正好 8 条且每条 200 字', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const acceptance = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(200, '丙'));
    const task = await fromConv(ctx, whole(ctx, { goal: '丁'.repeat(2000), acceptance }));
    expect(task['status']).toBe('draft');
    expect(task['acceptance_json']).toBe(JSON.stringify(acceptance));
  });
});

describe('CF4 条件 4、5：项目归属', () => {
  it('对话属于项目甲时传项目乙也不认', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const other = ctx.runtime.projects.create({ name: '合成项目乙' });
    const task = await fromConv(ctx, whole(ctx, { projectId: other.id }));
    expect(task['project_id']).toBe(ctx.projectId);
    expect(originRow(task['id']).project_id).toBe(ctx.projectId);
  });

  it('个人视角对话传项目甲就用甲', async () => {
    const ctx = fixture({ personal: true });
    await chatTwoTurns(ctx);
    const task = await fromConv(ctx, whole(ctx, { projectId: ctx.projectId }));
    expect(task['project_id']).toBe(ctx.projectId);
    expect(originRow(task['id']).project_id).toBe(ctx.projectId);
    expect(originRow(task['id']).origin_conversation_id).toBe(ctx.convId);
  });
});

describe('CF4 条件 6：留痕不含正文', () => {
  it('audit 多一行 conversation.task_created，详情只有 taskId / conversationId / messageCount', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const goal = '合成目标：记账小程序第一版';
    const before = count('SELECT COUNT(*) AS n FROM audit_events');
    const task = await fromConv(ctx, whole(ctx, { goal }));
    expect(count('SELECT COUNT(*) AS n FROM audit_events')).toBe(before + 1);
    expect(createdAudits()).toBe(1);
    const row = db
      .prepare(
        "SELECT detail_json FROM audit_events WHERE kind = 'conversation.task_created' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { detail_json: string };
    expect(JSON.parse(row.detail_json)).toEqual({
      taskId: task['id'],
      conversationId: ctx.convId,
      messageCount: 4,
    });
    expect(row.detail_json).not.toContain(goal);
    for (const c of ctx.contents) expect(row.detail_json).not.toContain(c);
  });

  it('范围只有一轮时 messageCount 是 2', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    await fromConv(ctx, whole(ctx, { fromMessageId: ctx.ids[2]! }));
    const row = db
      .prepare(
        "SELECT detail_json FROM audit_events WHERE kind = 'conversation.task_created' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { detail_json: string };
    expect(JSON.parse(row.detail_json).messageCount).toBe(2);
  });
});

describe('CF4 条件 7：对话删了来源置空，任务还在', () => {
  it('origin_conversation_id 变 null，seq 不变', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const task = await fromConv(ctx, whole(ctx));
    ctx.runtime.conversations.delete(ctx.convId);
    expect(count('SELECT COUNT(*) AS n FROM conversations WHERE id = ?', ctx.convId)).toBe(0);
    const still = ctx.runtime.coding.store.get(String(task['id']));
    expect(still.id).toBe(task['id']);
    expect(still.status).toBe('draft');
    const row = originRow(task['id']);
    expect(row.origin_conversation_id).toBeNull();
    expect(row.origin_from_seq).toBe(ctx.seqs[0]);
    expect(row.origin_to_seq).toBe(ctx.seqs[3]);
  });
});

describe('CF4 条件 8：任务页手建的三列为 null', () => {
  it('任务页那条 IPC createCodingTask 建出来的没有来源', async () => {
    const ctx = fixture();
    const create = ipcHandler(ctx.runtime, 'createCodingTask');
    const task = (await create({
      projectId: ctx.projectId,
      goal: '手建目标',
      scope: ['.'],
      allowedCommands: [['node', 'check.mjs']],
    })) as { id: string };
    expect(originRow(task.id)).toEqual({
      project_id: ctx.projectId,
      origin_conversation_id: null,
      origin_from_seq: null,
      origin_to_seq: null,
    });
  });
});

describe('CF4 条件 9：执行器拿不到聊天原文', () => {
  it('批准并派发转出来的任务，执行器每次收到的内容里都没有对话正文', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const task = await fromConv(
      ctx,
      whole(ctx, { goal: '做一个记账小程序', acceptance: ['记一笔能保存'] }),
    );
    const id = String(task['id']);
    await ctx.runtime.approveCodingTask(id);
    await ctx.runtime.coding.dispatch(id);
    // 真派发到了执行器（不是什么都没跑就空过）
    expect(ctx.seen.length).toBeGreaterThan(0);
    const blob = JSON.stringify(ctx.seen);
    expect(blob).toContain('做一个记账小程序');
    expect(blob).toContain('记一笔能保存');
    expect(blob).not.toContain('蓝鲸七号');
    for (const c of ctx.contents) expect(blob).not.toContain(c);
  });
});
