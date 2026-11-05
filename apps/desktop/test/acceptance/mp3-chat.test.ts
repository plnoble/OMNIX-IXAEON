/**
 * MP3 验收条件 3、4、5、6、7：聊天按顺序换替补。
 *
 * 条件 3（换）：主选分别抛 429 / 401 / 5xx / 连不上（各一次），替补正常回答：
 *   这一问 complete、照常存档（captureAsk 被调）；meta.modelName 是替补的模型；
 *   meta.notice 整句等于「「合成甲 · demo-a」这次不行（<原因>），由替补「合成乙 · demo-b」回答」，
 *   原因分别是额度用完 / Key 不对或没权限 / 服务出错 / 连不上或超时；
 *   替补收到的消息跟主选收到的一样。
 * 条件 4（不换）：主选抛一般的 400、用户取消、流出过正文之后才出错——三种都不调替补，
 *   收尾跟没有替补时一样；只有一个候选时行为同旧。
 * 条件 5（全不行）：两个候选都不行 → failed、不存档（captureAsk 没被调），
 *   错误说明里两个候选和各自的原因都在。
 * 条件 6（不问回头）：主选第一轮就不行、换替补后，后面几轮工具调用都发给替补，主选只被调一次。
 * 条件 7（记住 5 分钟，假时钟）：换过之后同一用途下一问先试替补；往后拨过 5 分钟又先试主选；
 *   保存一次用途或替补立刻恢复先试主选；整串都在 5 分钟内时下一问照原顺序全部再试。
 *
 * 现在功能还没实现，本文件应当红。聊天用 CF3c 的接缝 chatStreamClient(launch) 换假客户端，
 * 按 launch.model 区分主选和替补。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { ModelError } from '@ixaeon/core';

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

const ADDR_A = 'http://127.0.0.1:18081/v1';
const ADDR_B = 'http://127.0.0.1:18082/v1';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3-chat-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function baseConfig(): AppConfig {
  const base = defaultAppConfig();
  return {
    ...base,
    model: { ...base.model, modelName: '', chatModelName: '' },
    providers: [],
    uses: {},
    ...({ fallbacks: {} } as Record<string, unknown>),
  } as AppConfig;
}

type StreamResult = {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string;
  toolsUnsupported?: boolean;
};

interface Call {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

type StepInput = {
  messages: Array<{ role: string; content: string }>;
  call: number;
  signal?: AbortSignal;
  onDelta?: (s: string) => void;
};

/** 造一个假聊天客户端：按 model 决定这一轮干什么。 */
function makeClient(
  model: string,
  step: (input: StepInput) => StreamResult | Promise<StreamResult>,
  calls: Call[],
) {
  let n = 0;
  return {
    modelName: model,
    async stream(input: {
      messages: Array<{ role: string; content: string }>;
      signal?: AbortSignal;
      onDelta?: (s: string) => void;
    }): Promise<StreamResult> {
      const call = n++;
      calls.push({
        model,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return step({ ...input, call });
    },
  };
}

function err(message: string, retriable: boolean, status?: number): Error {
  const Ctor = ModelError as unknown as new (m: string, r: boolean, s?: number) => Error;
  return new Ctor(message, retriable, status);
}

function fixture(
  config: AppConfig,
  clients: Record<string, unknown>,
): {
  runtime: AppRuntime;
  captureAsk: ReturnType<typeof vi.fn>;
} {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const captureAsk = vi.fn(() => ({ created: true as const, source: { id: 'src-ask' } }));
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
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
      const client = clients[launch.model];
      if (!client) throw new Error(`没有为 ${launch.model} 准备假客户端`);
      return client;
    },
    __conversationId: conv.id,
    __messages: () => conversations.messages(conv.id),
    __captureAsk: captureAsk,
  });
  return { runtime, captureAsk };
}

function twoProviders(runtime: AppRuntime): { a: string; b: string } {
  const a = runtime.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: ADDR_A,
    apiKey: 'sk-synthetic-a1b2c3d4',
    savedModels: ['demo-a'],
  });
  const b = runtime.saveModelProvider({
    name: '合成乙',
    kind: 'openai',
    apiBaseUrl: ADDR_B,
    apiKey: 'sk-synthetic-b9f8e7d6',
    savedModels: ['demo-b'],
  });
  return { a: a.id, b: b.id };
}

function saveFallbacks(
  runtime: AppRuntime,
  input: {
    analysis?: Array<{ providerId: string; model: string }>;
    chat?: Array<{ providerId: string; model: string }>;
  },
): void {
  const fn = (runtime as unknown as Record<string, unknown>)['saveModelFallbacks'];
  expect(typeof fn).toBe('function');
  (fn as (this: AppRuntime, i: unknown) => unknown).call(runtime, input);
}

function conversationId(runtime: AppRuntime): string {
  return (runtime as unknown as { __conversationId: string }).__conversationId;
}

function messages(runtime: AppRuntime): Array<Record<string, unknown>> {
  return (runtime as unknown as { __messages: () => Array<Record<string, unknown>> }).__messages();
}

