// @vitest-environment jsdom
/**
 * T2a 并入时整合方补的：回答还在逐字出来时，末尾的「建议待办」段先不显示——
 * 答完后主进程把它拆成待办卡，正文里就没有这一段了；不藏的话会先闪一下再消失。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function render(content: string, status: ConversationMessage['status']) {
  const message = {
    id: 'a1',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    content,
    status,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    runId: 'r',
    engine: 'hermes',
    modelName: 'm',
    citations: [],
    meta: {},
    errorMessage: null,
  } as ConversationMessage;
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
  return container.querySelector('.answer-text')?.textContent ?? '';
}

describe('逐字出来时藏起「建议待办」段', () => {
  it('还在出字：从标题行起先不显示', async () => {
    const shown = await render(
      '先把报价核一遍。\n\n**建议待办：**\n- 周五前把报价发给',
      'streaming',
    );
    expect(shown).toBe('先把报价核一遍。');
  });

  it('答完的消息原样显示（正文里提到「建议待办」的话不受影响）', async () => {
    const text = '上次的建议待办：你已经做完了。';
    expect(await render(text, 'complete')).toBe(text);
    expect(await render(text, 'streaming')).toBe(text);
  });
});
