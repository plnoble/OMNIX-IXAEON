/**
 * CF3b 验收（桌面运行时，规格 docs/委派/CF3-直连模型做聊天主引擎.md）——条件 10–17。
 *
 * 逐条对应规格「验收条件」：
 * - 条件 10：配好聊天模型 → 一问走直连：消息 engine='direct'、modelName 是配的那个；
 *   没有启动 Hermes（替身 locator/newAskSession 断言没被调用）；runtime_runs 有一行 direct/succeeded。
 * - 条件 11：模型调 search_memory → 结果来自和记忆桥同一个方法
 *   （合成库里一条个人记忆 + 开着「个人记忆给聊天用」→ 能查到；关掉且没逐条分享 → 查不到）。
 * - 条件 12：search_web 没配搜索服务 → 工具结果「联网搜索没有配置…」、回答照常完成；
 *   配了替身搜索服务 → 查询先过 sanitizePublicQuery（合成邮箱被替换掉）。
 * - 条件 13：模型调 propose_task / record_observation（不在工具清单里）→ 不执行，
 *   作为失败的工具结果交回模型，coding_tasks、items 没有多出东西。
 * - 条件 14：回答完成后问答存档建好、排了提炼；消息 meta 的 memoryUsed 含工具查到的那条；
 *   提炼时 injectedMemoryByTurn 认得出这条 direct 回答。
 * - 条件 15：假网关回 503「No available channel for model demo-a」→ 消息 failed，
 *   说明和 CF0 一样（含「换一个模型」），没有再走 Hermes 或 Core 有界循环。
 * - 条件 16：用户中途取消 → 消息 cancelled，已经答出的半截还在。
 * - 条件 17：聊天模型没配（三样缺一样）→ 走现在的路径，原有行为不受影响。
 *
 * 一律不联网：假网关是内存里的 SSE 流；`IXAEON_DATA_DIR` 指向临时目录；合成数据。
 * 这些测试按现状实现应失败（直连路径还没写），这是 B 档「先只推测试」的预期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

import {
  CodingOrchestrator,
  ConversationStore,
  Extractor,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  setPersonalMemoryToChat,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const SYNTHETIC_KEY = 'sk-synthetic';
const MODEL = 'demo-a';

/** 把若干块按顺序交给读取方（服务端推送被拆开也照样能拼）。 */
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

interface GatewayCall {
  body: Record<string, unknown>;
}

