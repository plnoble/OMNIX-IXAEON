/**
 * S1：提问过程中分段写入占位消息；结束等于 complete 全文；两对话不串；取消后不再追加。
 *
 * CF3c 起聊天只走直连：原来注入「Hermes 替身会话」的地方改成从 `chatStreamClient`
 * 接缝拿一个假客户端（规格第 3 条）。断言的还是同一批行为（分段落库、事件归属、取消不再追加）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import {
  openDatabase,
  migrate,
  ConversationStore,
  ItemService,
  ProjectService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
  FakeProvider,
  type ChatStreamResult,
  type CoreDatabase,
  type StreamChatClient,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
import type { AskDeltaEvent } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
  },
}));

const CHAT_KEY = 'sk-synthetic';
let db: CoreDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

/** 假模型客户端：按最后一问的内容决定吐哪些分段 / 是否抛错。 */
function fakeClient(
  impl: (input: {
    lastUser: string;
    onDelta?: (t: string) => void;
    signal?: AbortSignal;
  }) => Promise<Partial<ChatStreamResult>> | Partial<ChatStreamResult>,
): StreamChatClient {
  return {
    modelName: 'demo-a',
    async stream(input) {
      const last = [...input.messages].reverse().find((m) => m.role === 'user');
      const r = await impl({
        lastUser: last?.content ?? '',
        onDelta: input.onDelta,
        signal: input.signal,
      });
      return {
        content: r.content ?? '',
        toolCalls: r.toolCalls ?? [],
        finishReason: r.finishReason ?? null,
        toolsUnsupported: r.toolsUnsupported ?? false,
      };
    },
  };
}

function makeRuntime(client: StreamChatClient) {
  const conversations = new ConversationStore(db);
  const events: AskDeltaEvent[] = [];
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    config: {
      ...defaultAppConfig(),
      model: {
        ...defaultAppConfig().model,
        modelName: 'demo-a',
        chatModelName: '',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyEncrypted: Buffer.from(`enc:${CHAT_KEY}`).toString('base64'),
        apiKeyPresent: true,
        savedModels: ['demo-a'],
      },
    },
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: (e: AskDeltaEvent) => events.push(e),
    chatStreamClient: () => client,
    getProvider: () => new FakeProvider('s1'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, conversations, events };
}

describe('S1 桌面问答分段', () => {
  it('生成中 status=streaming 且 content 是已到分段；结束等于 complete 全文；事件 id 对', async () => {
    const client = fakeClient(async ({ onDelta }) => {
      onDelta?.('你');
      onDelta?.('好');
      await new Promise((r) => setTimeout(r, 250));
      return { content: '你好，世界' };
    });
    const { runtime, conversations, events } = makeRuntime(client);
    const conv = conversations.create({ projectId: null });
    const r = await runtime.ask({ conversationId: conv.id, projectId: null, question: '在吗？' });
    const done = conversations.getMessage(r.messageId);
    expect(done.status).toBe('complete');
    expect(done.content).toBe('你好，世界');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.conversationId).toBe(conv.id);
      expect(e.messageId).toBe(r.messageId);
    }
  });

  it('两个对话同时在答：分段只进各自的消息', async () => {
    const client = fakeClient(async ({ lastUser, onDelta }) => {
      if (lastUser === 'A') {
        onDelta?.('甲');
        await new Promise((r) => setTimeout(r, 20));
        return { content: '甲完' };
      }
      onDelta?.('乙');
      await new Promise((r) => setTimeout(r, 20));
      return { content: '乙完' };
    });
    const { runtime, conversations, events } = makeRuntime(client);
    const a = conversations.create({ projectId: null });
    const b = conversations.create({ projectId: null });
    const [ra, rb] = await Promise.all([
      runtime.ask({ conversationId: a.id, projectId: null, question: 'A' }),
      runtime.ask({ conversationId: b.id, projectId: null, question: 'B' }),
    ]);
    expect(conversations.getMessage(ra.messageId).content).toBe('甲完');
    expect(conversations.getMessage(rb.messageId).content).toBe('乙完');
    const byConv = (id: string) => events.filter((e) => e.conversationId === id);
    expect(byConv(a.id).map((e) => [e.messageId, e.delta])).toEqual([[ra.messageId, '甲']]);
    expect(byConv(b.id).map((e) => [e.messageId, e.delta])).toEqual([[rb.messageId, '乙']]);
  });

  it('模型中途报错：消息 failed，已经答出的半截留在正文里', async () => {
    const client = fakeClient(async ({ onDelta }) => {
      onDelta?.('答了一半');
      throw new Error('没答完：模型断了');
    });
    const { runtime, conversations } = makeRuntime(client);
    const conv = conversations.create({ projectId: null });
    const r = await runtime.ask({ conversationId: conv.id, projectId: null, question: '在吗' });
    const failed = conversations.getMessage(r.messageId);
    expect(failed.status).toBe('failed');
    expect(failed.content).toBe('答了一半');
    expect(failed.errorMessage ?? '').toContain('没答完');
  });

  it('取消后不再追加、不再发事件', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = fakeClient(async ({ onDelta, signal }) => {
      onDelta?.('已到');
      await gate;
      // 取消后要像真的流一样抛 AbortError，直连才会按 cancelled 收尾
      if (signal?.aborted) {
        throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      }
      onDelta?.('迟到');
      return { content: '已到迟到' };
    });
    const { runtime, conversations, events } = makeRuntime(client);
    const conv = conversations.create({ projectId: null });
    const pending = runtime.ask({ conversationId: conv.id, projectId: null, question: '取消我' });
    await new Promise((r) => setTimeout(r, 30));
    const before = events.length;
    const cancelled = runtime.cancelAsk(conv.id);
    expect(cancelled.cancelled).toBe(true);
    release();
    const r = await pending;
    expect(conversations.getMessage(r.messageId).content).not.toContain('迟到');
    expect(events.slice(before).some((e) => e.delta === '迟到')).toBe(false);
  });
});
