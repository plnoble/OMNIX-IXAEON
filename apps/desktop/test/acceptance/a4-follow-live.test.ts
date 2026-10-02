// @vitest-environment jsdom
/**
 * A4 验收（页面逻辑层，规格 docs/委派/A4-切回来接着看还在写的回答.md）
 *
 * 逐条对应规格条件（端到端时序由 e2e apps/desktop/e2e/a4-follow-live-answer.spec.ts 照过，
 * 这里的组件级测试把每一条钉在 AskPage 的轮询逻辑上，不依赖时序巧合）：
 *
 * - 条件 1：重新加载出来的对话页（不是发起提问的页面）打开一条「回答中」的对话，
 *   每 2 秒从库同步；一轮结束后显示库里最终回答，不用手动重开对话。
 * - 条件 2：回答还在写时，之后逐段写进库的内容照常出现在气泡里；答完后的气泡
 *   正文与库里精确一致（不重复、不缺）。
 * - 条件 3：回答以失败（或取消）告终，切回来的页面在结束后显示失败/取消与错误
 *   信息，不再转圈（streaming→终态 的轮询转换）。
 * - 契约 3：跟进中的等待标签只显示「正在回答…」，不显示「正在准备 / 正在思考（N 秒）」
 *   这类假装知道阶段的字样。
 * - 条件 4：打开的是另一个对话时，这个对话里的内容照常显示；另一个对话继续写
 *   的内容不串进来（隔离发生在轮询同步这个环节）。
 * - 竞态：快速 A→B→A 切换后，旧实例的在途请求回来不回写旧快照。
 * - 条件 5（发起提问的那一页没离开过，行为不变）由既有聊天套件（d6/m2）照过。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationSummary } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ConvData = {
  conversation: { id: string; projectId: string | null };
  messages: ConversationMessage[];
};

/** A4 页面逻辑的 api 替身：getConversation 按当前状态返回；getConvInterceptor
 *  可临时接管某次调用（乱序回包测试用它挂起一笔请求）。 */
const state: Record<string, ConvData> = {};
let list: ConversationSummary[] = [];
let getConvInterceptor: ((id: string) => Promise<ConvData> | null) | null = null;

const off = (): void => undefined;

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listConversations: async () => list,
    getConversation: async (id: string) => {
      const intercepted = getConvInterceptor?.(id) ?? null;
      if (intercepted) return intercepted;
      return state[id]!;
    },
    listTodos: async () => [],
    prewarmChat: async () => undefined,
    createConversation: async () => ({ id: 'c-new', projectId: null }),
    askQuestion: async () => ({ conversationId: 'c1' }),
    cancelAsk: async () => undefined,
    onAskProgress: () => off,
    onAskDelta: () => off,
    onTaskReport: () => off,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(state)) delete state[k];
  list = [];
  getConvInterceptor = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function message(
  over: Partial<ConversationMessage> & Pick<ConversationMessage, 'id' | 'seq'>,
): ConversationMessage {
  return {
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    status: 'complete',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    runId: null,
    engine: 'core-bounded',
    modelName: 'fake-model-v1',
    citations: [],
    meta: {},
    errorMessage: null,
    ...over,
  };
}

function setConv(id: string, projectId: string | null, messages: ConversationMessage[]): void {
  state[id] = { conversation: { id, projectId }, messages };
}

function summary(over: Pick<ConversationSummary, 'id' | 'title'>): ConversationSummary {
  return {
    projectId: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    archivedAt: null,
    engine: null,
    engineSessionId: null,
    sourceId: null,
    messageCount: 0,
    lastMessageAt: null,
    lastMessagePreview: null,
    ...over,
  };
}

