/**
 * A5 验收（后端，规格 docs/委派/A5-模型出错的轮记成失败.md）。
 *
 * CF3c 之后聊天只走直连：原来靠「替身会话返回 steps」造失败的用例，改成用
 * `chatStreamClient` 假客户端造出同样的情形（客户端抛错 / 先调工具失败再正常回答 /
 * 保持返回工具调用到轮次上限），断言的是用户可见结果（消息状态、errorMessage、正文、
 * 是否存档、下一轮上下文）。
 *
 * 整合方 11-05 退役：条件 8「Hermes 的结果没有 answer 步」——Hermes 专有，聊天已不走 Hermes。
 * 条件 7「到轮次上限记成失败」：整合方在 runDirectChat 补上（最后一轮仍没说出话 → failed）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
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
  type ChatStreamResult,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { fakeChatModel, type FakeStreamImpl } from './cf3cb-fake-chat.js';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: {},
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
  },
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

interface SessionCall {
  goal: string;
  priorTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
  sent: string;
}

/**
 * 甲类夹具：模型通道走 `chatStreamClient`，脚本按「第几次 stream 调用」给出回答。
 * 每次都记下这一问交给模型的 messages（用来看 priorTurns 与「发给模型的内容」）。
 */
function setupDirect(scripts: FakeStreamImpl[]) {
  const projects = new ProjectService(db);
  projects.create({ name: 'A5 项目', rootPath: null, description: null });
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  conversations.appendMessage(conv.id, { role: 'user', content: '之前问的' });
  conversations.appendMessage(conv.id, { role: 'assistant', content: '之前答的' });

  const calls: SessionCall[] = [];
  let cursor = 0;
  const captureAsk = vi.fn((_input: { answer: string }) => ({
    created: true as const,
    source: { id: 'src-ask' },
  }));
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
    config: { model: fakeChatModel() },
    chatStreamClient: () => ({
      modelName: 'demo-a',
      stream: async (input: {
        messages: Array<{ role: string; content: string }>;
        onDelta?: (t: string) => void;
        signal?: AbortSignal;
      }) => {
        const messages = (input.messages ?? []).map((m) => ({
          role: String(m.role ?? ''),
          content: String(m.content ?? ''),
        }));
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        calls.push({
          goal: lastUser?.content ?? '',
          // 交给模型的历史轮：整段 messages 里去掉 system 与本轮问题
          priorTurns: messages.slice(1, -1) as SessionCall['priorTurns'],
          sent: messages.map((m) => m.content).join('\n'),
        });
        const script: FakeStreamImpl | undefined = scripts[Math.min(cursor, scripts.length - 1)];
        if (!script) throw new Error('没有剧本');
        cursor += 1;
        const out: Partial<ChatStreamResult> = await script({
          messages,
          lastUser: lastUser?.content ?? '',
          call: cursor - 1,
          onDelta: input.onDelta,
          signal: input.signal,
        });
        const content = out.content ?? '';
        if (input.onDelta && content && !(out.toolCalls && out.toolCalls.length)) {
          input.onDelta(content);
        }
        return {
          content,
          toolCalls: out.toolCalls ?? [],
          finishReason: out.finishReason ?? 'stop',
          toolsUnsupported: out.toolsUnsupported ?? false,
        };
      },
    }),
  });
  return { runtime, conversations, conv, calls, captureAsk, captured };
}