async function ask(runtime: AppRuntime): Promise<void> {
  await runtime.ask({
    conversationId: conversationId(runtime),
    projectId: null,
    question: '合成问题',
  });
}

const answer = (text: string): StreamResult => ({
  content: text,
  toolCalls: [],
  finishReason: 'stop',
});

describe('MP3 条件 3：聊天换替补（四种「不行」各一次）', () => {
  const cases: Array<{ name: string; make: () => Error; reason: string }> = [
    { name: '429', make: () => err('HTTP 429 额度用完', true, 429), reason: '额度用完' },
    { name: '401', make: () => err('HTTP 401 未授权', false, 401), reason: 'Key 不对或没权限' },
    { name: '5xx', make: () => err('HTTP 503 服务出错', true, 503), reason: '服务出错' },
    {
      name: '连不上',
      make: () => err('网络错误: connect ECONNREFUSED', true),
      reason: '连不上或超时',
    },
  ];

  for (const c of cases) {
    it(`主选 ${c.name} → 替补回答，complete、存档、notice 整句对（${c.reason}）`, async () => {
      const calls: Call[] = [];
      const { runtime, captureAsk } = fixture(baseConfig(), {});
      const { a, b } = twoProviders(runtime);
      runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
      saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });

      const clients = {
        'demo-a': makeClient(
          'demo-a',
          () => {
            throw c.make();
          },
          calls,
        ),
        'demo-b': makeClient('demo-b', () => answer('来自替补的回答'), calls),
      } as Record<string, unknown>;
      (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
        model: string;
      }) => clients[launch.model];

      await ask(runtime);

      const last = messages(runtime).at(-1) as Record<string, unknown>;
      expect(last.role).toBe('assistant');
      expect(last.status).toBe('complete');
      expect(String(last.content)).toContain('来自替补的回答');
      expect(captureAsk).toHaveBeenCalled();
      const meta = last.meta as Record<string, unknown> | undefined;
      expect(meta?.['modelName']).toBe('demo-b');
      expect(meta?.['notice']).toBe(
        `「合成甲 · demo-a」这次不行（${c.reason}），由替补「合成乙 · demo-b」回答`,
      );
      const primaryCall = calls.find((x) => x.model === 'demo-a');
      const subCall = calls.find((x) => x.model === 'demo-b');
      expect(primaryCall && subCall).toBeTruthy();
      expect(subCall!.messages).toEqual(primaryCall!.messages);
    });
  }
});

