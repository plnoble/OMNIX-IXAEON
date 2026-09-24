/**
 * G06 验收（后端，规格 docs/委派/G06-对话的项目固定.md）
 *
 * 条件 2：在 A 的旧对话里提问，派给引擎的是 A 的上下文（替身截下 run 入参的 projectId）。
 * 条件 3：调用方传来的 projectId 与对话自己的不一致 → VALIDATION_FAILED
 *         「这个对话属于另一个项目，换项目请开新对话」，什么都不发给模型
 *         （替身 run 零调用，对话里不新增消息）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  ConversationStore,
  ErrorCodes,
  FakeCodingExecutor,
  FakeProvider,
  IxaError,
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g06-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const projects = new ProjectService(db);
  const projectA = projects.create({ name: '项目A', rootPath: null, description: null });
  const projectB = projects.create({ name: '项目B', rootPath: null, description: null });
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: projectA.id });
  const seen: Array<string | null> = [];
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('g06'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  runtime['askSessions'].set(conv.id, {
    run: async (input: { projectId: string | null }) => {
      seen.push(input.projectId);
      return {
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
    },
    cancel: () => undefined,
    getEngineSessionId: () => 's-test',
  } as unknown as AgentSession);
  return { runtime, conversations, conv, projectA, projectB, seen };
}

describe('G06 对话的项目固定（后端）', () => {
  it('条件 2：在 A 的对话里提问，派给引擎的是 A 的上下文', async () => {
    const { runtime, conv, projectA, seen } = setup();
    await runtime.ask({ conversationId: conv.id, projectId: projectA.id, question: '做到哪了' });
    expect(seen).toEqual([projectA.id]);
  });

  it('条件 3：传来与对话不一致的 projectId 就拒绝，什么都不发给模型', async () => {
    const { runtime, conversations, conv, projectB, seen } = setup();
    const before = conversations.messages(conv.id).length;
    const err = await runtime
      .ask({ conversationId: conv.id, projectId: projectB.id, question: '做到哪了' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(IxaError);
    expect((err as IxaError).code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect((err as IxaError).message).toContain('这个对话属于另一个项目，换项目请开新对话');
    expect(seen).toEqual([]);
    expect(conversations.messages(conv.id).length).toBe(before);
  });
});