async function renderAsk(openConversationId: string): Promise<void> {
  await act(async () => {
    root.render(createElement(AskPage, { projects: [], openConversationId }));
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function clickItem(id: string): Promise<void> {
  await act(async () => {
    document
      .querySelector(`[data-testid="conversation-item"][data-conversation-id="${id}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true } as MouseEventInit));
  });
}

const text = (): string => container.textContent ?? '';

describe('A4 切回来接着看还在写的回答（页面逻辑）', () => {
  it('条件 1：打开正回答中的对话，2s 轮询追上进度，答完自动显示最终内容', async () => {
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' });
    setConv('c1', null, [user, message({ id: 'a1', seq: 2, status: 'streaming', content: '' })]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    // 打开时回答还在写：气泡带转圈，标签只是「正在回答…」（契约 3：无阶段无秒数）
    expect(text()).toContain('正在回答…');
    expect(text()).not.toContain('秒');
    expect(text()).not.toContain('正在思考');
    expect(text()).not.toContain('正在准备');
    // 轮询接管之后（askPhase 已切成跟进态）标签依旧如故：跟进态只知道
    // 「正在回答…」，不显示阶段、不显示秒数
    await tick(2000);
    expect(text()).toContain('正在回答…');
    expect(text()).not.toContain('秒');
    expect(text()).not.toContain('正在思考');
    expect(text()).not.toContain('正在准备');

    // 一轮结束：库里换成最终回答
    const finalAnswer = 'A4 合成回答：这是切回来之后自动显示出来的最终内容。';
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'complete', content: finalAnswer }),
    ]);
    await tick(2000);
    // 答完自动显示最终内容（不用手动重开对话），不再转圈；气泡正文与库里精确相等
    expect(text()).toContain(finalAnswer);
    expect(container.querySelector('[data-testid="ask-answer"] pre.answer-text')?.textContent).toBe(
      finalAnswer,
    );
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
  });

  it('条件 2：回答还在写时逐段写进库的内容照常出现在气泡里，答完与库里精确一致', async () => {
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' });
    const firstHalf = '先写进库的前半段';
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'streaming', content: firstHalf }),
    ]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    expect(text()).toContain(firstHalf);

    // 还在写：库里内容逐段追加（模拟主进程每 200ms 批量把分段并入这条消息），
    // 每个轮询周期都把新到的分段带进气泡
    const withSecond = '先写进库的前半段，还有后半段。';
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'streaming', content: withSecond }),
    ]);
    await tick(2000);
    expect(text()).toContain(withSecond);

    // 答完：气泡正文与库里最终内容精确一致（同一段正文恰好出现一次，不重复、不缺）
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'complete', content: withSecond }),
    ]);
    await tick(2000);
    const occurrences = text().split(withSecond).length - 1;
    expect(occurrences).toBe(1);
    // 气泡 pre 的文本与库里内容逐字相等：残留重复半截或拼接错序都过不去
    expect(container.querySelector('[data-testid="ask-answer"] pre.answer-text')?.textContent).toBe(
      withSecond,
    );
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
  });

  it('条件 3：失败告终的轮显示失败与错误信息，不再转圈（streaming→failed 转换）', async () => {
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 提问，模型会报错' });
    setConv('c1', null, [user, message({ id: 'a1', seq: 2, status: 'streaming', content: '' })]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    expect(text()).toContain('正在回答…');

    // 一轮以失败告终：库里这条消息收尾为 failed 并带错误信息
    //（AskMessage 的既有渲染路径显示「失败：…」+ 错误详情）。
    setConv('c1', null, [
      user,
      message({
        id: 'a1',
        seq: 2,
        status: 'failed',
        content: '',
        errorMessage: 'FakeProvider 队列为空（测试未提供响应）',
      }),
    ]);
    await tick(2000);
    expect(text()).toContain('失败');
    expect(text()).toContain('FakeProvider 队列为空');
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
  });

  it('条件 3 补充：取消收尾的轮显示「已取消」和半截回答，不再转圈', async () => {
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 提问' });
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'streaming', content: '已经写出的半截回答' }),
    ]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    expect(text()).toContain('正在回答…');

    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'cancelled', content: '已经写出的半截回答' }),
    ]);
    await tick(2000);
    expect(text()).toContain('已取消');
    expect(text()).toContain('已经写出的半截回答');
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
  });

  it('条件 4：打开另一个对话时，对方的内容照常显示，原轮继续写也不串进来', async () => {
    const own = 'A4 合成回答：这是切回来之后自动显示出来的最终内容。';
    setConv('c1', null, [
      message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' }),
      message({ id: 'a1', seq: 2, status: 'complete', content: own }),
    ]);
    setConv('c2', null, [
      message({ id: 'u2', seq: 1, role: 'user', content: '另一个对话的问题' }),
      message({ id: 'a2', seq: 2, status: 'streaming', content: '另一个对话正在写的回答' }),
    ]);
    list = [summary({ id: 'c1', title: '对话 1' }), summary({ id: 'c2', title: '对话 2' })];

    await renderAsk('c1');
    expect(text()).toContain(own);

    // 在列表里点另一个对话：它的内容照常显示，这一轮的分段不出现
    await clickItem('c2');
    expect(text()).toContain('另一个对话的问题');
    expect(text()).toContain('另一个对话正在写的回答');
    expect(text()).not.toContain('A4 合成回答');

    // c2 打开期间，另一个对话（c1 的原轮）的内容在库里继续增长——不串进来；
    // c2 自己的内容照常随轮询增长
    setConv('c1', null, [
      message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' }),
      message({ id: 'a1', seq: 2, status: 'streaming', content: own + '（原轮还在写）' }),
    ]);
    setConv('c2', null, [
      message({ id: 'u2', seq: 1, role: 'user', content: '另一个对话的问题' }),
      message({
        id: 'a2',
        seq: 2,
        status: 'streaming',
        content: '另一个对话正在写的回答，又补了一段',
      }),
    ]);
    await tick(2000);
    expect(text()).toContain('又补了一段');
    expect(text()).not.toContain('原轮还在写');
    expect(text()).not.toContain('A4 合成回答');

    // c2 答完：最终内容替换，c1 依旧不串进
    const finalC2 = '另一个对话的最终回答。';
    setConv('c2', null, [
      message({ id: 'u2', seq: 1, role: 'user', content: '另一个对话的问题' }),
      message({ id: 'a2', seq: 2, status: 'complete', content: finalC2 }),
    ]);
    await tick(2000);
    expect(text()).toContain(finalC2);
    expect(text()).not.toContain('A4 合成回答');
  });

  it('竞态：快速 A→B→A 后，旧实例在途的流式快照回来不回写（不再转圈）', async () => {
    const finalAnswer = 'A4 合成回答：这是切回来之后自动显示出来的最终内容。';
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' });
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'complete', content: finalAnswer }),
    ]);
    setConv('c2', null, [
      message({ id: 'u2', seq: 1, role: 'user', content: '另一个对话的问题' }),
      message({ id: 'a2', seq: 2, status: 'complete', content: '另一个对话的最终回答。' }),
    ]);
    list = [summary({ id: 'c1', title: '对话 1' }), summary({ id: 'c2', title: '对话 2' })];
    await renderAsk('c1');
    expect(text()).toContain(finalAnswer);

    // 只挂起 c1 的下一笔请求（A 实例轮询 tick 的那笔慢响应），之后照常——
    // 否则点回 c1 时 openConversation 也会被挂起，页面就打不开了。
    let release!: (data: ConvData) => void;
    const pending = new Promise<ConvData>((resolve) => {
      release = resolve;
    });
    let used = false;
    getConvInterceptor = (id) => {
      if (id === 'c1' && !used) {
        used = true;
        return pending;
      }
      return null;
    };
    await tick(2000); // A 实例的 tick 发出请求并挂起

    // A→B→A：旧实例清理，activeId 又回到了 c1
    await clickItem('c2');
    await clickItem('c1');
    expect(text()).toContain(finalAnswer);
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();

    // 慢响应此刻才回来，带的是陈旧的流式快照——必须被丢弃
    await act(async () => {
      release({
        conversation: { id: 'c1', projectId: null },
        messages: [user, message({ id: 'a1', seq: 2, status: 'streaming', content: '旧快照' })],
      });
    });
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
    expect(text()).not.toContain('旧快照');
    expect(text()).toContain(finalAnswer);
  });

  it('竞态：同一对话里新一轮已结束，旧轮询快照回来不回写、不停轮询', async () => {
    const firstAnswer = '第一轮的回答。';
    const secondAnswer = '第二轮的回答（更新）。';
    setConv('c1', null, [
      message({ id: 'u1', seq: 1, role: 'user', content: '第一问' }),
      message({ id: 'a1', seq: 2, status: 'complete', content: firstAnswer }),
    ]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    expect(text()).toContain(firstAnswer);

    // 挂起轮询的下一笔请求：它返回的是旧轮（第一轮还在写）的快照
    let release!: (data: ConvData) => void;
    const pending = new Promise<ConvData>((resolve) => {
      release = resolve;
    });
    let used = false;
    getConvInterceptor = (id) => {
      if (id === 'c1' && !used) {
        used = true;
        return pending;
      }
      return null;
    };
    await tick(2000); // 轮询 tick 发出请求并挂起

    // 用户在同一个对话里发起新一轮，而且这一轮已经结束（waiting 回到 null）
    setConv('c1', null, [
      message({ id: 'u1', seq: 1, role: 'user', content: '第一问' }),
      message({ id: 'a1', seq: 2, status: 'complete', content: firstAnswer }),
      message({ id: 'u2', seq: 3, role: 'user', content: '第二问' }),
      message({ id: 'a2', seq: 4, status: 'complete', content: secondAnswer }),
    ]);
    await act(async () => {
      const input = container.querySelector('[data-testid="ask-input"]') as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(input, '第二问');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[data-testid="ask-run"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true } as MouseEventInit),
      );
    });
    expect(text()).toContain(secondAnswer);

    // 旧快照此刻才回来（第一轮的流式态）：必须被丢弃，不能把界面盖回
    // 「正在回答…」，也不能让这一轮的轮询停下来
    await act(async () => {
      release({
        conversation: { id: 'c1', projectId: null },
        messages: [
          message({ id: 'u1', seq: 1, role: 'user', content: '第一问' }),
          message({ id: 'a1', seq: 2, status: 'streaming', content: '旧快照' }),
        ],
      });
    });
    expect(text()).not.toContain('旧快照');
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
    expect(text()).toContain(secondAnswer);
  });
});
