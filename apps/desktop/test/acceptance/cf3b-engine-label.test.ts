// @vitest-environment jsdom
/**
 * CF3b 验收（界面，规格 docs/委派/CF3-直连模型做聊天主引擎.md）——条件 18。
 *
 * 条件 18：回答下面的引擎信息显示「直连」和模型名。
 *
 * 现状：`AskMessage` 的引擎行是「引擎 {m.engine ?? 'ask'} · 模型 {m.modelName ?? '—'}」，
 * 所以 `engine === 'direct'` 时必须显示中文「直连」（不是英文 direct）。这条钉住映射。
 * 渲染方式照既有验收（p3-brief-line）：jsdom + createRoot，不联网、不启 Electron。
 */
import { createElement, act } from 'react';
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

function answer(engine: string, modelName: string): ConversationMessage {
  return {
    id: 'a1',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    content: '合成回答。',
    status: 'complete',
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    runId: 'r',
    engine,
    modelName,
    citations: [],
    meta: { memoryUsed: [] },
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

describe('CF3b 条件 18：引擎信息显示「直连」与模型名', () => {
  it('engine=direct 时显示「直连」和配置的模型名', async () => {
    await render(answer('direct', 'demo-a'));
    const text = container.textContent ?? '';
    expect(text).toMatch(/直连/);
    expect(text).toContain('demo-a');
    // 不是把英文原样漏出来
    expect(text).not.toMatch(/引擎\s*direct/);
  });
});
