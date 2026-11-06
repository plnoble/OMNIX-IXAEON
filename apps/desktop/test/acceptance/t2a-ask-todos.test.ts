/**
 * T2a 验收（整合方写死，执行方不改）：提问一轮之后，待办落到库里、记在这条回答上。
 * 委派单：docs/委派/T2a-聊天里的待办.md
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
import { installFakeChat } from './cf3cb-fake-chat.js';

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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t2a-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 真实 ask()，会话用替身：回答内容由参数给。 */
function runtimeAnswering(answer: string) {
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    todos,
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('t2a'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  installFakeChat(runtime as unknown as Record<string, unknown>, () => ({ content: answer }));
  const conv = conversations.create({ projectId: null });
  return { runtime, conversations, todos, conv };
}

describe('AI 在回答末尾列的待办', () => {
  // 整合方 2026-11-06（CF2：回答末尾的「建议待办」不再变成待办、不再从回答里拆掉，用户 11-03 定）退役：「落成等你拍板的待办，记着来自哪次对话、哪条回答；回答里去掉那一段」

  // 整合方 2026-11-06（CF2：回答末尾的「建议待办」不再变成待办、不再从回答里拆掉，用户 11-03 定）退役：「你拒绝过的同一件事不再提，也不出现在这条回答上」

  it('回答里没有这一段：不建待办，也不记 proposedTodos', async () => {
    const { runtime, conversations, todos, conv } = runtimeAnswering('今天不用做什么。');
    const r = await runtime.ask({ conversationId: conv.id, projectId: null, question: '有事吗？' });
    expect(todos.list()).toEqual([]);
    expect(conversations.getMessage(r.messageId).meta['proposedTodos']).toBeUndefined();
  });
});

describe('你在消息开头写「待办：」', () => {
  it('直接加成要做的待办，记着是你哪条消息；回答上注明已加', async () => {
    const { runtime, conversations, todos, conv } = runtimeAnswering('好的，记下了。');
    const r = await runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: '待办：周五前交报销单',
    });
    const [added] = todos.list();
    expect(added).toMatchObject({
      title: '周五前交报销单',
      status: 'accepted',
      origin: 'user',
      conversation_id: conv.id,
    });
    const userMsg = conversations
      .messages(conv.id)
      .find((m) => m.role === 'user' && m.content === '待办：周五前交报销单')!;
    expect(added!.message_id).toBe(userMsg.id);
    expect(conversations.getMessage(r.messageId).meta['userTodo']).toEqual({
      id: added!.id,
      title: '周五前交报销单',
    });
  });
});