/** 假 OpenAI 兼容网关：按顺序吐出预先写好的响应，并记下每次请求体。 */
function gateway(responses: Array<() => Response>): {
  fetchImpl: typeof fetch;
  calls: GatewayCall[];
} {
  const calls: GatewayCall[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const make = responses[Math.min(i, responses.length - 1)] ?? (() => textSse('兜底'));
    i += 1;
    return make();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf3b-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  // IXAEON_DATA_DIR 指向临时目录（规格要求；本测试也不许落到真实数据目录）
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

interface Harness {
  runtime: AppRuntime;
  conversations: ConversationStore;
  conversationId: string;
  captureAsk: ReturnType<typeof vi.fn>;
  enqueueExtract: ReturnType<typeof vi.fn>;
  newAskSession: ReturnType<typeof vi.fn>;
  hermesFound: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  /** 三样齐（true）还是没配聊天模型（false） */
  chatConfigured?: boolean;
  webSearch?: { provider: string; search: (q: string, limit?: number) => Promise<unknown> } | null;
}

function setup(options: HarnessOptions = {}): Harness {
  const chatConfigured = options.chatConfigured ?? true;
  const projects = new ProjectService(db);
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  conversations.appendMessage(conv.id, { role: 'user', content: '之前问的' });
  conversations.appendMessage(conv.id, { role: 'assistant', content: '之前答的' });

  const captureAsk = vi.fn(() => ({ created: true as const, source: { id: 'src-ask' } }));
  const enqueueExtract = vi.fn(() => undefined);

  // 替身 Hermes 会话：直连路径下不该被用到
  const fakeSession = {
    run: async () => ({
      answer: '这条来自 Hermes 替身，不该出现',
      citations: [],
      notice: '替身会话',
      usedChars: 0,
      modelName: MODEL,
      engine: 'hermes' as const,
      runId: 'run-hermes',
      steps: [],
      memoryUsed: [],
    }),
    cancel: () => undefined,
    getEngineSessionId: () => 's-hermes',
  };

  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const newAskSession = vi.fn(() => ({ session: fakeSession, adapter: {} }));
  const hermesFound = vi.fn(() => true);

  Object.assign(runtime as unknown as Record<string, unknown>, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    dataDir: dir,
    config: {
      ...defaultAppConfig(),
      model: {
        ...defaultAppConfig().model,
        modelName: MODEL,
        chatModelName: chatConfigured ? MODEL : null,
        apiBaseUrl: 'http://127.0.0.1:9/v1',
        apiKeyEncrypted: Buffer.from(`enc:${SYNTHETIC_KEY}`).toString('base64'),
        apiKeyPresent: true,
        savedModels: [MODEL],
      },
    },
    askSessions: new Map([[conv.id, fakeSession]]),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('cf3b'),
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => options.webSearch ?? null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    jobs: { hold: () => () => undefined },
    imports: { captureAsk: captureAsk as unknown as (input: unknown) => unknown },
    enqueueExtract,
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    newAskSession,
    hermesFound,
    disposeWarmSession: () => undefined,
    warm: null,
  });

  return {
    runtime,
    conversations,
    conversationId: conv.id,
    captureAsk,
    enqueueExtract,
    newAskSession,
    hermesFound,
  };
}

function lastMessage(conversations: ConversationStore, conversationId: string) {
  const messages = conversations.messages(conversationId);
  return messages[messages.length - 1]!;
}

function latestRun(): { engine: string; status: string } | undefined {
  return db.prepare('SELECT engine, status FROM runtime_runs ORDER BY rowid DESC LIMIT 1').get() as
    { engine: string; status: string } | undefined;
}

describe('CF3b 条件 10–17：聊天走直连模型', () => {
  it('条件 10：配好聊天模型 → 走直连（engine/modelName/runtime_runs 都对，且没启动 Hermes）', async () => {
    const gw = gateway([() => textSse('直连的回答')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup();

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });

    const last = lastMessage(h.conversations, h.conversationId);
    expect(last.engine).toBe('direct');
    expect(last.modelName).toBe(MODEL);
    expect(last.content).toContain('直连的回答');

    // 没有启动 Hermes：替身 locator 与新会话工厂都没被调用
    expect(h.hermesFound).not.toHaveBeenCalled();
    expect(h.newAskSession).not.toHaveBeenCalled();

    const run = latestRun();
    expect(run).toEqual({ engine: 'direct', status: 'succeeded' });
  });

  it('条件 11：search_memory 与记忆桥同一套——开着开关能查到，关掉查不到', async () => {
    const items = new ItemService(db);
    items.createManual({
      projectId: null,
      type: 'preference',
      statement: '合成记忆：用户偏好简洁的回答',
      rationale: null,
      scope: 'personal',
    });

    // 开着「个人记忆给聊天用」
    setPersonalMemoryToChat(db, true);
    const on = gateway([
      () => toolSse('search_memory', JSON.stringify({ query: '偏好' })),
      () => textSse('查到了'),
    ]);
    vi.stubGlobal('fetch', on.fetchImpl);
    const hOn = setup();
    await hOn.runtime.ask({
      conversationId: hOn.conversationId,
      projectId: null,
      question: '我喜欢什么风格',
    });
    const toolCall = on.calls.find((c) =>
      Array.isArray(c.body['messages'])
        ? (c.body['messages'] as Array<{ role: string }>).some((m) => m.role === 'tool')
        : false,
    );
    const toolContent = JSON.stringify(toolCall?.body['messages'] ?? '');
    expect(toolContent).toContain('用户偏好简洁的回答');

    // 关掉开关，也没有逐条分享
    setPersonalMemoryToChat(db, false);
    const off = gateway([
      () => toolSse('search_memory', JSON.stringify({ query: '偏好' })),
      () => textSse('没查到'),
    ]);
    vi.stubGlobal('fetch', off.fetchImpl);
    const hOff = setup();
    await hOff.runtime.ask({
      conversationId: hOff.conversationId,
      projectId: null,
      question: '我喜欢什么风格',
    });
    const toolCallOff = off.calls.find((c) =>
      Array.isArray(c.body['messages'])
        ? (c.body['messages'] as Array<{ role: string }>).some((m) => m.role === 'tool')
        : false,
    );
    expect(JSON.stringify(toolCallOff?.body['messages'] ?? '')).not.toContain('用户偏好简洁的回答');
  });

  it('条件 12：search_web 没配 → 工具结果说没配、回答照常完成', async () => {
    const gw = gateway([
      () => toolSse('search_web', JSON.stringify({ query: '合成查询' })),
      () => textSse('照常回答'),
    ]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ webSearch: null });

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });

    const last = lastMessage(h.conversations, h.conversationId);
    expect(last.status).toBe('complete');
    expect(last.content).toContain('照常回答');
    const withTool = gw.calls.find((c) =>
      Array.isArray(c.body['messages'])
        ? (c.body['messages'] as Array<{ role: string }>).some((m) => m.role === 'tool')
        : false,
    );
    expect(JSON.stringify(withTool?.body['messages'] ?? '')).toContain('联网搜索没有配置');
  });

  it('条件 12（配了搜索）：查询先过 sanitizePublicQuery，合成邮箱被替换掉', async () => {
    const seen: string[] = [];
    const webSearch = {
      provider: 'synthetic',
      search: async (query: string) => {
        seen.push(query);
        return { ok: true, results: [] };
      },
    };
    const gw = gateway([
      () => toolSse('search_web', JSON.stringify({ query: '联系 someone@example.com 的近况' })),
      () => textSse('搜索完成'),
    ]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ webSearch });

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toContain('someone@example.com');
  });

  it('条件 13：模型调 propose_task（不在工具清单里）→ 不执行，也没有多出任务或记忆', async () => {
    const itemsBefore = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    const tasksBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }
    ).n;

    const gw = gateway([
      () => toolSse('propose_task', JSON.stringify({ title: '合成任务' })),
      () => textSse('好的'),
    ]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup();

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });

    expect((db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n).toBe(
      itemsBefore,
    );
    expect((db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }).n).toBe(
      tasksBefore,
    );
    // 作为失败的工具结果交回模型（不是静默丢掉）
    const withTool = gw.calls.find((c) =>
      Array.isArray(c.body['messages'])
        ? (c.body['messages'] as Array<{ role: string }>).some((m) => m.role === 'tool')
        : false,
    );
    expect(withTool).toBeDefined();
  });

  it('条件 14：存档与提炼照做，meta.memoryUsed 含工具查到的，injectedMemoryByTurn 认得出', async () => {
    const items = new ItemService(db);
    items.createManual({
      projectId: null,
      type: 'preference',
      statement: '合成记忆：用户喜欢短答案',
      rationale: null,
      scope: 'personal',
    });
    setPersonalMemoryToChat(db, true);

    const gw = gateway([
      () => toolSse('search_memory', JSON.stringify({ query: '喜欢' })),
      () => textSse('你以前说过喜欢短答案'),
    ]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup();

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '我喜欢什么',
    });

    const last = lastMessage(h.conversations, h.conversationId);
    const meta = (last.meta ?? {}) as { memoryUsed?: Array<{ id: string; statement: string }> };
    expect(Array.isArray(meta.memoryUsed)).toBe(true);
    expect((meta.memoryUsed ?? []).some((m) => m.statement.includes('喜欢短答案'))).toBe(true);

    expect(h.captureAsk).toHaveBeenCalled();
    expect(h.enqueueExtract).toHaveBeenCalled();

    // 提炼时认得出这条 direct 回答（与 hermes 同等对待）
    const extractor = new Extractor(db, new FakeProvider('cf3b-ex')) as unknown as {
      injectedMemoryByTurn(conversationId: string | null): Map<string, string[]>;
    };
    const recognized = extractor.injectedMemoryByTurn(h.conversationId);
    expect(recognized.size).toBeGreaterThan(0);
  });

  it('条件 15：假网关 503 → failed、说明含「换一个模型」，没有再走 Hermes/有界循环', async () => {
    const gw = gateway([
      () =>
        new Response(
          JSON.stringify({ error: { message: 'No available channel for model demo-a' } }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup();

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });

    const last = lastMessage(h.conversations, h.conversationId);
    expect(last.status).toBe('failed');
    expect(last.errorMessage ?? '').toContain('换一个模型');
    expect(h.newAskSession).not.toHaveBeenCalled();
    expect(h.hermesFound).not.toHaveBeenCalled();
  });

  it('条件 16：用户中途取消 → cancelled，已经答出的半截还在', async () => {
    const enc = new TextEncoder();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: '已经答出的半截' } }] })}\n\n`,
            ),
          );
          await gate;
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* 忽略 */
            }
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const h = setup();

    const pending = h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.runtime.cancelAsk(h.conversationId);
    release?.();
    await pending;

    const last = lastMessage(h.conversations, h.conversationId);
    expect(last.status).toBe('cancelled');
    expect(last.content).toContain('已经答出的半截');
  });

  it('条件 17：聊天模型没配 → 走现在的路径，原有行为不受影响', async () => {
    const gw = gateway([() => textSse('不该被直连用到的回答')]);
    vi.stubGlobal('fetch', gw.fetchImpl);
    const h = setup({ chatConfigured: false });

    await h.runtime.ask({
      conversationId: h.conversationId,
      projectId: null,
      question: '合成问题',
    });

    const last = lastMessage(h.conversations, h.conversationId);
    // 旧路径：用既有会话（替身返回 hermes），没有走直连
    expect(last.engine).toBe('hermes');
    expect(gw.calls).toHaveLength(0);
  });
});
