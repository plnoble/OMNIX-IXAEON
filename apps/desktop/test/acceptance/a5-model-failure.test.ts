/**
 * A5 验收（后端，规格 docs/委派/A5-模型出错的轮记成失败.md）——B 档：先只推测试，
 * 整合方看过并锁定后再写实现（现在这些测试按现状实现应失败）。
 *
 * 逐条对应规格验收条件：
 * - 条件 1：core-bounded 工具循环里模型调用失败（会抛错的假模型/替身返回步骤
 *   model 失败）：消息收尾 failed、error_message 有这次的错误、正文不放「模型动作失败」
 *   这类错误文字、已答出的半截照常保留。
 * - 条件 2：这一轮不存档、不排提炼，回报里没有「问答已存入」。
 * - 条件 3：下一轮的上下文（priorTurns 只取 complete）里没有这一轮。
 * - 条件 4：工具失败但模型最后正常回答了：照旧 complete、照常存档。
 * - 条件 5：Hermes 引擎出错走抛错收尾 failed 的既有路径——现有套件照过，本文件不重复。
 * - 条件 6：判定不靠回答文字：模型正常回答的内容里恰好含「模型动作失败」字样，
 *   照旧 complete。
 *
 * 钉住的接缝（实现必须兼容）：
 * - 判定来源 = 会话结果的结构化步骤（result.steps 里 tool==='model' 且 !ok，且没有
 *   正常回答步骤），不许匹配回答正文；
 * - `appRuntime.ask` 收尾：这种轮 status='failed'、errorMessage=模型那步的 detail，
 *   content=已答半截（error 文字不放进去）；
 * - 存档门槛：这种轮 `captureAsk` 不调、`enqueueExtract` 不跑。
 *
 * 整合方锁定前改与补（2026-10-03，规格末尾「整合方审测试时的改正与补充」）：
 * - 条件 3 改正：现有规则（recentTurns 只取 complete）下，失败轮里用户自己的提问本来就留在
 *   下一轮的上下文里（Hermes 出错的轮也是这样），不改；要保证的是失败轮的助手内容不进去。
 * - 补「真的工具循环」：上面的用例全靠替身会话手写结果，没有一条让真的 AgentSession
 *   （core-bounded）出一次错再看 ask 怎么收尾——替身的步骤和真引擎对不上时测试照过、线上
 *   永远触发不了。新增用例用真的 AgentSession + 假模型。
 * - 补条件 7：到了轮次上限还没形成最终回答，同样记成失败（工具循环自己已经把这一轮判成失败，
 *   返回的是「已达轮次上限，未形成最终回答」这段话）。
 * - 补条件 8：Hermes 的结果里本来就没有 answer 步（它的步骤是 text、terminal），不许误判。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSession as RealAgentSession,
  CodingOrchestrator,
  ConversationStore,
  CoreToolBroker,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type AgentSession,
  type AskResult,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: {},
  shell: {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => true },
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a5-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function messageResult(
  answer: string,
  steps: Array<{ round: number; tool: string; ok: boolean; detail?: string }>,
): AskResult {
  return {
    answer,
    citations: [],
    notice: '本轮走 Core 有界工具循环（不是 Hermes）。',
    usedChars: 0,
    modelName: 'fake-model',
    engine: 'core-bounded' as const,
    runId: 'run-1',
    steps,
    memoryUsed: [],
  };
}

interface SessionCall {
  goal: string;
  priorTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

function setup(results: AskResult[]) {
  const projects = new ProjectService(db);
  projects.create({ name: 'A5 项目', rootPath: null, description: null });
  const conversations = new ConversationStore(db);
  // 既有历史：一轮正常问答（complete），之后的 priorTurns 里只该有它
  const conv = conversations.create({ projectId: null });
  conversations.appendMessage(conv.id, { role: 'user', content: '之前问的' });
  conversations.appendMessage(conv.id, { role: 'assistant', content: '之前答的' });

  const calls: SessionCall[] = [];
  let cursor = 0;
  const fakeSession = {
    run: async (input: {
      goal: string;
      priorTurns: SessionCall['priorTurns'];
    }): Promise<AskResult> => {
      calls.push({ goal: input.goal, priorTurns: input.priorTurns ?? [] });
      const next = results[Math.min(cursor, results.length - 1)] ?? results[results.length - 1]!;
      cursor += 1;
      return next;
    },
    cancel: () => undefined,
    getEngineSessionId: () => 's-a5',
  } as unknown as AgentSession;

  const captureAsk = vi.fn(() => ({ created: true as const, source: { id: 'src-ask' } }));
  const captured = new Array<string>();
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    askSessions: new Map([[conv.id, fakeSession]]),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('a5'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    jobs: { hold: () => () => undefined },
    imports: {
      captureAsk: (input: { answer: string }) => {
        captured.push(input.answer);
        return captureAsk(input);
      },
    },
    enqueueExtract: vi.fn(() => undefined),
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
  });
  return { runtime, conversations, conv, calls, captureAsk, captured };
}

describe('A5 模型出错的轮记成失败（后端）', () => {
  it('条件 1：模型调用失败 → failed + error_message，错误文字不进正文，半截保留', async () => {
    const { runtime, conversations, conv } = setup([
      messageResult('模型动作失败：网关挂了，稍后重试', [
        { round: 1, tool: 'model', ok: false, detail: '网关挂了，稍后重试' },
      ]),
    ]);
    const result = await runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: 'A5 触发失败',
    });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('failed');
    expect(last.errorMessage ?? '').toContain('网关挂了');
    expect(last.content).not.toContain('模型动作失败');
    expect(result.answer).not.toContain('模型动作失败');
  });

  it('条件 1（半截）：失败前已经答出的内容照常保留', async () => {
    const { runtime, conversations, conv } = setup([]);
    // 替身跑一轮时先给一段 delta（模拟 Hermes/库里已有的半截），再返回失败
    const fake = {
      run: async (input: {
        goal: string;
        priorTurns: unknown;
        onDelta?: (text: string) => void;
      }): Promise<AskResult> => {
        input.onDelta?.('已经答出的半截');
        return messageResult('模型动作失败：网关挂了', [
          { round: 1, tool: 'model', ok: false, detail: '网关挂了' },
        ]);
      },
      cancel: () => undefined,
      getEngineSessionId: () => 's-a5',
    } as unknown as AgentSession;
    (runtime as Record<string, unknown>)['askSessions'] = new Map([[conv.id, fake]]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 触发失败' });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('failed');
    expect(last.content).toContain('已经答出的半截');
    expect(last.content).not.toContain('模型动作失败');
  });

  it('条件 2：失败轮不存档、不排提炼、回报没有「问答已存入」', async () => {
    const { runtime, conv, captureAsk, captured } = setup([
      messageResult('模型动作失败：网关挂了', [
        { round: 1, tool: 'model', ok: false, detail: '网关挂了' },
      ]),
    ]);
    const result = await runtime.ask({
      conversationId: conv.id,
      projectId: null,
      question: 'A5 触发失败',
    });
    expect(captureAsk).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    expect(result.notice ?? '').not.toContain('问答已存入');
  });

  it('条件 3：下一轮的上下文里没有这一轮', async () => {
    const { runtime, conv, calls } = setup([
      messageResult('模型动作失败：网关挂了', [
        { round: 1, tool: 'model', ok: false, detail: '网关挂了' },
      ]),
      messageResult('第二问的正常回答', [{ round: 1, tool: 'answer', ok: true }]),
    ]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 触发失败' });
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 第二问' });
    const second = calls[1]!;
    // 失败轮的助手内容不进上下文；用户自己的那句提问照现有规则留着（不改 recentTurns）
    expect(second.priorTurns.filter((t) => t.role === 'assistant').map((t) => t.content)).toEqual([
      '之前答的',
    ]);
    expect(second.priorTurns.map((t) => t.content)).toEqual([
      '之前问的',
      '之前答的',
      'A5 触发失败',
    ]);
    expect(JSON.stringify(second.priorTurns)).not.toContain('模型动作失败');
    expect(JSON.stringify(second.priorTurns)).not.toContain('网关挂了');
  });

  it('条件 4：工具失败但模型最后正常回答 → complete，照常存档', async () => {
    const { runtime, conversations, conv, captureAsk } = setup([
      messageResult('虽然搜索失败，但我已经回答好了', [
        { round: 1, tool: 'search_memory', ok: false, detail: '搜索超时' },
        { round: 2, tool: 'answer', ok: true },
      ]),
    ]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 工具失败' });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('complete');
    expect(last.content).toContain('已经回答好了');
    expect(captureAsk).toHaveBeenCalled();
  });

  it('条件 6：正常回答的内容里恰好含「模型动作失败」字样 → 照旧 complete', async () => {
    const { runtime, conversations, conv, captureAsk } = setup([
      messageResult('「模型动作失败」是个短语，这里用它造句，回答本身完全正常。', [
        { round: 1, tool: 'answer', ok: true },
      ]),
    ]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 字样测试' });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('complete');
    expect(last.content).toContain('模型动作失败');
    expect(captureAsk).toHaveBeenCalled();
  });
});
/**
 * 整合方补：用真的工具循环（AgentSession，core-bounded）+ 假模型，从引擎一路测到 ask 收尾。
 * 本机装了 Hermes 时安装器会留下 HERMES_HOME，先清掉定位变量，保证走的是核心层这条路。
 */
