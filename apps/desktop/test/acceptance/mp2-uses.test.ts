/**
 * MP2 验收（条件 6、7）：按用途取模型。
 *
 * 条件 6：
 * - 聊天选了 B 家的 demo-b → `chatLaunchOptions()` 返回 B 家的地址、B 家的 Key、demo-b，`getProvider()` 还是 default；
 *   并且这一问走的是直连（`engine = 'direct'`）。
 * - 聊天的选择清掉 → 回到旧字段；
 * - 后台分析选了 B 家、聊天没单独选 → 聊天也走 B 家；
 * - 选一个没勾选过的模型 → 拒绝（**先单独把两家建好**，别让建家时的异常冒充「拒绝」），
 *   拒绝之后聊天仍旧是旧字段；
 * - 选 default 那一家 → 写进旧字段，`uses` 里没有这一项。
 * 条件 7：
 * - B 家被删 / B 家的 Key 解不开 → 用了 B 家的用途返回 null，不会掉回 default 借别家的 Key。
 *
 * 不联网：假网关是内存里的 SSE 流；地址与 Key 都是合成的；getProvider 用真实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: { handle: vi.fn() },
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
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  resolveModelUse,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const KEY_A = 'sk-synthetic-a1b2c3d4';
const KEY_B = 'sk-synthetic-b9f8e7d6';
const ADDR_A = 'http://127.0.0.1:18081/v1';
const ADDR_B = 'http://127.0.0.1:18082/v1';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp2-uses-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function legacyConfig(): AppConfig {
  const base = defaultAppConfig();
  return {
    ...base,
    model: {
      ...base.model,
      modelName: 'demo-a',
      chatModelName: '',
      apiBaseUrl: ADDR_A,
      apiKeyEncrypted: Buffer.from(`enc:${KEY_A}`).toString('base64'),
      apiKeyPresent: true,
      savedModels: ['demo-a'],
    },
  };
}

function runtimeWith(config: AppConfig): { runtime: AppRuntime; conversationId: string } {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
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
    askDeltaSink: null,
    askProgressSink: null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    jobs: { hold: () => () => undefined },
    imports: { captureAsk: () => ({ created: true, source: { id: 'src-x' } }) },
    enqueueExtract: () => undefined,
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    newAskSession: () => ({
      session: {
        run: async () => ({
          answer: '这条来自旧路径替身',
          citations: [],
          notice: '',
          usedChars: 0,
          modelName: 'demo-a',
          engine: 'hermes',
          steps: [],
          memoryUsed: [],
        }),
        cancel: () => undefined,
        getEngineSessionId: () => 's-hermes',
      },
      adapter: {},
    }),
    hermesFound: () => true,
    disposeWarmSession: () => undefined,
    warm: null,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    // 复审意见 2：不覆盖 getProvider —— 条件 6 要断言真的那条实现仍指向 default
  });
  return { runtime, conversationId: conv.id };
}

function launchOf(runtime: AppRuntime): {
  chatModel: string | null;
  chatBaseUrl: string | null;
  chatApiKey: string | null;
} {
  return (
    runtime as unknown as {
      chatLaunchOptions(): {
        chatModel: string | null;
        chatBaseUrl: string | null;
        chatApiKey: string | null;
      };
    }
  ).chatLaunchOptions();
}

/** 加两家（A 与 B）并各自勾选一个模型，返回 id。 */
function withTwoProviders(runtime: AppRuntime): { a: string; b: string } {
  const a = runtime.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: ADDR_A,
    apiKey: KEY_A,
    savedModels: ['demo-a'],
  });
  const b = runtime.saveModelProvider({
    name: '合成乙',
    kind: 'openai',
    apiBaseUrl: ADDR_B,
    apiKey: KEY_B,
    savedModels: ['demo-b'],
  });
  return { a: a.id, b: b.id };
}

