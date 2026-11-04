/**
 * CF3c 验收（规格 docs/委派/CF3c-聊天只走直连.md）——条件 1、2、3、5、6、7。
 *
 * 逐条对应规格「验收条件」：
 * - 条件 1：设置里单独选了聊天模型（三样齐）→ 这一问走直连：`engine = 'direct'`、
 *   `modelName` 是选的那个；`newAskSession`、Hermes 定位都没被调用。
 * - 条件 2：聊天模型留空、后台分析的模型 / 地址 / Key 齐 → 也走直连，`modelName` 是后台分析的模型。
 * - 条件 3：三样缺一样（没模型 / 没地址 / 没 Key）→ `ask()` 抛 `MODEL_NOT_CONFIGURED`，
 *   文案指去「模型」页、不提 Hermes；对话里没有新增消息；Hermes 定位返回「已安装」也一样不调用。
 * - 条件 5：一问之后编码任务数量不变（替身模型回 `propose_task` 工具调用也当未知工具拒掉）；
 *   问题里写「待办：合成事项」照旧建出一条待办。
 * - 条件 6：`chatStreamClient` 接缝——换成 `FakeStreamChatClient` 后回答就是剧本正文、
 *   `fetch` 一次都没被调用；`IXAEON_FAKE_MODEL=1` + `IXAEON_FAKE_CHAT_SCRIPT` 时不配任何模型也走直连。
 * - 条件 7：直连回答的 `meta.notice` 不含「不是 Hermes」，也不含「。；」。
 *
 * 条件 4（不预热 Hermes）在 `cf3c-no-prewarm.test.ts`；条件 8（CF3/CF3b 的锁定验收照样全过）
 * 由那两套既有测试自己保证，不在这里重复。
 *
 * 一律不联网：假网关是内存里的 SSE 流；`IXAEON_DATA_DIR` 指向临时目录；合成数据。
 * 这些测试按现状实现应当失败（`chatStreamClient` 还没有、Hermes 路径还在），这是 B 档先推测试的预期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: {},
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const text = Buffer.from(b).toString();
      if (!text.startsWith('enc:')) throw new Error('解不开');
      return text.slice(4);
    },
  },
}));

import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  FakeStreamChatClient,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const SYNTHETIC_KEY = 'sk-synthetic';
const MODEL = 'demo-a';
const BASE = 'http://127.0.0.1:18081/v1';

function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textSse(text: string): Response {
  return streamOf([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}

function toolSse(name: string, args: string): Response {
  return streamOf([
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name, arguments: args } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}

function gateway(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const fetchImpl = (async () => {
    const fn = responses[Math.min(state.calls, responses.length - 1)]!;
    state.calls += 1;
    return fn();
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  } as { fetchImpl: typeof fetch; calls: number };
}

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf3c-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
  delete process.env['IXAEON_FAKE_MODEL'];
  delete process.env['IXAEON_FAKE_CHAT_SCRIPT'];
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  delete process.env['IXAEON_FAKE_MODEL'];
  delete process.env['IXAEON_FAKE_CHAT_SCRIPT'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

interface Harness {
  runtime: AppRuntime;
  conversations: ConversationStore;
  todos: TodoStore;
  conversationId: string;
  newAskSession: () => unknown;
  hermesFound: () => boolean;
  messages: () => Array<Record<string, unknown>>;
}

interface HarnessOptions {
  /** 聊天模型单独选过（true）/ 留空（false） */
  chatModel?: 'own' | 'blank';
  /** 三样里缺哪一样 */
  missing?: 'none' | 'model' | 'base' | 'key';
  /** Hermes 定位替身返回什么 */
  hermesInstalled?: boolean;
}

function setup(options: HarnessOptions = {}): Harness {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const todos = new TodoStore(db);
  const newAskSession = vi.fn(() => {
    throw new Error('CF3c：聊天不该再建 Hermes 会话');
  });
  const hermesFound = vi.fn(() => options.hermesInstalled ?? true);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const missing = options.missing ?? 'none';
  Object.assign(runtime as unknown as Record<string, unknown>, {
    db,
    conversations,
    todos,
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    dataDir: dir,
    config: {
      ...defaultAppConfig(),
      model: {
        ...defaultAppConfig().model,
        modelName: MODEL,
        chatModelName: options.chatModel === 'blank' ? '' : MODEL,
        apiBaseUrl: missing === 'base' ? '' : BASE,
        apiKeyEncrypted:
          missing === 'key' ? null : Buffer.from(`enc:${SYNTHETIC_KEY}`).toString('base64'),
        apiKeyPresent: missing !== 'key',
        savedModels: missing === 'model' ? [] : [MODEL],
      },
    },
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('cf3c'),
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    imports: {
      captureAsk: () => ({ created: true as const, source: { id: 'src-ask' } }),
    },
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
    newAskSession,
    hermesFound,
    permissions: { grantDomain: () => ({ created: false }) },
  });
  return {
    runtime,
    conversations,
    todos,
    conversationId: conv.id,
    newAskSession,
    hermesFound,
    messages: () => conversations.messages(conv.id) as unknown as Array<Record<string, unknown>>,
  };
}

