/**
 * E5：每条回答记下这一轮注入给模型的记忆（meta.memoryUsed）。
 * 回答下面据此列出「用到的记忆」供当场纠正；提炼聊天存档时据此认出回声。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-e5-desk-'));
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

function runtimeWith(result: Partial<AgentSessionResult>) {
  const conversations = new ConversationStore(db);
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
    askProgressSink: null,
    getProvider: () => new FakeProvider('e5'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  const conv = conversations.create({ projectId: null });
  runtime['askSessions'].set(conv.id, {
    run: async () => ({
      answer: '好',
      citations: [],
      notice: '本轮经 Hermes TUI gateway',
      usedChars: 1,
      modelName: 'hermes',
      engine: 'hermes',
      runId: 'run',
      steps: [],
      ...result,
    }),
    cancel: () => undefined,
    getEngineSessionId: () => 's-test',
  } as unknown as AgentSession);
  return { runtime, conversations, conv };
}

describe('E5 回答记下本轮用到的记忆', () => {
  it('Hermes 回答：memoryUsed 原样存进这条回答的 meta', async () => {
    const used = [{ id: 'm1', statement: '每周五写周报', tag: '用户指定' }];
    const { runtime, conversations, conv } = runtimeWith({ memoryUsed: used });
    const r = await runtime.ask({ conversationId: conv.id, projectId: null, question: '周报？' });
    expect(conversations.getMessage(r.messageId).meta['memoryUsed']).toEqual(used);
  });

  it('这一轮一条都没注入：存空数组（表示「有记录、没用到」，不同于没有记录）', async () => {
    const { runtime, conversations, conv } = runtimeWith({ memoryUsed: [] });
    const r = await runtime.ask({ conversationId: conv.id, projectId: null, question: '在吗？' });
    expect(conversations.getMessage(r.messageId).meta['memoryUsed']).toEqual([]);
  });

  it('Core 兜底回答没有这份记录', async () => {
    const { runtime, conversations, conv } = runtimeWith({ engine: 'core-bounded' });
    const r = await runtime.ask({ conversationId: conv.id, projectId: null, question: '在吗？' });
    expect(conversations.getMessage(r.messageId).meta['memoryUsed']).toBeUndefined();
  });
});
