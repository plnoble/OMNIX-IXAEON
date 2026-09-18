// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskProgressEvent } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
  const listeners: Array<(e: AskProgressEvent) => void> = [];
  let resolveAsk: ((value: { conversationId: string; messageId: string }) => void) | null = null;
  return {
    listeners,
    emit(e: AskProgressEvent) {
      for (const fn of listeners) fn(e);
    },
    askQuestion: vi.fn(
      () =>
        new Promise<{ conversationId: string; messageId: string }>((resolve) => {
          resolveAsk = resolve;
        }),
    ),
    finishAsk(conversationId: string) {
      resolveAsk?.({ conversationId, messageId: 'final-a' });
    },
    createConversation: vi.fn(async () => ({
      id: 'conv-a',
      title: '新对话',
      projectId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
      engine: null,
      engineSessionId: null,
      sourceId: null,
    })),
    listConversations: vi.fn(async () => []),
    getConversation: vi.fn(async (id: string) => ({
      conversation: {
        id,
        title: '新对话',
        projectId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        archivedAt: null,
        engine: null,
        engineSessionId: null,
        sourceId: null,
      },
      messages: [],
    })),
    cancelAsk: vi.fn(async () => ({ cancelled: true, runId: 'r' })),
    prewarmChat: vi.fn(async () => ({ warmed: false })),
  };
});

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    onAskProgress: (listener: (e: AskProgressEvent) => void) => {
      harness.listeners.push(listener);
      return () => {
        const i = harness.listeners.indexOf(listener);
        if (i >= 0) harness.listeners.splice(i, 1);
      };
    },
    onAskDelta: () => () => undefined,
    askQuestion: harness.askQuestion,
    createConversation: harness.createConversation,
    listConversations: harness.listConversations,
    getConversation: harness.getConversation,
    cancelAsk: harness.cancelAsk,
    prewarmChat: harness.prewarmChat,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  harness.listeners.splice(0);
  harness.askQuestion.mockClear();
  harness.createConversation.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function send(): Promise<void> {
  await act(async () => {
    root.render(createElement(AskPage, { projects: [] }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  const input = container.querySelector('[data-testid="ask-input"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, '你好');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('[data-testid="ask-run"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Ask 等待进度', () => {
  it('发出后立即显示正在准备；thinking 过 3 秒秒数正确；answering 不再显示思考；别的对话不影响', async () => {
    await send();
    expect(harness.createConversation).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toContain('正在准备');
    // 还在准备时，别的对话在思考：当前界面不跟着变
    await act(async () => {
      harness.emit({ conversationId: 'conv-b', messageId: 'msg-b', phase: 'thinking' });
    });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toContain('正在准备');
    await act(async () => {
      harness.emit({ conversationId: 'conv-a', messageId: 'msg-a', phase: 'thinking' });
    });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toContain('正在思考');
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe(
      '正在思考…（3 秒）',
    );
    await act(async () => {
      harness.emit({ conversationId: 'conv-a', messageId: 'msg-a', phase: 'answering' });
    });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('正在回答…');
    expect(container.textContent).not.toContain('正在思考');
    await act(async () => {
      harness.emit({ conversationId: 'conv-b', messageId: 'msg-b', phase: 'thinking' });
    });
    expect(container.querySelector('[data-testid="loading"]')?.textContent).toBe('正在回答…');
  });
});
