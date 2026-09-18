// @vitest-environment jsdom
/**
 * E6：回答下面列出这一轮用到的记忆，不对或过时的当场点掉（不用导入后逐句审核）。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  rejectItem: vi.fn(async (id: string) => ({ id })),
  setItemTimeStatus: vi.fn(async (input: { id: string; status: string | null }) => input),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: { rejectItem: harness.rejectItem, setItemTimeStatus: harness.setItemTimeStatus },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskMessage } from '../../src/renderer/src/pages/AskMessage.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  harness.rejectItem.mockClear();
  harness.setItemTimeStatus.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function answer(meta: Record<string, unknown>, status = 'complete'): ConversationMessage {
  return {
    id: 'a1',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    content: '建议周五下午写周报。',
    status,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    runId: 'r',
    engine: 'hermes',
    modelName: 'm',
    citations: [],
    meta,
    errorMessage: null,
  } as ConversationMessage;
}

async function render(message: ConversationMessage): Promise<void> {
  await act(async () => {
    root.render(
      createElement(AskMessage, {
        message,
        showNotice: false,
        expandedRef: null,
        onToggleRef: () => undefined,
        onApprove: () => undefined,
      }),
    );
  });
}

const click = async (testId: string) => {
  await act(async () => {
    container
      .querySelector(`[data-testid="${testId}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const USED = [
  { id: 'm1', statement: '每周五要交周报', tag: '系统推断' },
  { id: 'm2', statement: '7 月的出差安排', tag: 'AI 当时的建议，不是用户的决定' },
];

describe('用到的记忆', () => {
  it('列出这一轮用到的记忆和出处', async () => {
    await render(answer({ memoryUsed: USED }));
    const list = container.querySelector('[data-testid="ask-memory-used"]');
    expect(list?.textContent).toContain('用到的记忆（2 条）');
    expect(list?.textContent).toContain('每周五要交周报');
    expect(list?.textContent).toContain('AI 当时的建议');
  });

  it('点「不对」：这条不再用，按钮换成说明', async () => {
    await render(answer({ memoryUsed: USED }));
    await click('memory-wrong-m1');
    expect(harness.rejectItem).toHaveBeenCalledWith('m1');
    const row = container.querySelector('[data-testid="memory-used-m1"]');
    expect(row?.textContent).toContain('已标记不对');
    expect(container.querySelector('[data-testid="memory-wrong-m1"]')).toBeNull();
  });

  it('点「过时了」：标为已结束，之后当作过去的事', async () => {
    await render(answer({ memoryUsed: USED }));
    await click('memory-ended-m2');
    expect(harness.setItemTimeStatus).toHaveBeenCalledWith({ id: 'm2', status: 'ended' });
    expect(container.querySelector('[data-testid="memory-used-m2"]')?.textContent).toContain(
      '已标记过时',
    );
  });

  it('没用到记忆、或还在回答中：不显示', async () => {
    await render(answer({ memoryUsed: [] }));
    expect(container.querySelector('[data-testid="ask-memory-used"]')).toBeNull();
    await render(answer({ memoryUsed: USED }, 'streaming'));
    expect(container.querySelector('[data-testid="ask-memory-used"]')).toBeNull();
  });
});
