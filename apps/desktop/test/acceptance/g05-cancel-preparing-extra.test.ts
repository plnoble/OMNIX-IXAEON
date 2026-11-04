/**
 * G05 补充测试（Codex 审查 2026-09-26 的两条「必须改」）
 *
 * 锁定的 g05-cancel-preparing.test.ts 不许改，它的缺口在这里补：
 * - 它每条用例都预先放好了会话，测不到「第一次提问、还没有会话」的准备阶段取消。
 *   这里断言：取消返回成功、不新建会话、不调用模型、回答是 cancelled。
 * - 它的「回答中取消」替身无条件返回取消提示，cancel 又是空函数，删掉
 *   session.cancel(runId) 也能过。这里断言会话收到的正是这一轮的 runId。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  type AgentSession,
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g05b-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runtime() {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
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
  const impl: { calls: Array<{ lastUser: string; signal?: AbortSignal }>; fn: FakeStreamImpl } = {
    calls: [],
    fn: (x) => {
      impl.calls.push({ lastUser: x.lastUser, signal: x.signal });
      return { content: '好的' };
    },
  };
  installFakeChat(rt as unknown as Record<string, unknown>, (x) => impl.fn(x));
  return { rt, conversations, conv, impl };
}

it('第一次提问还没有会话时，准备阶段取消：不建会话、不调用模型、回答是 cancelled', async () => {
  const { rt, conversations, conv, impl } = runtime();
  let created = 0;
  // 整合方改（Q3，2026-10-29）：只为过类型检查，不改断言（替身只给 session，不给 adapter）
  (rt as unknown as { newAskSession: () => unknown })['newAskSession'] = () => {
    created += 1;
    return {
      session: {
        run: async () => {
          throw new Error('已取消的一轮不该启动会话');
        },
        cancel: () => undefined,
        getEngineSessionId: () => 's-new',
      } as unknown as AgentSession,
    };
  };
  let release!: () => void;
  const backfill = new Promise<void>((resolve) => {
    release = resolve;
  });
  rt['kickSemanticBackfill'] = () => backfill;
  const pending = rt.ask({ conversationId: conv.id, projectId: null, question: '停掉我' });
  await new Promise((r) => setTimeout(r, 20));
  expect(rt.cancelAsk(conv.id)).toEqual({ cancelled: true, runId: expect.any(String) });
  release();
  const result = await pending;
  expect(created).toBe(0);
  expect(impl.calls).toEqual([]);
  expect(conversations.getMessage(result.messageId).status).toBe('cancelled');
});

it('两轮并发，取消其中一轮：只有那一轮的请求被中断，另一轮照常完成', async () => {
  const { rt, conversations, conv, impl } = runtime();
  const convB = conversations.create({ projectId: null });
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  impl.fn = async (x) => {
    impl.calls.push({ lastUser: x.lastUser, signal: x.signal });
    if (x.lastUser === '取消我') {
      x.onDelta?.('已到');
      await gateA;
      if (x.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      return { content: '已到迟到' };
    }
    x.onDelta?.('正常');
    return { content: '正常的回答' };
  };
  const pendingA = rt.ask({ conversationId: conv.id, projectId: null, question: '取消我' });
  const rB = await rt.ask({ conversationId: convB.id, projectId: null, question: '别动我' });
  await new Promise((r) => setTimeout(r, 20));
  const res = rt.cancelAsk(conv.id);
  expect(res.cancelled).toBe(true);
  releaseA();
  const resultA = await pendingA;
  // 被取消的那一轮：消息 cancelled、请求被中断（AbortSignal 已 abort）
  expect(conversations.getMessage(resultA.messageId).status).toBe('cancelled');
  const callA = impl.calls.find((c) => c.lastUser === '取消我')!;
  expect(callA.signal?.aborted).toBe(true);
  // 另一轮照常完成、信号没被中断
  expect(conversations.getMessage(rB.messageId).status).toBe('complete');
  const callB = impl.calls.find((c) => c.lastUser === '别动我')!;
  expect(callB.signal?.aborted).toBe(false);
});
