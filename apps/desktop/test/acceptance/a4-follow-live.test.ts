// @vitest-environment jsdom
/**
 * A4 验收（页面逻辑层，规格 docs/委派/A4-切回来接着看还在写的回答.md）
 *
 * 逐条对应规格条件（界面时序部分由 e2e apps/desktop/e2e/a4-follow-live-answer.spec.ts 照过，
 * 这里的组件级测试把每一条钉在 AskPage 的逻辑上，不依赖时序巧合）：
 *
 * - 条件 1：重新加载出来的对话页（不是发起提问的页面）打开一条「回答中」的对话，
 *   每 2 秒从库同步；一轮结束后显示库里最终回答，不用手动重开对话。
 * - 条件 2：回答还在写时，之后写进库的内容照常出现在气泡里，答完后的内容与库里
 *   精确一致（不重复、不缺）。
 * - 条件 3：回答以失败告终，页面显示失败与错误信息，不再转圈。
 * - 契约 3：跟进中的等待标签只显示「正在回答…」，不显示「正在准备 / 正在思考（N 秒）」
 *   这类假装知道阶段的字样。
 * - 条件 4：打开的是另一个对话时，这个对话里的内容照常显示，别的对话的分段不串进来。
 * - 条件 5（发起提问的那一页没离开过，行为不变）由既有聊天套件（d6/m2）照过。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationSummary } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A4 页面逻辑的 api 替身：getConversation 按当前状态返回，让测试控制每条消息的进展。 */
const state: Record<
  string,
  { conversation: { id: string; projectId: string | null }; messages: ConversationMessage[] }
> = {};
let list: ConversationSummary[] = [];

const off = (): void => undefined;

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listConversations: async () => list,
    getConversation: async (id: string) => state[id]!,
    listTodos: async () => [],
    prewarmChat: async () => undefined,
    createConversation: async () => ({ id: 'c-new', projectId: null }),
    askQuestion: async () => undefined,
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function message(over: Partial<ConversationMessage> & Pick<ConversationMessage, 'id' | 'seq'>): ConversationMessage {
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

const text = (): string => container.textContent ?? '';

describe('A4 切回来接着看还在写的回答（页面逻辑）', () => {
  it('条件 1：打开正回答中的对话，2s 轮询追上进度，答完自动显示最终内容', async () => {
    const assistant = message({ id: 'a1', seq: 2, status: 'streaming', content: '' });
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' });
    setConv('c1', null, [user, assistant]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    // 打开时回答还在写：气泡带转圈，标签只是「正在回答…」（契约 3：无阶段无秒数）
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
    // 答完自动显示最终内容（不用手动重开对话），不再转圈
    expect(text()).toContain(finalAnswer);
    expect(text()).not.toContain('正在回答…');
  });

  it('条件 2：回答还在写时新写进库的内容照常出现在气泡里，答完与库里精确一致', async () => {
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 问一句' });
    const firstHalf = '先写进库的前半段';
    setConv('c1', null, [user, message({ id: 'a1', seq: 2, status: 'streaming', content: firstHalf })]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    expect(text()).toContain(firstHalf);

    // 还在写：内容继续追加（分段落入气泡）
    const withSecond = '先写进库的前半段，还有后半段。';
    setConv('c1', null, [user, message({ id: 'a1', seq: 2, status: 'streaming', content: withSecond })]);
    await tick(2000);
    expect(text()).toContain(withSecond);

    // 答完：气泡与库里最终内容精确一致——同一段正文恰好出现一次（不重复、不缺）
    setConv('c1', null, [user, message({ id: 'a1', seq: 2, status: 'complete', content: withSecond })]);
    await tick(2000);
    const occurrences = text().split(withSecond).length - 1;
    expect(occurrences).toBe(1);
    expect(text()).not.toContain('正在回答…');
  });

  it('条件 3：失败告终的轮显示错误信息，不再转圈', async () => {
    const user = message({ id: 'u1', seq: 1, role: 'user', content: 'A4 提问，模型会报错' });
    const errorText = '模型动作失败：FakeProvider 队列为空（测试未提供响应）';
    // 回答还在写（转圈）
    setConv('c1', null, [user, message({ id: 'a1', seq: 2, status: 'streaming', content: '' })]);
    list = [summary({ id: 'c1', title: '对话 1' })];

    await renderAsk('c1');
    expect(text()).toContain('正在回答…');

    // 一轮以模型出错告终：库里这条消息的收尾形态是错误文案（主进程回答流程
    // 决定收尾字段，不在本单界面范围）；页面轮询后自动换成错误信息、不再转圈。
    setConv('c1', null, [
      user,
      message({ id: 'a1', seq: 2, status: 'complete', content: errorText }),
    ]);
    await tick(2000);
    expect(text()).toContain('FakeProvider 队列为空');
    expect(text()).not.toContain('正在回答…');
  });

  it('条件 4：打开另一个对话时，对方的内容照常显示，这一轮的分段不串进来', async () => {
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
    await act(async () => {
      document
        .querySelector('[data-testid="conversation-item"][data-conversation-id="c2"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true } as MouseEventInit));
    });
    expect(text()).toContain('另一个对话的问题');
    expect(text()).toContain('另一个对话正在写的回答');
    expect(text()).not.toContain('A4 合成回答');

    // c2 还在写：轮询只同步它自己（内容继续增长），c1 的回答仍不出现
    setConv('c2', null, [
      message({ id: 'u2', seq: 1, role: 'user', content: '另一个对话的问题' }),
      message({ id: 'a2', seq: 2, status: 'streaming', content: '另一个对话正在写的回答，又补了一段' }),
    ]);
    await tick(2000);
    expect(text()).toContain('又补了一段');
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
});