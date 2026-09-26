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
    askSessions: new Map(),
    warmSession: null,
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
  return { rt, conversations, conv };
}

it('第一次提问还没有会话时，准备阶段取消：不建会话、不调用模型、回答是 cancelled', async () => {
  const { rt, conversations, conv } = runtime();
  let created = 0;
  rt['newAskSession'] = () => {
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
  expect(rt['askSessions'].size).toBe(0);
  expect(conversations.getMessage(result.messageId).status).toBe('cancelled');
});

it('回答进行中取消时，会话收到的是这一轮的 runId', async () => {
  const { rt, conversations, conv } = runtime();
  const cancelled: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  rt['askSessions'].set(conv.id, {
    run: async (input: { runId?: string; onDelta?: (text: string) => void }) => {
      input.onDelta?.('已到');
      await gate;
      return {
        answer: '好的',
        citations: [],
        notice: '用户取消 Hermes 会话',
        usedChars: 1,
        modelName: 'hermes',
        engine: 'hermes',
        runId: input.runId ?? 'run',
        steps: [],
        memoryUsed: [],
      };
    },
    cancel: (runId: string) => {
      cancelled.push(runId);
    },
    getEngineSessionId: () => 's-test',
  } as unknown as AgentSession);
  const pending = rt.ask({ conversationId: conv.id, projectId: null, question: '取消我' });
  await new Promise((r) => setTimeout(r, 20));
  const res = rt.cancelAsk(conv.id);
  expect(res.cancelled).toBe(true);
  expect(cancelled).toEqual([res.runId]);
  release();
  const result = await pending;
  expect(conversations.getMessage(result.messageId).status).toBe('cancelled');
});
