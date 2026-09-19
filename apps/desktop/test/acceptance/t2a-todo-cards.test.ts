// @vitest-environment jsdom
/**
 * T2a 验收（整合方写死，执行方不改）：回答下面的待办卡。
 * 委派单：docs/委派/T2a-聊天里的待办.md
 * 卡片按待办的**当前状态**画（由聊天页从待办表读来传进来），不读消息里的快照——
 * D6 复核发现旧的批准卡显示的是提问时的快照，批准后重开对话仍显示「批准并排队」。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, TodoStatus } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {},
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskMessage } from '../../src/renderer/src/pages/AskMessage.js';

let container: HTMLDivElement;
let root: Root;
const onDecideTodo = vi.fn();

beforeEach(() => {
  onDecideTodo.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function answer(meta: Record<string, unknown>): ConversationMessage {
  return {
    id: 'a1',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    content: '先把报价核一遍。',
    status: 'complete',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    runId: 'r',
    engine: 'hermes',
    modelName: 'm',
    citations: [],
    meta,
    errorMessage: null,
  } as ConversationMessage;
}

async function render(meta: Record<string, unknown>, todoStatus: Record<string, TodoStatus>) {
  await act(async () => {
    root.render(
      createElement(AskMessage, {
        message: answer(meta),
        showNotice: false,
        expandedRef: null,
        onToggleRef: () => undefined,
        onApprove: () => undefined,
        todoStatus,
        onDecideTodo,
      }),
    );
  });
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

describe('回答下面的待办卡', () => {
  const META = {
    proposedTodos: [
      { id: 't1', title: '周五前把报价发给客户' },
      { id: 't2', title: '预约下周体检' },
      { id: 't3', title: '把旧笔记本卖掉' },
    ],
  };

  it('还没拍板的有「要做」「不做」；已拍板的只显示结果', async () => {
    await render(META, { t1: 'proposed', t2: 'accepted', t3: 'rejected' });
    expect($('todo-card-t1')?.textContent).toContain('周五前把报价发给客户');
    expect($('todo-card-accept-t1')).not.toBeNull();
    expect($('todo-card-reject-t1')).not.toBeNull();
    expect($('todo-card-accept-t2')).toBeNull();
    expect($('todo-card-t2')?.textContent).toContain('要做');
    expect($('todo-card-t3')?.textContent).toContain('不做');
  });

  it('点「要做」「不做」交给聊天页处理', async () => {
    await render(META, { t1: 'proposed', t2: 'proposed', t3: 'proposed' });
    await act(async () => {
      $('todo-card-accept-t1')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      $('todo-card-reject-t2')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDecideTodo.mock.calls).toEqual([
      ['t1', 'accept'],
      ['t2', 'reject'],
    ]);
  });

  it('你自己加的待办：回答上注明已加', async () => {
    await render({ userTodo: { id: 'u1', title: '周五前交报销单' } }, { u1: 'accepted' });
    expect($('user-todo-note')?.textContent).toContain('已加到待办');
    expect($('user-todo-note')?.textContent).toContain('周五前交报销单');
  });

  it('没有待办的回答不画这一块', async () => {
    await render({}, {});
    expect(container.querySelector('[data-testid^="todo-card-"]')).toBeNull();
    expect($('user-todo-note')).toBeNull();
  });
});
