/**
 * P1 会话预热：主进程这一层（2026-09-18）。
 *
 * 适配器层（真的只建会话、第一问复用、参数变了冷启动）见
 * packages/core/test/integration/session-prewarm.test.ts；这里验证谁在什么时候用它：
 * 新对话第一问接走预热好的会话、项目不同不接、答完再备一个、设置变化与撤权时释放、
 * 正在答题时不预热、没装 Hermes 时什么都不做。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSession,
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  HermesRuntimeAdapter,
  ItemService,
  ProjectService,
  SearchService,
  migrate,
  openDatabase,
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

interface WarmRuntime {
  prewarmChat(projectId: string | null): Promise<{ warmed: boolean }>;
  ask(input: {
    conversationId?: string | null;
    projectId: string | null;
    question: string;
  }): Promise<{ conversationId: string }>;
  resetChatSessions(): number;
  invalidateContext(): void;
  askSessions: Map<string, AgentSession>;
  activeAskRuns: Map<string, string>;
  warm: { session: AgentSession; contextRef: string } | null;
}

function makeRuntime(opts: { hermes?: boolean } = {}): WarmRuntime {
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  Object.assign(rt, {
    db,
    config: {
      model: { modelName: 'm', chatModelName: '' },
      hermesBridge: { enabled: false, token: null },
    },
    conversations: new ConversationStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    warm: null,
    warming: false,
    rewarmAfterAsk: false,
    getProvider: () => null,
    hermesFound: () => opts.hermes ?? true,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
  });
  return rt as unknown as WarmRuntime;
}

function answer(): AgentSessionResult {
  return {
    answer: '好',
    citations: [],
    notice: '本轮经 Hermes TUI gateway',
    usedChars: 1,
    modelName: 'hermes',
    engine: 'hermes',
    runId: 'r',
    steps: [],
  };
}

describe('会话预热：谁在什么时候用它', () => {
  it('新对话第一问接走预热好的会话；答完再备一个', async () => {
    const prewarm = vi.spyOn(HermesRuntimeAdapter.prototype, 'prewarm').mockResolvedValue(true);
    vi.spyOn(AgentSession.prototype, 'run').mockResolvedValue(answer());
    const rt = makeRuntime();
    expect(await rt.prewarmChat(null)).toEqual({ warmed: true });
    const warmSession = rt.warm!.session;

    const r = await rt.ask({ conversationId: null, projectId: null, question: '在吗' });
    expect(rt.askSessions.get(r.conversationId)).toBe(warmSession);
    expect(rt.warm).toBeNull();

    // 答完约 1 秒后再备一个，下一个新对话也不用等
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(prewarm).toHaveBeenCalledTimes(2);
    expect(rt.warm).not.toBeNull();
    expect(rt.warm!.session).not.toBe(warmSession);
  });

  it('项目不同不接：预热的是个人视角，项目里提问照常新建', async () => {
    vi.spyOn(HermesRuntimeAdapter.prototype, 'prewarm').mockResolvedValue(true);
    vi.spyOn(AgentSession.prototype, 'run').mockResolvedValue(answer());
    const rt = makeRuntime();
    await rt.prewarmChat(null);
    const warmSession = rt.warm!.session;
    const project = new ProjectService(db).create({ name: 'P', rootPath: null, description: null });
    const r = await rt.ask({ conversationId: null, projectId: project.id, question: '在吗' });
    expect(rt.askSessions.get(r.conversationId)).not.toBe(warmSession);
    expect(rt.warm?.session).toBe(warmSession);
  });

  it('换了设置（聊天模型、记忆桥）或撤权：预热的会话释放掉', async () => {
    vi.spyOn(HermesRuntimeAdapter.prototype, 'prewarm').mockResolvedValue(true);
    const invalidate = vi.spyOn(AgentSession.prototype, 'invalidateContext');
    const rt = makeRuntime();
    await rt.prewarmChat(null);
    rt.resetChatSessions();
    expect(rt.warm).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);

    await rt.prewarmChat(null);
    rt.invalidateContext();
    expect(rt.warm).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('正在答题时不预热（Hermes 组装也会访问模型网关，别抢并发名额）', async () => {
    const prewarm = vi.spyOn(HermesRuntimeAdapter.prototype, 'prewarm').mockResolvedValue(true);
    const rt = makeRuntime();
    rt.activeAskRuns.set('c', 'run');
    expect(await rt.prewarmChat(null)).toEqual({ warmed: false });
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('没装 Hermes：什么都不做', async () => {
    const prewarm = vi.spyOn(HermesRuntimeAdapter.prototype, 'prewarm').mockResolvedValue(true);
    const rt = makeRuntime({ hermes: false });
    expect(await rt.prewarmChat(null)).toEqual({ warmed: false });
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('预热失败：不留预热会话，也不抛给界面', async () => {
    vi.spyOn(HermesRuntimeAdapter.prototype, 'prewarm').mockRejectedValue(new Error('spawn 失败'));
    const rt = makeRuntime();
    expect(await rt.prewarmChat(null)).toEqual({ warmed: false });
    expect(rt.warm).toBeNull();
  });
});
