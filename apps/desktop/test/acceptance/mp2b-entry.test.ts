// @vitest-environment jsdom
/**
 * MP2b 入口验收（经真实 App 外壳渲染，不单独渲染 AskMessage）。
 *
 * 对应规格验收条件：
 * - **条件 11 后半句**：原来跳到「设置 → 模型接入」的入口，现在跳到「模型」页。
 *   做法：聊天里有一条「模型不可用」的失败消息 → 点「去设置「模型接入」添加」→ 落到 `models-page`。
 * - **条件 14**：聊天里换模型的下拉框（`model-retry-select`），选项显示成「供应商名 · 模型」，
 *   至少两家各一个模型（默认 · demo-a / 合成乙 · demo-b）。
 *
 * 不联网：api 全是替身，模型与 Key 都是合成的。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProviderView } from '@ixaeon/contracts';

const providers: ModelProviderView[] = [
  {
    id: 'default',
    name: '默认',
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKeyPresent: true,
    apiKeyTail: 'c3d4',
    apiKeyUnreadable: false,
    savedModels: ['demo-a'],
    modelsCheckedAt: null,
    usedBy: [],
  },
  {
    id: 'p-b',
    name: '合成乙',
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18082/v1',
    apiKeyPresent: true,
    apiKeyTail: 'e7d6',
    apiKeyUnreadable: false,
    savedModels: ['demo-b'],
    modelsCheckedAt: null,
    usedBy: [],
  },
];

const state = { savedModels: ['demo-a', 'demo-b'], providers };

const conversation = {
  id: 'c1',
  projectId: null,
  title: '合成对话',
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
};

const messages = [
  {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    role: 'user',
    content: '合成问题',
    status: 'complete',
    engine: null,
    modelName: null,
    citations: [],
    errorMessage: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    meta: {},
  },
  {
    id: 'm2',
    conversationId: 'c1',
    seq: 2,
    role: 'assistant',
    content: '',
    status: 'failed',
    engine: 'direct',
    modelName: 'demo-x',
    citations: [],
    errorMessage: 'No available channel for model demo-x',
    createdAt: '2026-11-03T00:00:01.000Z',
    meta: {},
  },
];

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getState: async () => ({ setupComplete: true, version: '0.0.0', dataDir: '/tmp/x' }),
    listProjects: async () => [],
    listMatchedFindings: async () => [],
    listConversations: async () => [conversation],
    getConversation: async () => ({ conversation, messages }),
    listTodos: async () => [],
    getSettings: async () => ({
      config: {
        modelName: 'demo-a',
        chatModelName: '',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        savedModels: state.savedModels,
        uses: {},
      },
      dataDir: '/tmp/x',
      cockpit: { magpieUrl: '' },
      providers,
    }),
    listModelProviders: async () => state.providers,
    onAskDelta: () => () => undefined,
    onAskProgress: () => () => undefined,
    onTaskReport: () => () => undefined,
    getCockpit: async () => ({ quota: null }),
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import App from '../../src/renderer/src/App.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function q(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function openChatWithFailedMessage(): Promise<void> {
  await act(async () => {
    root?.render(createElement(App));
  });
  await flush();
  await flush();
  // 打开那个对话（列表里点它）
  const item =
    (q('conversation-c1') as HTMLElement | null) ??
    ([...host.querySelectorAll('button, li')].find((el) =>
      (el.textContent ?? '').includes('合成对话'),
    ) as HTMLElement | undefined) ??
    null;
  if (item) {
    await act(async () => {
      item.click();
    });
    await flush();
  }
  await flush();
}

describe('MP2b 入口：条件 11 后半句 + 条件 14', () => {
  it('点「去设置「模型接入」添加」→ 落到「模型」页', async () => {
    // 只有失败的那个模型：这时才出现「去设置添加」的入口
    state.savedModels = ['demo-x'];
    state.providers = [];
    await openChatWithFailedMessage();

    const entry = q('model-unavailable-settings');
    expect(entry, '聊天里没有「去设置「模型接入」添加」这个入口').toBeTruthy();
    await act(async () => {
      entry?.click();
    });
    await flush();
    await flush();

    expect(q('models-page'), '点了入口之后没落到「模型」页').toBeTruthy();
  });

  it('换模型下拉框的选项是「供应商名 · 模型」，两家各一个', async () => {
    state.savedModels = ['demo-a', 'demo-b'];
    state.providers = providers;
    await openChatWithFailedMessage();

    const select = q('model-retry-select') as HTMLSelectElement | null;
    expect(select, '没有换模型的下拉框').toBeTruthy();
    const labels = [...(select?.options ?? [])].map((o) => (o.textContent ?? '').trim());
    expect(labels).toContain('默认 · demo-a');
    expect(labels).toContain('合成乙 · demo-b');
  });
});