describe('A5 模型出错的轮记成失败（后端）', () => {
  it('条件 1：模型调用失败 → failed + error_message，错误文字不进正文，半截保留', async () => {
    const { runtime, conversations, conv } = setupDirect([
      () => {
        throw new Error('网关挂了，稍后重试');
      },
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
    const { runtime, conversations, conv } = setupDirect([
      ({ onDelta }) => {
        onDelta?.('已经答出的半截');
        throw new Error('网关挂了');
      },
    ]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 触发失败' });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('failed');
    expect(last.content).toContain('已经答出的半截');
    expect(last.content).not.toContain('模型动作失败');
  });

  it('条件 2：失败轮不存档、不排提炼、回报没有「问答已存入」', async () => {
    const { runtime, conv, captureAsk, captured } = setupDirect([
      () => {
        throw new Error('网关挂了');
      },
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
    const { runtime, conv, calls } = setupDirect([
      () => {
        throw new Error('网关挂了');
      },
      () => ({ content: '第二问的正常回答' }),
    ]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 触发失败' });
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 第二问' });
    const second = calls[1]!;
    // 失败轮的助手内容不进上下文；用户自己的那句提问照现有规则留着
    expect(second.priorTurns.filter((t) => t.role === 'assistant').map((t) => t.content)).toEqual([
      '之前答的',
    ]);
    expect(second.priorTurns.map((t) => t.content)).toEqual([
      '之前问的',
      '之前答的',
      'A5 触发失败',
    ]);
    expect(second.sent).not.toContain('模型动作失败');
    expect(second.sent).not.toContain('网关挂了');
  });

  it('条件 4：工具失败但模型最后正常回答 → complete，照常存档', async () => {
    const { runtime, conversations, conv, captureAsk } = setupDirect([
      ({ call }) =>
        call === 0
          ? { content: '', toolCalls: [{ id: 'c1', name: 'no_such_tool', arguments: '{}' }] }
          : { content: '虽然搜索失败，但我已经回答好了' },
    ]);
    await runtime.ask({ conversationId: conv.id, projectId: null, question: 'A5 工具失败' });
    const messages = conversations.messages(conv.id);
    const last = messages[messages.length - 1]!;
    expect(last.status).toBe('complete');
    expect(last.content).toContain('已经回答好了');
    expect(captureAsk).toHaveBeenCalled();
  });

  it('条件 6：正常回答的内容里恰好含「模型动作失败」字样 → 照旧 complete', async () => {
    const { runtime, conversations, conv, captureAsk } = setupDirect([
      () => ({ content: '「模型动作失败」是个短语，这里用它造句，回答本身完全正常。' }),
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
 * 整合方补：真的工具循环出错（CF3c 起用直连的假客户端造同样情形）。
 */
describe('A5（整合方补）：工具循环出错时 ask 怎么收尾', () => {
  const lastMessage = (h: ReturnType<typeof setupDirect>) => {
    const messages = h.conversations.messages(h.conv.id);
    return messages[messages.length - 1]!;
  };

  it('模型调用失败（假模型没有响应）：failed、错误进 error_message、不存档；下一轮模型读不到这段错误', async () => {
    const h = setupDirect([
      () => {
        throw new Error('FakeProvider 队列为空');
      },
      () => ({ content: '第二问的正常回答' }),
    ]);
    const result = await h.runtime.ask({
      conversationId: h.conv.id,
      projectId: null,
      question: 'A5 真引擎触发失败',
    });
    const failed = lastMessage(h);
    expect(failed.engine).toBe('direct');
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage ?? '').toContain('FakeProvider 队列为空');
    expect(failed.content).not.toContain('模型动作失败');
    expect(result.answer).not.toContain('模型动作失败');
    expect(h.captureAsk).not.toHaveBeenCalled();
    expect(result.notice ?? '').not.toContain('问答已存入');

    // 下一轮：模型正常回答；发给模型的内容里没有上一轮的错误文字
    await h.runtime.ask({
      conversationId: h.conv.id,
      projectId: null,
      question: 'A5 真引擎第二问',
    });
    const ok = lastMessage(h);
    expect(ok.status).toBe('complete');
    expect(ok.content).toContain('第二问的正常回答');
    const sent = h.calls[h.calls.length - 1]!.sent;
    expect(sent).not.toContain('模型动作失败');
    expect(sent).not.toContain('FakeProvider 队列为空');
    expect(h.captureAsk).toHaveBeenCalledTimes(1);
  });

  it('条件 7：到了轮次上限还没形成最终回答：failed、不存档，那段话不当回答', async () => {
    const h = setupDirect([
      () => ({
        content: '',
        toolCalls: [{ id: 'c1', name: 'search_memory', arguments: '{"query":"第 N 次"}' }],
      }),
    ]);
    const result = await h.runtime.ask({
      conversationId: h.conv.id,
      projectId: null,
      question: 'A5 一直查不回答',
    });
    const m = (() => {
      const messages = h.conversations.messages(h.conv.id);
      return messages[messages.length - 1]!;
    })();
    expect(m.status).toBe('failed');
    expect(m.errorMessage ?? '').toContain('轮次上限');
    expect(m.content).not.toContain('已达轮次上限');
    expect(result.answer).not.toContain('已达轮次上限');
    expect(h.captureAsk).not.toHaveBeenCalled();
    expect(result.notice ?? '').not.toContain('问答已存入');
  });

  it('对照：工具循环正常回答（中间查过一次记忆）→ complete，照常存档', async () => {
    const h = setupDirect([
      ({ call }) =>
        call === 0
          ? {
              content: '',
              toolCalls: [{ id: 'c1', name: 'search_memory', arguments: '{"query":"之前"}' }],
            }
          : { content: '真引擎的正常回答' },
    ]);
    await h.runtime.ask({ conversationId: h.conv.id, projectId: null, question: 'A5 正常一问' });
    const m = lastMessage(h);
    expect(m.status).toBe('complete');
    expect(m.content).toContain('真引擎的正常回答');
    expect(h.captureAsk).toHaveBeenCalledTimes(1);
  });
});

// 条件 8「Hermes 的结果没有 answer 步」整合方 11-05 退役：聊天已不走 Hermes。