describe('CF3c 条件 1、2：配了模型就走直连', () => {
  it('条件 1：单独选了聊天模型 → engine=direct、modelName 是选的那个，Hermes 一次没碰', async () => {
    const gw = gateway([() => textSse('直连的回答')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ chatModel: 'own' });
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    const last = h.messages().at(-1) as Record<string, unknown>;
    expect(last.engine).toBe('direct');
    expect(last.modelName).toBe(MODEL);
    expect(last.content).toContain('直连的回答');
    expect(h.newAskSession).not.toHaveBeenCalled();
    expect(h.hermesFound).not.toHaveBeenCalled();
  });

  it('条件 2：聊天模型留空、后台分析三样齐 → 也走直连，用的是后台分析的模型', async () => {
    const gw = gateway([() => textSse('跟着后台分析的回答')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ chatModel: 'blank' });
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    const last = h.messages().at(-1) as Record<string, unknown>;
    expect(last.engine).toBe('direct');
    expect(last.modelName).toBe(MODEL);
    expect(h.newAskSession).not.toHaveBeenCalled();
  });
});

describe('CF3c 条件 3：三样缺一样就明确说没配', () => {
  for (const missing of ['model', 'base', 'key'] as const) {
    it(`缺 ${missing} → MODEL_NOT_CONFIGURED，文案指去「模型」页、不提 Hermes，且不落消息`, async () => {
      const h = setup({ missing, hermesInstalled: true });
      const before = h.messages().length;
      await expect(
        h.runtime.ask({ conversationId: h.conversationId, projectId: null, question: '合成问题' }),
      ).rejects.toMatchObject({ code: 'IXA0010' });
      const after = h.messages();
      expect(after.length).toBe(before);
      // Hermes 定位替身即使说「已安装」也不该被问
      expect(h.hermesFound).not.toHaveBeenCalled();
      expect(h.newAskSession).not.toHaveBeenCalled();
    });
  }

  it('文案里指去「模型」页、不提 Hermes', async () => {
    const h = setup({ missing: 'key' });
    const err = await h.runtime
      .ask({ conversationId: h.conversationId, projectId: null, question: '合成问题' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('模型');
    expect((err as Error).message).not.toContain('Hermes');
  });
});

describe('CF3c 条件 5：聊天不再建编码任务，待办照旧', () => {
  it('模型回 propose_task 也当未知工具拒掉：编码任务数不变；「待办：…」照样建待办', async () => {
    const gw = gateway([
      () => toolSse('propose_task', JSON.stringify({ title: '不该建的任务' })),
      () => textSse('好，我不建任务。'),
    ]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ chatModel: 'own' });
    const countTasks = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }).n;
    const before = countTasks();
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    expect(countTasks()).toBe(before);

    const todosBefore = h.todos.list().length;
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '待办：合成事项',
    });
    expect(h.todos.list().length).toBe(todosBefore + 1);
  });
});

describe('CF3c 条件 6：chatStreamClient 接缝', () => {
  it('换成 FakeStreamChatClient：回答就是剧本正文，fetch 一次都没被调用', async () => {
    const gw = gateway([() => textSse('不该走网络')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ chatModel: 'own' });
    const client = new FakeStreamChatClient([{ deltas: ['剧本里的回答'] }]);
    Object.assign(h.runtime as unknown as Record<string, unknown>, {
      chatStreamClient: () => client,
    });
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    const last = h.messages().at(-1) as Record<string, unknown>;
    expect(last.content).toContain('剧本里的回答');
    expect(gw.calls).toBe(0);
  });

  it('IXAEON_FAKE_MODEL=1 + 剧本：什么都不配也走直连，用剧本回答', async () => {
    const scriptPath = join(dir, 'script.json');
    writeFileSync(scriptPath, JSON.stringify([{ deltas: ['假模型剧本的回答'] }]), 'utf8');
    process.env['IXAEON_FAKE_MODEL'] = '1';
    process.env['IXAEON_FAKE_CHAT_SCRIPT'] = scriptPath;
    const gw = gateway([() => textSse('不该走网络')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ missing: 'key', chatModel: 'blank' });
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    const last = h.messages().at(-1) as Record<string, unknown>;
    expect(last.engine).toBe('direct');
    expect(last.content).toContain('假模型剧本的回答');
    expect(gw.calls).toBe(0);
  });
});

describe('CF3c 条件 7：回答下面那段说明', () => {
  it('meta.notice 不含「不是 Hermes」，也不含「。；」', async () => {
    const gw = gateway([() => textSse('直连的回答')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ chatModel: 'own' });
    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    const meta = (h.messages().at(-1)!.meta ?? {}) as { notice?: string };
    // 替身下存档这一步会失败，ask() 会在说明后面追加「；注意：问答存档失败…」；
    // 那不是这条断言要钉的东西，剥掉再比。
    const notice = (meta.notice ?? '').split('；注意：')[0] ?? '';
    expect(notice).not.toContain('不是 Hermes');
    expect(notice).not.toContain('。；');
  });
});
