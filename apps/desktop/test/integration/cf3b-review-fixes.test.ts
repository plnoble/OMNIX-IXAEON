/**
 * CF3b 复审补的两条自有回归（`test/integration/`，**不是**锁定验收，不登记指纹）。
 *
 * 1. **runtime_runs 不会永远停在 running**：插了 running 行之后，「选记忆」那一步抛错
 *    （这里把 items 表删掉造出来），这一行必须补成 failed 且有 finished_at，
 *    错误照旧往外抛，交给既有的失败收尾。
 * 2. **工具查到的记忆 tag 用 memoryOriginTag**：查到一条「AI 当时的建议」，
 *    `meta.memoryUsed` 里它的 tag 必须与 `memoryOriginTag(整条)` 一致——
 *    不能一律写成「记忆」，否则 AI 建议会被当成用户说的。
 *
 * 一律不联网：假网关是内存里的 SSE 流；`IXAEON_DATA_DIR` 指临时目录；合成数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: {},
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => Buffer.from(b.toString().replace(/^enc:/, '')),
  },
}));

import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  memoryOriginTag,
  migrate,
  openDatabase,
  setPersonalMemoryToChat,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const SYNTHETIC_KEY = 'sk-synthetic';
const MODEL = 'demo-a';

function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textSse(text: string): Response {
  return streamOf([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}

function toolSse(name: string, args: string): Response {
  return streamOf([
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name, arguments: args } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf3b-fix-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function setup(): { runtime: AppRuntime; conversations: ConversationStore; conversationId: string } {
  const projects = new ProjectService(db);
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const fakeSession = {
    run: async () => ({ answer: '', citations: [], notice: '', usedChars: 0, modelName: MODEL }),
    cancel: () => undefined,
    getEngineSessionId: () => 's-1',
  };
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime as unknown as Record<string, unknown>, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    dataDir: dir,
    config: {
      ...defaultAppConfig(),
      model: {
        ...defaultAppConfig().model,
        modelName: MODEL,
        chatModelName: MODEL,
        apiBaseUrl: 'http://127.0.0.1:9/v1',
        apiKeyEncrypted: Buffer.from(`enc:${SYNTHETIC_KEY}`).toString('base64'),
        apiKeyPresent: true,
        savedModels: [MODEL],
      },
    },
    askSessions: new Map([[conv.id, fakeSession]]),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('cf3b-fix'),
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    jobs: { hold: () => () => undefined },
    imports: {
      captureAsk: () => ({ created: true as const, source: { id: 'src-fix' } }),
    },
    enqueueExtract: () => undefined,
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    newAskSession: () => ({ session: fakeSession, adapter: {} }),
    hermesFound: () => true,
    disposeWarmSession: () => undefined,
    warm: null,
  });
  return { runtime, conversations, conversationId: conv.id };
}

function latestRun(): { engine: string; status: string; finished_at: string | null } | undefined {
  return db
    .prepare('SELECT engine, status, finished_at FROM runtime_runs ORDER BY rowid DESC LIMIT 1')
    .get() as { engine: string; status: string; finished_at: string | null } | undefined;
}

describe('CF3b 复审回归：直连的收尾与记忆 tag', () => {
  it('选记忆那一步抛错 → runtime_runs 那行补成 failed，finished_at 有值', async () => {
    const { runtime, conversationId } = setup();
    // 让 selectForQuestionHybrid 抛错：把 items 表删掉
    db.exec('DROP TABLE items');

    await expect(
      runtime.ask({ conversationId, projectId: null, question: '合成问题' }),
    ).rejects.toBeTruthy();

    const run = latestRun();
    expect(run?.engine).toBe('direct');
    expect(run?.status).toBe('failed');
    expect(run?.finished_at).toBeTruthy();
  });

  it('工具查到的 AI 建议记忆：tag 与 memoryOriginTag(整条) 一致', async () => {
    const items = new ItemService(db);
    const created = items.createManual({
      projectId: null,
      type: 'preference',
      statement: '合成记忆：AI 当时建议先用方案甲',
      rationale: null,
      scope: 'personal',
    });
    // 把它改成「AI 当时的建议、还没被采纳」
    db.prepare(
      "UPDATE items SET origin = 'assistant_suggestion', said_by = 'ai', confirmation = 'none' WHERE id = ?",
    ).run(created.id);
    setPersonalMemoryToChat(db, true);
    const whole = items.get(created.id);
    const expectedTag = memoryOriginTag(whole);
    expect(expectedTag).toContain('AI');

    const gw = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string }>;
      };
      const hasTool = (body.messages ?? []).some((m) => m.role === 'tool');
      return hasTool ? textSse('按那条建议说的') : toolSse('search_memory', '{"query":"方案"}');
    }) as typeof fetch;
    vi.stubGlobal('fetch', gw);
    const { runtime, conversations, conversationId } = setup();

    await runtime.ask({ conversationId, projectId: null, question: '用什么方案好' });

    const messages = conversations.messages(conversationId);
    const last = messages[messages.length - 1]!;
    const meta = (last.meta ?? {}) as { memoryUsed?: Array<{ id: string; tag: string }> };
    const found = (meta.memoryUsed ?? []).find((m) => m.id === created.id);
    expect(found).toBeDefined();
    expect(found?.tag).toBe(expectedTag);
  });
});

