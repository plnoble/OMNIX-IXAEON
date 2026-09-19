// @vitest-environment jsdom
/**
 * P3 验收条件 6（界面）：回答下面（记忆那行附近）一行灰字
 * 「本轮给模型看了项目近况：N 条提交、M 个会话、K 个任务」；没带时不显示。
 * docs/委派/P3-项目进展简报.md
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {},
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskMessage } from '../../src/renderer/src/pages/AskMessage.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
    content: '做到修导入这一步。',
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

async function render(meta: Record<string, unknown>) {
  await act(async () => {
    root.render(
      createElement(AskMessage, {
        message: answer(meta),
        showNotice: false,
        expandedRef: null,
        onToggleRef: () => undefined,
        onApprove: () => undefined,
      }),
    );
  });
}

it('条件 6：有 projectBrief 时显示灰字计数；没带时不显示', async () => {
  await render({
    projectBrief: { commits: 2, sessions: 2, tasks: 2 },
    memoryUsed: [],
  });
  const line = container.querySelector('[data-testid="ask-project-brief"]');
  expect(line).not.toBeNull();
  expect(line?.textContent).toContain('本轮给模型看了项目近况：2 条提交、2 个会话、2 个任务');

  await render({ memoryUsed: [] });
  expect(container.querySelector('[data-testid="ask-project-brief"]')).toBeNull();
});