describe('MP3 条件 4：不换的三种', () => {
  it('主选抛一般的 400 → 不调替补，收尾跟没有替补时一样', async () => {
    const calls: Call[] = [];
    const { runtime } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    const clients = {
      'demo-a': makeClient(
        'demo-a',
        () => {
          throw err('HTTP 400 参数不对', false, 400);
        },
        calls,
      ),
      'demo-b': makeClient('demo-b', () => answer('不该出现'), calls),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    await ask(runtime);
    expect(calls.some((c) => c.model === 'demo-b')).toBe(false);
    expect((messages(runtime).at(-1) as Record<string, unknown>)['status']).toBe('failed');
  });

  it('用户取消 → 不调替补，收尾跟今天取消一样', async () => {
    const calls: Call[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { runtime } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    const clients = {
      'demo-a': {
        modelName: 'demo-a',
        async stream(input: {
          messages: Array<{ role: string; content: string }>;
          signal?: AbortSignal;
          onDelta?: (s: string) => void;
        }) {
          calls.push({
            model: 'demo-a',
            messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
          });
          input.onDelta?.('已经答出的半截');
          await gate;
          if (input.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          return answer('不该走到这');
        },
      },
      'demo-b': makeClient('demo-b', () => answer('不该出现'), calls),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    const pending = runtime.ask({
      conversationId: conversationId(runtime),
      projectId: null,
      question: '合成问题',
    });
    await new Promise((r) => setTimeout(r, 50));
    runtime.cancelAsk(conversationId(runtime));
    release?.();
    await pending;

    expect(calls.some((c) => c.model === 'demo-b')).toBe(false);
    const last = messages(runtime).at(-1) as Record<string, unknown>;
    expect(last['status']).toBe('cancelled');
    expect(String(last['content'])).toContain('已经答出的半截');
  });

  it('已经流出过正文之后才出错 → 不换，半句话留着', async () => {
    const calls: Call[] = [];
    const { runtime } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    const clients = {
      'demo-a': {
        modelName: 'demo-a',
        async stream(input: {
          messages: Array<{ role: string; content: string }>;
          onDelta?: (s: string) => void;
        }) {
          calls.push({
            model: 'demo-a',
            messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
          });
          input.onDelta?.('已经写出的半句');
          throw err('半路断了', true, 503);
        },
      },
      'demo-b': makeClient('demo-b', () => answer('不该出现'), calls),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    await ask(runtime);
    expect(calls.some((c) => c.model === 'demo-b')).toBe(false);
    const last = messages(runtime).at(-1) as Record<string, unknown>;
    expect(String(last['content'])).toContain('已经写出的半句');
  });
});

describe('MP3 条件 5：全不行', () => {
  it('两个候选都不行 → failed、不存档，错误说明里两个候选和原因都在', async () => {
    const calls: Call[] = [];
    const { runtime, captureAsk } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    const clients = {
      'demo-a': makeClient(
        'demo-a',
        () => {
          throw err('HTTP 429 额度用完', true, 429);
        },
        calls,
      ),
      'demo-b': makeClient(
        'demo-b',
        () => {
          throw err('网络错误: 连不上', true);
        },
        calls,
      ),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    await ask(runtime);
    const last = messages(runtime).at(-1) as Record<string, unknown>;
    expect(last['status']).toBe('failed');
    expect(captureAsk).not.toHaveBeenCalled();
    const text = String(last['content'] ?? '') + String(last['errorMessage'] ?? '');
    expect(text).toContain('demo-a');
    expect(text).toContain('demo-b');
    expect(text).toContain('额度用完');
    expect(text).toContain('连不上');
  });
});

describe('MP3 条件 6：一问之内不回头', () => {
  it('主选第一轮不行 → 换替补，后面几轮都发给替补，主选只被调一次', async () => {
    const calls: Call[] = [];
    const { runtime } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    const clients = {
      'demo-a': makeClient(
        'demo-a',
        () => {
          throw err('HTTP 429 额度用完', true, 429);
        },
        calls,
      ),
      'demo-b': makeClient(
        'demo-b',
        ({ call }) =>
          call === 0
            ? {
                content: '',
                toolCalls: [{ id: 't1', name: 'search_memory', arguments: '{"query":"合成"}' }],
                finishReason: 'tool_calls',
              }
            : answer('替补答完'),
        calls,
      ),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    await ask(runtime);
    expect(calls.filter((c) => c.model === 'demo-a')).toHaveLength(1);
    expect(calls.filter((c) => c.model === 'demo-b').length).toBeGreaterThanOrEqual(2);
  });
});

describe('MP3 条件 7：记住 5 分钟（假时钟）', () => {
  it('换过后下一问先试替补；过 5 分钟又先试主选；保存用途/保存替补各一次都立刻恢复先试主选', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    const calls: Call[] = [];
    const { runtime } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });

    let primaryFails = true;
    const clients = {
      'demo-a': makeClient(
        'demo-a',
        () => {
          if (primaryFails) throw err('HTTP 429 额度用完', true, 429);
          return answer('主选答了');
        },
        calls,
      ),
      'demo-b': makeClient('demo-b', () => answer('替补答了'), calls),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    // 第一次：主选不行 → 替补
    await ask(runtime);
    expect(calls.map((c) => c.model)).toEqual(['demo-a', 'demo-b']);

    // 5 分钟内第二问：先试替补（主选被排到最后）
    calls.length = 0;
    primaryFails = false;
    await ask(runtime);
    expect(calls[0]!.model).toBe('demo-b');

    // 再让主选不行一次（还在 5 分钟内），确认替补先试
    calls.length = 0;
    primaryFails = true;
    await ask(runtime);
    expect(calls[0]!.model).toBe('demo-b');

    // 保存一次「用途」→ 立刻恢复先试主选
    primaryFails = false;
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    calls.length = 0;
    await ask(runtime);
    expect(calls[0]!.model).toBe('demo-a');

    // 再让主选不行 → 记下；保存一次「替补」→ 立刻恢复先试主选
    primaryFails = true;
    calls.length = 0;
    await ask(runtime);
    expect(calls[0]!.model).toBe('demo-a');
    primaryFails = false;
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    calls.length = 0;
    await ask(runtime);
    expect(calls[0]!.model).toBe('demo-a');

    // 拨过 5 分钟：又先试主选
    vi.setSystemTime(new Date('2026-11-05T10:06:00Z'));
    calls.length = 0;
    await ask(runtime);
    expect(calls[0]!.model).toBe('demo-a');
  });

  it('整串都在 5 分钟里：下一问照原顺序全部再试（顺序也相等）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    const calls: Call[] = [];
    const { runtime } = fixture(baseConfig(), {});
    const { a, b } = twoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });
    const clients = {
      'demo-a': makeClient(
        'demo-a',
        () => {
          throw err('HTTP 429 额度用完', true, 429);
        },
        calls,
      ),
      'demo-b': makeClient(
        'demo-b',
        () => {
          throw err('HTTP 502 服务出错', true, 502);
        },
        calls,
      ),
    } as Record<string, unknown>;
    (runtime as unknown as Record<string, unknown>)['chatStreamClient'] = (launch: {
      model: string;
    }) => clients[launch.model];

    await ask(runtime);
    calls.length = 0;
    await ask(runtime);
    expect(calls.map((c) => c.model).sort()).toEqual(['demo-a', 'demo-b']);
  });
});
