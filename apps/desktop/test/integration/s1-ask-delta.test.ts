/**
 * S1：提问过程中分段写入占位消息；结束等于 complete 全文；两对话不串；取消后不再追加。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type AgentSession,
  type AgentSessionResult,
  type CoreDatabase,
} from '@ixaeon/core';
import type { AskDeltaEvent } from '@ixaeon/contracts';
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s1-desk-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

function makeRuntime() {
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
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: (e: AskDeltaEvent) => events.push(e),
    getProvider: () => new FakeProvider('s1'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, conversations, events };
}

function fakeSession(impl: {
  run: (input: { onDelta?: (t: string) => void; runId?: string }) => Promise<AgentSessionResult>;
  cancel?: () => void;
}): AgentSession {
  return {
    run: impl.run,
    cancel: impl.cancel ?? (() => undefined),
    getEngineSessionId: () => 's-test',
  } as unknown as AgentSession;
}

function okResult(answer: string, extra?: Partial<AgentSessionResult>): AgentSessionResult {
  return {
    answer,
    citations: [],
    notice: extra?.notice ?? '本轮经 Hermes TUI gateway',
    usedChars: answer.length,
    modelName: 'hermes',
    engine: 'hermes',
    runId: extra?.runId ?? 'run',
    steps: [],
    ...extra,
  };
}

describe('S1 桌面问答分段', () => {
  it('生成中 status=streaming 且 content 是已到分段；结束等于 complete 全文；事件 id 对', async () => {
    const { runtime, conversations, events } = makeRuntime();
    const conv = conversations.create({ projectId: null });
    runtime['askSessions'].set(
      conv.id,
      fakeSession({
        run: async ({ onDelta }) => {
          onDelta?.('你');
          onDelta?.('好');
          await new Promise((r) => setTimeout(r, 250));
          const mid = conversations
            .messages(conv.id)
            .find((m) => m.role === 'assistant' && m.status === 'streaming');
          expect(mid).toBeTruthy();
          expect(mid!.content).toBe('你好');
          return okResult('你好，世界');
        },
      }),
    );
    const r = await runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: '在吗？',
    });
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
    const { runtime, conversations, events } = makeRuntime();
    const a = conversations.create({ projectId: null });
    const b = conversations.create({ projectId: null });
    runtime['askSessions'].set(
      a.id,
      fakeSession({
        run: async ({ onDelta }) => {
          onDelta?.('甲');
          await new Promise((r) => setTimeout(r, 20));
          return okResult('甲完');
        },
      }),
    );
    runtime['askSessions'].set(
      b.id,
      fakeSession({
        run: async ({ onDelta }) => {
          onDelta?.('乙');
          await new Promise((r) => setTimeout(r, 20));
          return okResult('乙完');
        },
      }),
    );
    const [ra, rb] = await Promise.all([
      runtime.ask({ conversationId: a.id, projectId: null, question: 'A' }),
      runtime.ask({ conversationId: b.id, projectId: null, question: 'B' }),
    ]);
    expect(conversations.getMessage(ra.messageId).content).toBe('甲完');
    expect(conversations.getMessage(rb.messageId).content).toBe('乙完');
    // 最终内容会被整段覆盖，只看它证明不了中途没串——逐条核对分段事件的归属
    const byConv = (id: string) => events.filter((e) => e.conversationId === id);
    expect(byConv(a.id).map((e) => [e.messageId, e.delta])).toEqual([[ra.messageId, '甲']]);
    expect(byConv(b.id).map((e) => [e.messageId, e.delta])).toEqual([[rb.messageId, '乙']]);
  });

  it('中途失败：已经答出的半截留在库里（包括还没到写库时间的那一段）', async () => {
    const { runtime, conversations } = makeRuntime();
    const conv = conversations.create({ projectId: null });
    runtime['askSessions'].set(
      conv.id,
      fakeSession({
        run: async ({ onDelta }) => {
          onDelta?.('答了'); // 立即写库
          onDelta?.('一半'); // 离上次写库不到 200ms，还压在缓冲里
          throw new Error('这一轮没答完：模型网关同时处理的请求数到上限了');
        },
      }),
    );
    await expect(
      runtime.ask({ conversationId: conv.id, projectId: null, question: '在吗' }),
    ).rejects.toThrow(/没答完/);
    const failed = conversations.messages(conv.id).find((m) => m.role === 'assistant')!;
    expect(failed.status).toBe('failed');
    expect(failed.content).toBe('答了一半');
  });

  it('取消后不再追加、不再发事件', async () => {
    const { runtime, conversations, events } = makeRuntime();
    const conv = conversations.create({ projectId: null });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime['askSessions'].set(
      conv.id,
      fakeSession({
        run: async ({ onDelta }) => {
          onDelta?.('已到');
          await gate;
          onDelta?.('迟到');
          return okResult('已到', { notice: '用户取消 Hermes 会话' });
        },
      }),
    );
    const pending = runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: '取消我',
    });
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