describe('A5（整合方补）：真的工具循环出错，ask 怎么收尾', () => {
  const saved: Record<string, string | undefined> = {};
  const HERMES_VARS = ['IXAEON_HERMES_EXE', 'IXAEON_HERMES_HOME', 'HERMES_HOME'];

  beforeEach(() => {
    for (const k of HERMES_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of HERMES_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function setupReal(provider: FakeProvider) {
    const h = setup([]);
    const projects = new ProjectService(db);
    const broker = new CoreToolBroker(
      db,
      new ItemService(db),
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data-real')),
      projects,
    );
    const session = new RealAgentSession(db, new HermesRuntimeAdapter(), broker, provider);
    (h.runtime as unknown as Record<string, unknown>)['askSessions'] = new Map([
      [h.conv.id, session],
    ]);
    return h;
  }
  const lastMessage = (h: ReturnType<typeof setup>) => {
    const messages = h.conversations.messages(h.conv.id);
    return messages[messages.length - 1]!;
  };

  it('模型调用失败（假模型没有响应）：failed、错误进 error_message、不存档；下一轮模型读不到这段错误', async () => {
    const provider = new FakeProvider('a5-real');
    const h = setupReal(provider);
    const result = await h.runtime.ask({
      conversationId: h.conv.id,
      projectId: null,
      question: 'A5 真引擎触发失败',
    });
    const failed = lastMessage(h);
    expect(failed.engine).toBe('core-bounded');
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage ?? '').toContain('FakeProvider 队列为空');
    expect(failed.content).not.toContain('模型动作失败');
    expect(result.answer).not.toContain('模型动作失败');
    expect(h.captureAsk).not.toHaveBeenCalled();
    expect(result.notice ?? '').not.toContain('问答已存入');

    // 下一轮：模型正常回答；发给模型的内容里没有上一轮的错误文字
    provider.enqueueStructured({ tool: 'answer', args: { text: '第二问的正常回答' } });
    await h.runtime.ask({
      conversationId: h.conv.id,
      projectId: null,
      question: 'A5 真引擎第二问',
    });
    const ok = lastMessage(h);
    expect(ok.status).toBe('complete');
    expect(ok.content).toContain('第二问的正常回答');
    const sent = provider.structuredCalls[provider.structuredCalls.length - 1]!.user;
    expect(sent).not.toContain('模型动作失败');
    expect(sent).not.toContain('FakeProvider 队列为空');
    expect(h.captureAsk).toHaveBeenCalledTimes(1);
  });

  it('条件 7：到了轮次上限还没形成最终回答：failed、不存档，那段话不当回答', async () => {
    const provider = new FakeProvider('a5-real');
    // 工具循环最多 4 轮：四轮都去查记忆，始终不给最终回答
    for (let i = 0; i < 4; i += 1) {
      provider.enqueueStructured({ tool: 'search_memory', args: { query: `第 ${i} 次` } });
    }
    const h = setupReal(provider);
    const result = await h.runtime.ask({
      conversationId: h.conv.id,
      projectId: null,
      question: 'A5 一直查不回答',
    });
    const m = lastMessage(h);
    expect(m.status).toBe('failed');
    expect(m.errorMessage ?? '').toContain('轮次上限');
    expect(m.content).not.toContain('已达轮次上限');
    expect(result.answer).not.toContain('已达轮次上限');
    expect(h.captureAsk).not.toHaveBeenCalled();
    expect(result.notice ?? '').not.toContain('问答已存入');
  });

  it('对照：真的工具循环正常回答（中间查过一次记忆）→ complete，照常存档', async () => {
    const provider = new FakeProvider('a5-real');
    provider.enqueueStructured({ tool: 'search_memory', args: { query: '之前' } });
    provider.enqueueStructured({ tool: 'answer', args: { text: '真引擎的正常回答' } });
    const h = setupReal(provider);
    await h.runtime.ask({ conversationId: h.conv.id, projectId: null, question: 'A5 正常一问' });
    const m = lastMessage(h);
    expect(m.status).toBe('complete');
    expect(m.content).toContain('真引擎的正常回答');
    expect(h.captureAsk).toHaveBeenCalledTimes(1);
  });
});

describe('A5（整合方补）条件 8：Hermes 的结果没有 answer 步，不许误判', () => {
  it('引擎是 hermes、步骤只有 text / terminal、正常回答 → complete，照常存档', async () => {
    const hermesResult: AskResult = {
      ...messageResult('Hermes 的正常回答', [
        { round: 1, tool: 'text', ok: true },
        { round: 2, tool: 'terminal', ok: true },
      ]),
      engine: 'hermes' as const,
      modelName: 'hermes',
      notice: '本轮经 Hermes TUI gateway（stdio JSON-RPC）。',
    };
    const { runtime, conversations, conv, captureAsk } = setup([hermesResult]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 Hermes 一问' });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('complete');
    expect(last.content).toContain('Hermes 的正常回答');
    expect(captureAsk).toHaveBeenCalled();
  });
});
