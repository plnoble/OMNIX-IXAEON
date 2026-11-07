/**
 * CF4 验收条件 1–9（core / 主进程侧）：用户点一下把一段聊天转成编码任务草案。
 *
 * 1. 建出来的任务记着来源（draft、origin_conversation_id、from/to seq、origin_run_id null、
 *    allowed_commands_json '[]'、acceptance_json 就是传入的）；没批准、没派发。
 * 2. 原消息不动（content/status/meta_json/updated_at 逐条相同；对话未归档）。
 * 3. 校验：不属于本对话、开始 seq > 结束、结束不是 complete 助手、目标/验收条件长度、
 *    个人视角没给项目、项目没绑文件夹 —— 都抛 VALIDATION_FAILED，任务行数不变。
 * 4. 项目以对话为准。
 * 5. 个人视角对话传了 projectId 就用它。
 * 6. 留痕 conversation.task_created 不含正文。
 * 7. 对话删了：origin_conversation_id 变 null，seq 不变，任务还在。
 * 8. 任务页手建的三列为 null。
 * 9. 执行器拿不到聊天原文。
 *
 * 现在实现还没写（createTaskFromConversation / listConversationTasks 不存在），本文件应当红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
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
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

let dir: string;
let db: CoreDatabase;
let folder: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf4-'));
  folder = mkdtempSync(join(tmpdir(), 'ixaeon-cf4-folder-'));
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

interface Ctx {
  runtime: AppRuntime;
  convId: string;
  seqs: number[];
  ids: string[];
  executor: FakeCodingExecutor;
}

function fixture(opts: { projectOfConversation?: boolean } = {}): Ctx {
  const conversations = new ConversationStore(db);
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const executor = new FakeCodingExecutor();
  const base = defaultAppConfig();
  const config = {
    ...base,
    model: { ...base.model, modelName: '', chatModelName: '' },
    providers: [],
    uses: {},
  } as AppConfig;
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
      stream: async () => ({ content: '回答', toolCalls: [], finishReason: 'stop' }),
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
  const conv = conversations.create({
    projectId: opts.projectOfConversation === false ? null : project.id,
  });
  return { runtime, convId: conv.id, seqs: [], ids: [], executor };
}

async function chatTwoTurns(
  ctx: Ctx,
  q1 = '合成暗号：蓝鲸七号',
  q2 = '那先做记一笔这页',
): Promise<void> {
  await ctx.runtime.ask({ conversationId: ctx.convId, projectId: null, question: q1 } as never);
  await ctx.runtime.ask({ conversationId: ctx.convId, projectId: null, question: q2 } as never);
  const rows = ctx.runtime.conversations.messages(ctx.convId);
  ctx.seqs = rows.map((m) => m.seq);
  ctx.ids = rows.map((m) => m.id);
}

function taskCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }).n;
}

describe('CF4 条件 1：建出来记着来源，draft、不派发', () => {
  it('origin 三列、origin_run_id null、allowed_commands_json []、acceptance 原样', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const before = taskCount();
    const task = await (
      ctx.runtime as never as {
        createTaskFromConversation: (i: unknown) => Promise<Record<string, unknown>>;
      }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '做一个记账小程序',
      acceptance: ['记一笔能保存', '列表能看到'],
    });
    expect(task['status']).toBe('draft');
    expect(task['origin_conversation_id']).toBe(ctx.convId);
    expect(task['origin_from_seq']).toBe(ctx.seqs[0]);
    expect(task['origin_to_seq']).toBe(ctx.seqs[3]);
    expect(task['origin_run_id']).toBeNull();
    expect(task['allowed_commands_json']).toBe('[]');
    expect(task['acceptance_json']).toBe(JSON.stringify(['记一笔能保存', '列表能看到']));
    expect(taskCount()).toBe(before + 1);
    const approvals = (
      db.prepare('SELECT COUNT(*) AS n FROM coding_approvals').get() as { n: number }
    ).n;
    expect(approvals).toBe(0);
  });
});

describe('CF4 条件 2：原消息不动', () => {
  it('建前后消息逐条 content/status/meta_json/updated_at 相同，对话未归档', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const snap = () =>
      db
        .prepare(
          'SELECT content, status, meta_json, updated_at FROM messages WHERE conversation_id = ? ORDER BY seq',
        )
        .all(ctx.convId);
    const before = snap();
    await (
      ctx.runtime as never as { createTaskFromConversation: (i: unknown) => Promise<unknown> }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '目标',
      acceptance: ['一条'],
    });
    expect(snap()).toEqual(before);
    const conv = db
      .prepare('SELECT archived_at FROM conversations WHERE id = ?')
      .get(ctx.convId) as {
      archived_at: string | null;
    };
    expect(conv.archived_at).toBeNull();
  });
});

describe('CF4 条件 3：校验不通过就什么都不建', () => {
  const cases: Array<[string, (c: Ctx) => unknown]> = [
    [
      '消息不属于这个对话',
      (c) => ({
        conversationId: c.convId,
        fromMessageId: 'other-1',
        toMessageId: c.ids[3],
        goal: '目标',
        acceptance: ['一条'],
      }),
    ],
    [
      '开始 seq 大于结束',
      (c) => ({
        conversationId: c.convId,
        fromMessageId: c.ids[3],
        toMessageId: c.ids[0],
        goal: '目标',
        acceptance: ['一条'],
      }),
    ],
    [
      '结束是用户消息',
      (c) => ({
        conversationId: c.convId,
        fromMessageId: c.ids[0],
        toMessageId: c.ids[2],
        goal: '目标',
        acceptance: ['一条'],
      }),
    ],
    [
      '目标为空',
      (c) => ({
        conversationId: c.convId,
        fromMessageId: c.ids[0],
        toMessageId: c.ids[3],
        goal: '   ',
        acceptance: ['一条'],
      }),
    ],
    [
      '验收条件 0 条',
      (c) => ({
        conversationId: c.convId,
        fromMessageId: c.ids[0],
        toMessageId: c.ids[3],
        goal: '目标',
        acceptance: [],
      }),
    ],
  ];
  for (const [name, input] of cases) {
    it(`${name} → VALIDATION_FAILED，任务行数不变`, async () => {
      const ctx = fixture();
      await chatTwoTurns(ctx);
      const before = taskCount();
      await expect(
        (
          ctx.runtime as never as { createTaskFromConversation: (i: unknown) => Promise<unknown> }
        ).createTaskFromConversation(input(ctx)),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(taskCount()).toBe(before);
    });
  }
});

describe('CF4 条件 4、5：项目归属', () => {
  it('对话属于项目甲时传项目乙也不认', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const other = ctx.runtime.projects.create({ name: '合成项目乙' });
    const task = (await (
      ctx.runtime as never as {
        createTaskFromConversation: (i: unknown) => Promise<Record<string, unknown>>;
      }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '目标',
      acceptance: ['一条'],
      projectId: other.id,
    })) as Record<string, unknown>;
    expect(task['project_id']).toBe(
      (
        db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(ctx.convId) as {
          project_id: string;
        }
      ).project_id,
    );
  });

  it('个人视角对话传项目甲就用甲', async () => {
    const ctx = fixture({ projectOfConversation: false });
    await chatTwoTurns(ctx);
    const p = ctx.runtime.projects.list()[0]!;
    const task = (await (
      ctx.runtime as never as {
        createTaskFromConversation: (i: unknown) => Promise<Record<string, unknown>>;
      }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '目标',
      acceptance: ['一条'],
      projectId: p.id,
    })) as Record<string, unknown>;
    expect(task['project_id']).toBe(p.id);
  });
});

describe('CF4 条件 6：留痕不含正文', () => {
  it('audit 多一行 conversation.task_created，详情只有 id 与条数', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    const task = (await (
      ctx.runtime as never as {
        createTaskFromConversation: (i: unknown) => Promise<Record<string, unknown>>;
      }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '目标',
      acceptance: ['一条'],
    })) as Record<string, unknown>;
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n).toBe(
      before + 1,
    );
    const row = db
      .prepare(
        "SELECT detail_json FROM audit_events WHERE kind = 'conversation.task_created' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { detail_json: string } | undefined;
    expect(row).toBeTruthy();
    const detail = row!.detail_json;
    expect(detail).toContain(String(task['id']));
    expect(detail).toContain('"messageCount":4');
    expect(detail).not.toContain('合成暗号');
    expect(detail).not.toContain('目标');
  });
});

describe('CF4 条件 7：对话删了来源置空，任务还在', () => {
  it('origin_conversation_id 变 null，seq 不变', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const task = (await (
      ctx.runtime as never as {
        createTaskFromConversation: (i: unknown) => Promise<Record<string, unknown>>;
      }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '目标',
      acceptance: ['一条'],
    })) as Record<string, unknown>;
    db.prepare('DELETE FROM conversations WHERE id = ?').run(ctx.convId);
    const row = db
      .prepare(
        'SELECT origin_conversation_id, origin_from_seq, origin_to_seq FROM coding_tasks WHERE id = ?',
      )
      .get(task['id']) as {
      origin_conversation_id: string | null;
      origin_from_seq: number;
      origin_to_seq: number;
    };
    expect(row.origin_conversation_id).toBeNull();
    expect(row.origin_from_seq).toBe(ctx.seqs[0]);
    expect(row.origin_to_seq).toBe(ctx.seqs[3]);
  });
});

describe('CF4 条件 8：任务页手建的三列为 null', () => {
  it('createCodingTask 建出来的没有来源', async () => {
    const ctx = fixture();
    const p = ctx.runtime.projects.list()[0]!;
    const task = (await (
      ctx.runtime as never as { createCodingTask: (i: unknown) => Promise<Record<string, unknown>> }
    ).createCodingTask({
      projectId: p.id,
      goal: '手建目标',
      scope: ['.'],
      acceptance: ['一条'],
    })) as Record<string, unknown>;
    const row = db
      .prepare(
        'SELECT origin_conversation_id, origin_from_seq, origin_to_seq FROM coding_tasks WHERE id = ?',
      )
      .get(task['id']) as Record<string, unknown>;
    expect(row['origin_conversation_id']).toBeNull();
    expect(row['origin_from_seq']).toBeNull();
    expect(row['origin_to_seq']).toBeNull();
  });
});

describe('CF4 条件 9：执行器拿不到聊天原文', () => {
  it('派发转出来的任务，执行器收到的内容里没有对话正文', async () => {
    const ctx = fixture();
    await chatTwoTurns(ctx);
    const task = (await (
      ctx.runtime as never as {
        createTaskFromConversation: (i: unknown) => Promise<Record<string, unknown>>;
      }
    ).createTaskFromConversation({
      conversationId: ctx.convId,
      fromMessageId: ctx.ids[0],
      toMessageId: ctx.ids[3],
      goal: '做一个记账小程序',
      acceptance: ['记一笔能保存'],
    })) as Record<string, unknown>;
    await (
      ctx.runtime as never as { approveAndRunTask?: (id: string) => Promise<unknown> }
    ).approveAndRunTask?.(String(task['id']));
    const seen = JSON.stringify(ctx.executor.calls ?? []);
    expect(seen).not.toContain('合成暗号');
  });
});
