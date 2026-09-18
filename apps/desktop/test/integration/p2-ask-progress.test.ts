/**
 * P2：preparing 是第一件进度事件，且在会话开始跑之前发出；
 * 两对话不串；取消后不再推进度。
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
import type { AskProgressEvent } from '@ixaeon/contracts';
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p2-desk-'));
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
  const events: AskProgressEvent[] = [];
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
    askDeltaSink: null,
    askProgressSink: (e: AskProgressEvent) => events.push(e),
    getProvider: () => new FakeProvider('p2'),
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
  run: (input: {
    onProgress?: (phase: 'thinking' | 'answering') => void;
    runId?: string;
  }) => Promise<AgentSessionResult>;
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

describe('P2 桌面问答进度', () => {
  it('preparing 是这一轮第一个进度事件，且在会话开始跑之前就发出', async () => {
    const { runtime, conversations, events } = makeRuntime();
    const conv = conversations.create({ projectId: null });
    let ran = false;
    runtime['askSessions'].set(
      conv.id,
      fakeSession({
        run: async ({ onProgress }) => {
          ran = true;
          expect(events[0]?.phase).toBe('preparing');
          onProgress?.('thinking');
          onProgress?.('answering');
          return okResult('好');
        },
      }),
    );
    const r = await runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: '在吗？',
    });
    expect(ran).toBe(true);
    expect(events[0]).toEqual({
      conversationId: conv.id,
      messageId: r.messageId,
      phase: 'preparing',
    });
    expect(events.map((e) => e.phase)).toEqual(['preparing', 'thinking', 'answering']);
    for (const e of events) {
      expect(e.conversationId).toBe(conv.id);
      expect(e.messageId).toBe(r.messageId);
    }
  });

  it('两个对话同时在答：逐条核对每个事件的归属', async () => {
    const { runtime, conversations, events } = makeRuntime();
    const a = conversations.create({ projectId: null });
    const b = conversations.create({ projectId: null });
    runtime['askSessions'].set(
      a.id,
      fakeSession({
        run: async ({ onProgress }) => {
          onProgress?.('thinking');
          await new Promise((r) => setTimeout(r, 20));
          onProgress?.('answering');
          return okResult('甲完');
        },
      }),
    );
    runtime['askSessions'].set(
      b.id,
      fakeSession({
        run: async ({ onProgress }) => {
          onProgress?.('thinking');
          await new Promise((r) => setTimeout(r, 20));
          onProgress?.('answering');
          return okResult('乙完');
        },
      }),
    );
    const [ra, rb] = await Promise.all([
      runtime.ask({ conversationId: a.id, projectId: null, question: 'A' }),
      runtime.ask({ conversationId: b.id, projectId: null, question: 'B' }),
    ]);
    const byConv = (id: string) => events.filter((e) => e.conversationId === id);
    expect(byConv(a.id).map((e) => [e.messageId, e.phase])).toEqual([
      [ra.messageId, 'preparing'],
      [ra.messageId, 'thinking'],
      [ra.messageId, 'answering'],
    ]);
    expect(byConv(b.id).map((e) => [e.messageId, e.phase])).toEqual([
      [rb.messageId, 'preparing'],
      [rb.messageId, 'thinking'],
      [rb.messageId, 'answering'],
    ]);
  });

  it('取消后不再有进度事件', async () => {
    const { runtime, conversations, events } = makeRuntime();
    const conv = conversations.create({ projectId: null });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime['askSessions'].set(
      conv.id,
      fakeSession({
        run: async ({ onProgress }) => {
          onProgress?.('thinking');
          await gate;
          onProgress?.('answering');
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
    expect(runtime.cancelAsk(conv.id).cancelled).toBe(true);
    release();
    await pending;
    // 取消之后一条进度都不能再有（不只是没有 answering）
    expect(events.slice(before)).toEqual([]);
  });
});