describe('MP2 条件 6：按用途取模型', () => {
  it('聊天选了 B 家的 demo-b → chatLaunchOptions 返回 B 家；getProvider 还是 default', () => {
    const { runtime } = runtimeWith(legacyConfig());
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: b, model: 'demo-b' } });

    const launch = launchOf(runtime);
    expect(launch.chatModel).toBe('demo-b');
    expect(launch.chatBaseUrl).toBe(ADDR_B);
    expect(launch.chatApiKey).toBe(KEY_B);
    expect(runtime.getProvider()?.modelName).toBe('demo-a');
  });

  it('聊天选了 B 家 → 这一问走直连（engine = direct）', async () => {
    const enc = new TextEncoder();
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: '来自乙家的回答' }, finish_reason: 'stop' }] })}\n\n`,
            ),
          );
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    const { runtime, conversationId } = runtimeWith(legacyConfig());
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: b, model: 'demo-b' } });

    await runtime.ask({ conversationId, projectId: null, question: '合成问题' });

    const messages = (
      runtime as unknown as { conversations: ConversationStore }
    ).conversations.messages(conversationId);
    const last = messages[messages.length - 1]!;
    expect(last.engine).toBe('direct');
    expect(last.modelName).toBe('demo-b');
    expect(last.content).toContain('来自乙家的回答');
  });

  it('聊天的选择清掉 → 回到旧字段', () => {
    const { runtime } = runtimeWith(legacyConfig());
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: b, model: 'demo-b' } });
    runtime.saveModelUses({ chat: null });

    const launch = launchOf(runtime);
    expect(launch.chatBaseUrl).toBe(ADDR_A);
    expect(launch.chatApiKey).toBe(KEY_A);
    expect(launch.chatModel).toBe('demo-a');
  });

  it('后台分析选了 B 家、聊天没单独选 → 聊天也走 B 家', () => {
    const { runtime } = runtimeWith(legacyConfig());
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ analysis: { providerId: b, model: 'demo-b' } });

    const launch = launchOf(runtime);
    expect(launch.chatBaseUrl).toBe(ADDR_B);
    expect(launch.chatApiKey).toBe(KEY_B);
    expect(launch.chatModel).toBe('demo-b');
    expect(runtime.getProvider()?.modelName).toBe('demo-b');
  });

  it('选一个没勾选过的模型 → 拒绝，拒绝之后聊天仍是旧字段', () => {
    const { runtime } = runtimeWith(legacyConfig());
    // 先单独把两家建好：建家这一步自己抛错不能冒充「拒绝」
    const { b } = withTwoProviders(runtime);

    expect(() =>
      runtime.saveModelUses({ chat: { providerId: b, model: 'demo-没勾过' } }),
    ).toThrow();

    const launch = launchOf(runtime);
    expect(launch.chatBaseUrl).toBe(ADDR_A);
    expect(launch.chatModel).toBe('demo-a');
  });

  it('选 default 那一家 → 写进旧字段，uses 里没有这一项', () => {
    const { runtime } = runtimeWith(legacyConfig());
    runtime.saveModelUses({ chat: { providerId: 'default', model: 'demo-a' } });
    const config = runtime.getConfig();
    expect(config.model.chatModelName).toBe('demo-a');
    expect(config.uses?.chat).toBeUndefined();
  });
});

describe('MP2 条件 7：那家没了或解不开 → null，不借别家的 Key', () => {
  it('B 家被删之后，用了 B 家的用途返回 null', () => {
    const { runtime } = runtimeWith(legacyConfig());
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: b, model: 'demo-b' } });
    // 直接把这家人从配置里抹掉，模拟「那家没了」
    const config = runtime.getConfig();
    Object.assign(runtime as unknown as { config: AppConfig }, {
      config: {
        ...config,
        providers: (config.providers ?? []).filter((p) => p.id !== b),
      } as AppConfig,
    });

    expect(launchOf(runtime).chatBaseUrl).toBeNull();
    expect(resolveModelUse(runtime.getConfig(), 'chat')).toBeNull();
  });

  it('B 家的 Key 解不开 → 那个用途返回 null，不借 default 的 Key', () => {
    const { runtime } = runtimeWith(legacyConfig());
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: b, model: 'demo-b' } });
    const config = runtime.getConfig();
    const providers = (config.providers ?? []).map((p) =>
      p.id === b ? { ...p, apiKeyEncrypted: Buffer.from('broken-cipher').toString('base64') } : p,
    );
    Object.assign(runtime as unknown as { config: AppConfig }, {
      config: { ...config, providers } as AppConfig,
    });

    const launch = launchOf(runtime);
    expect(launch.chatBaseUrl).toBeNull();
    expect(launch.chatApiKey).toBeNull();
  });
});
