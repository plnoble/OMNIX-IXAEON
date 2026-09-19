// @vitest-environment jsdom
/**
 * T3 验收（整合方写死，执行方不改）：待办页。
 * 委派单：docs/委派/T3-待办页.md
 * 看得到「等你拍板 / 要做 / 已完成」；拍板、不做、做完、自己加一条；点一条跳回来源对话；
 * 底下是编码任务的，显示任务的实时状态。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-09-19T00:00:00.000Z';
function todo(id: string, patch: Partial<TodoView>): TodoView {
  return {
    id,
    title: `合成待办 ${id}`,
    status: 'accepted',
    origin: 'user',
    conversation_id: null,
    message_id: null,
    linked_kind: null,
    linked_id: null,
    created_at: T,
    updated_at: T,
    decided_at: T,
    done_at: null,
    linkedStatus: null,
    ...patch,
  };
}

const harness = vi.hoisted(() => ({
  rows: [] as unknown[],
  listTodos: vi.fn(),
  addTodo: vi.fn(async (input: { title: string }) => ({ id: 'new', title: input.title })),
  acceptTodo: vi.fn(async (id: string) => ({ id })),
  rejectTodo: vi.fn(async (id: string) => ({ id })),
  completeTodo: vi.fn(async (id: string) => ({ id })),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listTodos: harness.listTodos,
    addTodo: harness.addTodo,
    acceptTodo: harness.acceptTodo,
    rejectTodo: harness.rejectTodo,
    completeTodo: harness.completeTodo,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { TodosPage } from '../../src/renderer/src/pages/Todos.js';

let container: HTMLDivElement;
let root: Root;
const onOpenConversation = vi.fn();

beforeEach(() => {
  for (const fn of [
    harness.listTodos,
    harness.addTodo,
    harness.acceptTodo,
    harness.rejectTodo,
    harness.completeTodo,
    onOpenConversation,
  ]) {
    fn.mockClear();
  }
  harness.rows = [
    todo('ask', { status: 'proposed', origin: 'agent', decided_at: null, conversation_id: 'c1' }),
    todo('doing', {
      linked_kind: 'coding_task',
      linked_id: 'task-1',
      linkedStatus: 'running',
    }),
    todo('mine', {}),
    todo('done', { status: 'done', done_at: T }),
  ];
  harness.listTodos.mockImplementation(async () => harness.rows);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(TodosPage, { onOpenConversation }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const click = async (testId: string) => {
  await act(async () => {
    $(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
};

describe('待办页', () => {
  it('分三块：等你拍板、要做、已完成', async () => {
    await render();
    expect($('todo-section-proposed')?.textContent).toContain('合成待办 ask');
    expect($('todo-section-accepted')?.textContent).toContain('合成待办 doing');
    expect($('todo-section-accepted')?.textContent).toContain('合成待办 mine');
    expect($('todo-section-done')?.textContent).toContain('合成待办 done');
    expect($('todo-section-proposed')?.textContent).not.toContain('合成待办 done');
  });

  it('等你拍板的：「要做」「不做」；点了走 IPC 并刷新', async () => {
    await render();
    const before = harness.listTodos.mock.calls.length;
    await click('todo-accept-ask');
    expect(harness.acceptTodo).toHaveBeenCalledWith('ask');
    expect(harness.listTodos.mock.calls.length).toBeGreaterThan(before);
    await click('todo-reject-ask');
    expect(harness.rejectTodo).toHaveBeenCalledWith('ask');
  });

  it('要做的：「做完了」；底下是编码任务的显示任务的实时状态（中文）', async () => {
    await render();
    await click('todo-complete-mine');
    expect(harness.completeTodo).toHaveBeenCalledWith('mine');
    expect($('todo-linked-doing')?.textContent).toContain('进行中');
    expect($('todo-linked-mine')).toBeNull();
  });

  it('自己加一条', async () => {
    await render();
    const input = $('todo-add-input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(input, '周五前交报销单');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('todo-add');
    expect(harness.addTodo).toHaveBeenCalledWith({ title: '周五前交报销单' });
  });

  it('从对话来的能点回那个对话；不是从对话来的没有这个入口', async () => {
    await render();
    await click('todo-open-ask');
    expect(onOpenConversation).toHaveBeenCalledWith('c1');
    expect($('todo-open-mine')).toBeNull();
  });
});
