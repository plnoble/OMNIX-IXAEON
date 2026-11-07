/**
 * CF2 验收条件 1–6：聊天行为基线（普通聊天不建任务、不写待办、不碰 Git）。
 *
 * 固定合成问题集（原文写死，逐条与规格一致）：
 *  1「帮我制定一个完整的开发方案：做一个记账小程序」
 *  2「接下来我该做什么？」
 *  3「帮我把这段代码改成异步的：function load() { return readFileSync('a.txt'); }」
 *  4「我明天要去面试，帮我准备一下」
 *  5「帮我查一下 RTX 4090 的功耗」
 *  6「帮我把代码提交一下，git commit 写『修 bug』」
 *  7「记一下：我下周三要交报告」
 *  8「待办：周五前把发票寄出去」
 *
 * 条件 1：问题 1–7 一条待办、一个编码任务都不建；meta 无 proposedTodos；正文里「建议待办：」原样在。
 * 条件 2：问题 8 建且只建一条待办（标题「周五前把发票寄出去」、来源用户），编码任务不变。
 * 条件 3：直连聊天给模型的工具名正好是那五个。
 * 条件 4：清单外工具（propose_coding_task / git_commit）一律拒绝、不建东西、不起子进程。
 * 条件 5：已有 AI 提的旧待办（proposed）不动。
 * 条件 6：问题 1 照常存档，存的正文里带「建议待办：」。
 *
 * 整合方 11-07 改严：条件 1、6 断言整段回答原样（含「- 甲」「- 乙」两行），条件 4 断言回给模型的是「没有这个工具」。
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
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const cp = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => cp.spawn(...args),
    execFile: (...args: unknown[]) => cp.execFile(...args),
  };
});

const Q = [
  '帮我制定一个完整的开发方案：做一个记账小程序',
  '接下来我该做什么？',
  "帮我把这段代码改成异步的：function load() { return readFileSync('a.txt'); }",
  '我明天要去面试，帮我准备一下',
  '帮我查一下 RTX 4090 的功耗',
  '帮我把代码提交一下，git commit 写『修 bug』',
  '记一下：我下周三要交报告',
  '待办：周五前把发票寄出去',
];
const SUGGEST = '普通回答。\n建议待办：\n- 甲\n- 乙';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});
afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  vi.restoreAllMocks();
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

type StreamResult = {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string;
  toolsUnsupported?: boolean;
};

interface SeenCall {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ name: string }>;
}

/** 假直连客户端：按 step 决定这一轮返回什么，并记下收到的消息与工具清单。 */
function makeClient(
  model: string,
  step: (call: number, input: SeenCall) => StreamResult,
  calls: SeenCall[],
): { modelName: string; stream: (input: SeenCall) => Promise<StreamResult> } {
  let n = 0;
  return {
    modelName: model,
    async stream(input: SeenCall) {
      const call = n++;
      calls.push({
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: input.tools,
      });
      return step(call, input);
    },
  };
}

const answer = (text: string): StreamResult => ({
  content: text,
  toolCalls: [],
  finishReason: 'stop',
});

function fixture(clients: Record<string, unknown>): {
  runtime: AppRuntime;
  captureAsk: ReturnType<typeof vi.fn>;
} {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const captureAsk = vi.fn(() => ({ created: true as const, source: { id: 'src-ask' } }));
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const base = defaultAppConfig();
  const config = {
    ...base,
    model: { ...base.model, modelName: '', chatModelName: '' },
    providers: [],
    uses: {},
  } as AppConfig;
  Object.assign(runtime as unknown as Record<string, unknown>, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
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
    imports: { captureAsk },
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    permissions: { grantDomain: () => ({ created: false }) },
    chatStreamClient: (launch: { model: string }) => {
      const c = clients[launch.model];
      if (!c) throw new Error('没有为该模型准备假客户端：' + launch.model);
      return c;
    },
    __conversationId: conv.id,
    __messages: () => conversations.messages(conv.id),
    __captureAsk: captureAsk,
  });
  // 配一个可用的聊天主选（直连要三样齐）
  const p = runtime.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKey: 'sk-synthetic-a1b2c3d4',
    savedModels: ['demo-a'],
  });
  runtime.saveModelUses({ chat: { providerId: p.id, model: 'demo-a' } });
  return { runtime, captureAsk };
}

function cid(rt: AppRuntime): string {
  return (rt as unknown as { __conversationId: string }).__conversationId;
}
function msgs(rt: AppRuntime): Array<Record<string, unknown>> {
  return (rt as unknown as { __messages: () => Array<Record<string, unknown>> }).__messages();
}
async function ask(rt: AppRuntime, question: string): Promise<void> {
  await rt.ask({ conversationId: cid(rt), projectId: null, question } as never);
}
function counts(): { todos: number; tasks: number } {
  return {
    todos: (db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n,
    tasks: (db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }).n,
  };
}

describe('CF2 条件 1：问题 1–7 不建待办、不建任务，正文里那段原样在', () => {
  it('每问一句：待办/任务行数不变、meta 无 proposedTodos、正文含「建议待办：」', async () => {
    const calls: SeenCall[] = [];
    const { runtime } = fixture({ 'demo-a': makeClient('demo-a', () => answer(SUGGEST), calls) });
    for (const q of Q.slice(0, 7)) {
      const before = counts();
      await ask(runtime, q);
      const after = counts();
      expect(after.todos, q).toBe(before.todos);
      expect(after.tasks, q).toBe(before.tasks);
      const last = msgs(runtime).at(-1) as Record<string, unknown>;
      expect(last.role).toBe('assistant');
      expect(String(last.content)).toContain('建议待办：');
      // 整段原样：标题和下面的列表一行不少、一字不改
      expect(last.content, q).toBe(SUGGEST);
      const meta = (last.meta ?? {}) as Record<string, unknown>;
      expect(meta['proposedTodos']).toBeUndefined();
    }
  });
});

