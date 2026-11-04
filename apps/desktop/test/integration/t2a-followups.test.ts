/**
 * T2a 并入时整合方补的（锁定验收之外）：
 * - 问答存档（记忆提炼的输入）和 ask() 的返回值都用拆掉「建议待办」段之后的回答：
 *   这些事已经是待办了，不该再被提炼成一条「AI 建议」；
 * - 这一轮回答失败，你写的「待办：…」照样加上了，提示也要留在这条回答上。
 *
 * CF3c 起聊天只走直连：模型通道从 `chatStreamClient` 接缝拿（原来注入 Hermes 替身会话）。
 * 全是合成数据。
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
  ImportService,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  Vault,
  migrate,
  openDatabase,
  type ChatStreamResult,
  type CoreDatabase,
  type StreamChatClient,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
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

let db: CoreDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t2a-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 假模型客户端：吐一段固定回答，或直接抛错。 */
function answerClient(answer: string): StreamChatClient {
  return {
    modelName: 'demo-a',
    async stream(input) {
      input.onDelta?.(answer);
      return {
        content: answer,
        toolCalls: [],
        finishReason: 'stop',
        toolsUnsupported: false,
      } satisfies ChatStreamResult;
    },
  };
}

function errorClient(message: string): StreamChatClient {
  return {
    modelName: 'demo-a',
    async stream() {
      throw new Error(message);
    },
  };
}

/** 真实 ask() 与问答存档，模型走 chatStreamClient 替身。 */
function runtimeWith(client: StreamChatClient) {
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const permissions = new PermissionService(db);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    todos,
    permissions,
    imports: new ImportService(db, new Vault(join(dir, 'vault')), permissions, new SourceStore(db)),
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
        apiKeyEncrypted: Buffer.from('enc:sk-synthetic').toString('base64'),
        apiKeyPresent: true,
        savedModels: ['demo-a'],
      },
    },
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    chatStreamClient: () => client,
    getProvider: () => new FakeProvider('t2a-f'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    enqueueExtract: () => undefined,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
  });
  const conv = conversations.create({ projectId: null });
  return { runtime, conversations, todos, conv };
}

describe('T2a 补：建议待办不进记忆、失败也留提示', () => {
  it('问答存档与返回值里都没有「建议待办」那一段', async () => {
    const { runtime, conv } = runtimeWith(
      answerClient('先把报价核一遍。\n\n建议待办：\n- 周五前把报价发给客户\n- 预约下周体检'),
    );
    const r = await runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: '这周做啥？',
    });
    expect(r.answer).toBe('先把报价核一遍。');

    const source = db
      .prepare("SELECT id FROM sources WHERE provider = 'ask_session' AND external_id = ?")
      .get(conv.id) as { id: string } | undefined;
    expect(source).toBeDefined();
    const texts = (
      db
        .prepare('SELECT role, text FROM segments WHERE source_id = ? ORDER BY sequence')
        .all(source!.id) as Array<{ role: string; text: string }>
    ).map((s) => [s.role, s.text]);
    expect(texts).toEqual([
      ['user', '这周做啥？'],
      ['assistant', '先把报价核一遍。'],
    ]);
  });

  it('回答失败：你写的「待办：…」已经加上，这条回答上留着「已加到待办」的依据', async () => {
    const { runtime, conversations, todos, conv } = runtimeWith(errorClient('合成的网关错误'));
    await runtime.ask({ conversationId: conv.id, projectId: null, question: '待办：周五前交报销单' });

    const [added] = todos.list();
    expect(added).toMatchObject({ title: '周五前交报销单', status: 'accepted' });
    const failed = conversations.messages(conv.id).find((m) => m.role === 'assistant')!;
    expect(failed.status).toBe('failed');
    expect(failed.meta['userTodo']).toEqual({ id: added!.id, title: '周五前交报销单' });
  });
});
