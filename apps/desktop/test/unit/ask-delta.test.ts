// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskDeltaEvent } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
  const listeners: Array<(e: AskDeltaEvent) => void> = [];
  let resolveAsk: ((value: { conversationId: string; messageId: string }) => void) | null = null;
  return {
    listeners,
    emit(e: AskDeltaEvent) {
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
  };
});

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    onAskDelta: (listener: (e: AskDeltaEvent) => void) => {
      harness.listeners.push(listener);
      return () => {
        const i = harness.listeners.indexOf(listener);
        if (i >= 0) harness.listeners.splice(i, 1);
      };
    },
    askQuestion: harness.askQuestion,
    createConversation: harness.createConversation,
    listConversations: harness.listConversations,
    getConversation: harness.getConversation,
    cancelAsk: harness.cancelAsk,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
});

describe('Ask 分段显示', () => {
  it('A 对话的分段进气泡；B 对话的分段不影响当前界面', async () => {
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
    expect(harness.createConversation).toHaveBeenCalled();
    await act(async () => {
      harness.emit({ conversationId: 'conv-a', messageId: 'msg-a', delta: '你好' });
    });
    expect(container.querySelector('[data-testid="ask-answer"]')?.textContent).toContain('你好');
    const before = container.querySelector('[data-testid="ask-answer"]')?.textContent;
    await act(async () => {
      harness.emit({ conversationId: 'conv-b', messageId: 'msg-b', delta: '别的对话' });
    });
    expect(container.querySelector('[data-testid="ask-answer"]')?.textContent).toBe(before);
    expect(container.textContent).not.toContain('别的对话');
  });
});