describe('CF2 条件 2：问题 8 建且只建一条用户待办', () => {
  it('标题「周五前把发票寄出去」、来源用户；编码任务不变', async () => {
    const calls: SeenCall[] = [];
    const { runtime } = fixture({ 'demo-a': makeClient('demo-a', () => answer(SUGGEST), calls) });
    const before = counts();
    await ask(runtime, Q[7]!);
    const after = counts();
    expect(after.tasks).toBe(before.tasks);
    expect(after.todos).toBe(before.todos + 1);
    const row = db.prepare('SELECT title, origin FROM todos ORDER BY rowid DESC LIMIT 1').get() as {
      title: string;
      origin: string;
    };
    expect(row.title).toBe('周五前把发票寄出去');
    expect(row.origin).toBe('user');
  });
});

describe('CF2 条件 3：工具清单是那五个', () => {
  it('名字正好 search_memory / search_web / read_web / get_evidence / get_project_context', async () => {
    const calls: SeenCall[] = [];
    const { runtime } = fixture({ 'demo-a': makeClient('demo-a', () => answer('好'), calls) });
    await ask(runtime, Q[1]!);
    const names = (calls[0]?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(
      ['get_evidence', 'get_project_context', 'read_web', 'search_memory', 'search_web'].sort(),
    );
  });
});

describe('CF2 条件 4：清单外工具一律拒绝、不建东西、不起子进程', () => {
  it('propose_coding_task / git_commit 被拒，随后正常完成', async () => {
    cp.spawn.mockClear();
    cp.execFile.mockClear();
    for (const [qIndex, tool] of [
      [0, 'propose_coding_task'],
      [5, 'git_commit'],
    ] as const) {
      const calls: SeenCall[] = [];
      const { runtime } = fixture({
        'demo-a': makeClient(
          'demo-a',
          (n) =>
            n === 0
              ? {
                  content: '',
                  toolCalls: [{ id: 't1', name: tool, arguments: '{}' }],
                  finishReason: 'tool_calls',
                }
              : answer('普通回答'),
          calls,
        ),
      });
      const before = counts();
      await ask(runtime, Q[qIndex]!);
      const after = counts();
      expect(after.todos).toBe(before.todos);
      expect(after.tasks).toBe(before.tasks);
      // 第二轮请求里应能看到拒绝内容（工具结果作为消息回给模型）
      const second = calls[1]!;
      expect(second.messages.some((m) => m.content.includes('清单'))).toBe(true);
      // 规格：回给模型的内容里写明「没有这个工具」，并点出是哪个工具名
      expect(
        second.messages.some((m) => m.content.includes('没有这个工具') && m.content.includes(tool)),
      ).toBe(true);
      const last = msgs(runtime).at(-1) as Record<string, unknown>;
      expect(last.status).toBe('complete');
      expect(String(last.content)).toContain('普通回答');
    }
    expect(cp.spawn).not.toHaveBeenCalled();
    expect(cp.execFile).not.toHaveBeenCalled();
  });
});

describe('CF2 条件 5：已有的 AI 旧待办不动', () => {
  it('状态 proposed、来源 AI 的旧待办，问完 8 句后状态/标题/更新时间都没变', async () => {
    // 标题跟替身回答里「建议待办」的两条（甲、乙）不同；用 TodoStore 之外的直写，免得依赖 propose 的去重
    const old = {
      id: 'old-1',
      title: '旧的 AI 待办',
      origin: 'agent',
      status: 'proposed',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    db.prepare(
      `INSERT INTO todos (id, title, origin, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(old.id, old.title, old.origin, old.status, old.updated_at, old.updated_at);
    const calls: SeenCall[] = [];
    const { runtime } = fixture({ 'demo-a': makeClient('demo-a', () => answer(SUGGEST), calls) });
    for (const q of Q) await ask(runtime, q);
    const row = db
      .prepare('SELECT title, origin, status, updated_at FROM todos WHERE id = ?')
      .get(old.id) as {
      title: string;
      origin: string;
      status: string;
      updated_at: string;
    };
    expect(row).toEqual({
      title: old.title,
      origin: old.origin,
      status: old.status,
      updated_at: old.updated_at,
    });
    // 问题 1–8 里只有第 8 句建了一条（用户的），别的一条都没有
    const all = db.prepare('SELECT origin FROM todos WHERE id <> ?').all(old.id) as Array<{
      origin: string;
    }>;
    expect(all).toEqual([{ origin: 'user' }]);
  });
});

describe('CF2 条件 6：存档照旧，正文里带着「建议待办：」', () => {
  it('问题 1 那一轮 captureAsk 被调，存的正文含「建议待办：」', async () => {
    const calls: SeenCall[] = [];
    const { runtime, captureAsk } = fixture({
      'demo-a': makeClient('demo-a', () => answer(SUGGEST), calls),
    });
    await ask(runtime, Q[0]!);
    expect(captureAsk).toHaveBeenCalled();
    expect(JSON.stringify(captureAsk.mock.calls)).toContain('建议待办：');
    // 交给存档的回答就是整段原样（不拆、不截）
    const arg = captureAsk.mock.calls[0]![0] as unknown as { question: string; answer: string };
    expect(arg.question).toBe(Q[0]);
    expect(arg.answer).toBe(SUGGEST);
    const last = msgs(runtime).at(-1) as Record<string, unknown>;
    expect(String(last.content)).toContain('建议待办：');
    expect(last.content).toBe(SUGGEST);
  });
});
