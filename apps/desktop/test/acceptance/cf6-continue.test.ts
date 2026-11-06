/**
 * CF6 条件 5：重开后接着聊（替身直连客户端）。
 * 会话先聊两轮 → 归档 → 恢复 → 再问一句；这一次发给模型的消息里，
 * 前两轮的问和答按顺序都在。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
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
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf6-continue-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});
afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  messages: Array<{ role: string; content: string }>;
}

function fixture(): { runtime: AppRuntime; convId: string; seen: Seen[] } {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const seen: Seen[] = [];
  const base = defaultAppConfig();
  const config = {
    ...base,
    model: { ...base.model, modelName: '', chatModelName: '' },
    providers: [],
    uses: {},
  } as AppConfig;
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
    directAskAborts: new Map(),
    askDeltaSink: null,
    askProgressSink: null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    jobs: {
      enqueue: () => ({ id: 'job-1' }),
      enqueueExtract: () => undefined,
      hold: () => () => undefined,
      isHeld: () => false,
      kick: () => undefined,
      stop: () => undefined,
      idle: () => true,
      idleExecution: () => true,
      isExecuting: () => false,
      register: () => undefined,
    },
    imports: { captureAsk: () => ({ created: true as const, source: { id: 'src-ask' } }) },
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    permissions: { grantDomain: () => ({ created: false }) },
    chatStreamClient: () => ({
      modelName: 'demo-a',
      stream: async (input: Seen) => {
        seen.push({ messages: input.messages.map((m) => ({ role: m.role, content: m.content })) });
        return { content: '回答' + seen.length, toolCalls: [], finishReason: 'stop' };
      },
    }),
  });
  const p = runtime.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKey: 'sk-synthetic-a1b2c3d4',
    savedModels: ['demo-a'],
  });
  runtime.saveModelUses({ chat: { providerId: p.id, model: 'demo-a' } });
  return { runtime, convId: conv.id, seen };
}

describe('CF6 条件 5：重开后接着聊', () => {
  it('先两轮 → 归档 → 恢复 → 再问：这一次的上下文里前两轮问答按顺序都在', async () => {
    const { runtime, convId, seen } = fixture();
    await runtime.ask({ conversationId: convId, projectId: null, question: '第一问' } as never);
    await runtime.ask({ conversationId: convId, projectId: null, question: '第二问' } as never);
    runtime.conversations.archive(convId);
    runtime.conversations.unarchive(convId);
    await runtime.ask({ conversationId: convId, projectId: null, question: '第三问' } as never);

    const last = seen.at(-1)!;
    const texts = last.messages.map((m) => m.content);
    const at = (s: string): number => texts.findIndex((t) => t.includes(s));
    // 前两轮的问和答都在，且顺序正确
    expect(at('第一问')).toBeGreaterThanOrEqual(0);
    expect(at('回答1')).toBeGreaterThan(at('第一问'));
    expect(at('第二问')).toBeGreaterThan(at('回答1'));
    expect(at('回答2')).toBeGreaterThan(at('第二问'));
    expect(at('第三问')).toBeGreaterThan(at('回答2'));
  });
});
