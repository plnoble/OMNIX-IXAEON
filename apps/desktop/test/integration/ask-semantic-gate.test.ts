/**
 * 第一问不许抢在补向量前面（2026-09-18 真机回归）。
 *
 * 真机记录：应用 06:00:37 启动，那次补向量撞上 Ollama 未就绪（日志
 * 「语义索引暂不可用」），用户随即提问，06:02:41 才补完 80 条。那一问整轮按
 * 关键词选材，又把 7 月的门店开业资料塞给了模型——正是语义检索要解决的问题。
 *
 * 断言的是顺序：模型被调用时，补向量必须已经结束。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

let dir: string;
let db: CoreDatabase;
let provider: FakeProvider;

const prevExe = process.env.IXAEON_HERMES_EXE;
const prevHome = process.env.IXAEON_HERMES_HOME;
const prevInstallerHome = process.env.HERMES_HOME;

interface TestRuntime {
  ask(input: {
    conversationId?: string | null;
    projectId: string | null;
    question: string;
  }): Promise<{ conversationId: string }>;
}

beforeEach(() => {
  delete process.env.IXAEON_HERMES_EXE;
  delete process.env.IXAEON_HERMES_HOME;
  delete process.env.HERMES_HOME;
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-gate-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  provider = new FakeProvider('fake-model-v1');
});

afterEach(() => {
  if (db.open) db.close();
  if (prevExe !== undefined) process.env.IXAEON_HERMES_EXE = prevExe;
  if (prevHome !== undefined) process.env.IXAEON_HERMES_HOME = prevHome;
  if (prevInstallerHome !== undefined) process.env.HERMES_HOME = prevInstallerHome;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

/** 记录调用顺序的假语义索引：backfill 慢一点，好看出有没有真的等它。 */
function makeIndex(order: string[], opts: { delayMs?: number; fail?: boolean } = {}) {
  return {
    modelId: 'test:slow',
    backfill: async () => {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 60));
      order.push('backfill');
      if (opts.fail === true) throw new Error('连不上本机向量服务（Ollama 是否在运行？）');
      return { embedded: 3, remaining: 0 };
    },
  };
}

function makeRuntime(index: unknown): TestRuntime {
  const runtime = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  runtime['db'] = db;
  runtime['conversations'] = new ConversationStore(db);
  runtime['items'] = new ItemService(db);
  runtime['search'] = new SearchService(db);
  runtime['projects'] = new ProjectService(db);
  runtime['coding'] = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
  runtime['askSessions'] = new Map();
  runtime['activeAskRuns'] = new Map();
  runtime['getProvider'] = () => provider;
  runtime['hermesFound'] = () => false;
  runtime['getTinyFishFetcher'] = () => null;
  runtime['getWebSearchExecutor'] = () => null;
  runtime['ensureAskCapturePermission'] = () => null;
  runtime['semanticIndex'] = index;
  runtime['semanticBackfillRun'] = null;
  runtime['logger'] = { warn: () => undefined, info: () => undefined };
  return runtime as unknown as TestRuntime;
}

describe('提问与补向量的先后', () => {
  it('补向量没跑完就提问：等它跑完再交给模型', async () => {
    const order: string[] = [];
    const runtime = makeRuntime(makeIndex(order));
    provider.enqueueStructured({ tool: 'answer', args: { text: '好' } });
    provider.beforeStructured = () => order.push('model');
    await runtime.ask({ conversationId: null, projectId: null, question: '我最近在忙什么？' });
    expect(order).toEqual(['backfill', 'model']);
  });

  it('向量服务连不上：不卡住提问，照常回答', async () => {
    const order: string[] = [];
    const runtime = makeRuntime(makeIndex(order, { fail: true }));
    provider.enqueueStructured({ tool: 'answer', args: { text: '好' } });
    const r = await runtime.ask({
      conversationId: null,
      projectId: null,
      question: '今晚吃什么？',
    });
    expect(r.conversationId).toBeTruthy();
    expect(order).toEqual(['backfill']);
  });

  it('没配语义索引（IXAEON_EMBED_MODEL=none）：照常提问', async () => {
    const runtime = makeRuntime(null);
    provider.enqueueStructured({ tool: 'answer', args: { text: '好' } });
    const r = await runtime.ask({ conversationId: null, projectId: null, question: '在吗？' });
    expect(r.conversationId).toBeTruthy();
  });
});
