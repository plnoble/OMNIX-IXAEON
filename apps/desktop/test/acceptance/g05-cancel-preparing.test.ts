/**
 * G05 验收（规格 docs/委派/G05-准备阶段也能取消.md）
 *
 * 条件 1：语义补齐还没结束时取消，返回成功；放行补齐后模型（替身）调用 0 次，
 *         这条回答的状态是 cancelled。
 * 条件 2：正常提问、不取消，替身照常被调用，回答是 complete。
 * 条件 3：回答进行中取消，行为不变——取消返回成功，迟到的内容不再写入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { installFakeChat, type FakeStreamImpl } from './cf3cb-fake-chat.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
  },
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g05-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ANSWER = {
  answer: '好的',
  citations: [],
  notice: '本轮经 Hermes TUI gateway',
  usedChars: 1,
  modelName: 'hermes',
  engine: 'hermes',
  runId: 'run',
  steps: [],
  memoryUsed: [],
};

function runtime() {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const calls: string[] = [];
  const impl: { fn: FakeStreamImpl } = {
    fn: () => {
      calls.push('run');
      return { content: ANSWER.answer };
    },
  };
  const rt = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(rt, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('g05'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  installFakeChat(rt as unknown as Record<string, unknown>, (i) => impl.fn(i));
  return { rt, conversations, conv, calls, impl };
}

describe('G05 准备阶段也能取消', () => {
  it('条件 1：补齐还没结束时取消，返回成功；放行后不调用模型，回答是 cancelled', async () => {
    const { rt, conversations, conv, calls } = runtime();
    let release!: () => void;
    const backfill = new Promise<void>((resolve) => {
      release = resolve;
    });
    rt['kickSemanticBackfill'] = () => backfill;
    const pending = rt.ask({ conversationId: conv.id, projectId: null, question: '停掉我' });
    await new Promise((r) => setTimeout(r, 20));
    const cancelled = rt.cancelAsk(conv.id);
    expect(cancelled.cancelled).toBe(true);
    release();
    const result = await pending;
    expect(calls).toEqual([]);
    expect(conversations.getMessage(result.messageId).status).toBe('cancelled');
  });

  it('条件 2：不取消时照常调用模型，回答是 complete', async () => {
    const { rt, conversations, conv, calls } = runtime();
    const result = await rt.ask({ conversationId: conv.id, projectId: null, question: '在吗' });
    expect(calls).toEqual(['run']);
    expect(conversations.getMessage(result.messageId).status).toBe('complete');
  });

  it('条件 3：回答进行中取消，返回成功，取消之后的内容不再写入', async () => {
    const { rt, conversations, conv, impl } = runtime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    impl.fn = async ({ onDelta, signal }) => {
      onDelta?.('已到');
      await gate;
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      onDelta?.('迟到');
      return { content: '已到迟到' };
    };
    const pending = rt.ask({ conversationId: conv.id, projectId: null, question: '取消我' });
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.cancelAsk(conv.id).cancelled).toBe(true);
    release();
    const result = await pending;
    const message = conversations.getMessage(result.messageId);
    expect(message.content).not.toContain('迟到');
    expect(message.status).toBe('cancelled');
  });
});
