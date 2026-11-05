// @vitest-environment jsdom
/**
 * MP3b 验收条件 11（界面）：「模型」页「用途」里的替补列表。
 *
 * 对应规格「验收条件」第 11 条的前五小条：
 * - 两个用途下面各有替补列表；每项「供应商名 · 模型」，带上移 / 下移 / 删掉；
 * - 列表下面一个下拉框加「添加」，选项是所有供应商勾选过的模型，去掉主选和已在列表里的；满 4 项「添加」不能点；
 * - 和主选共用「保存」，一次存主选和替补（保存时 `saveModelFallbacks` 收到的就是界面上看到的顺序）；
 * - 聊天选「跟着后台分析」时替补列表收起，原地写一行说明，聊天自己的替补项看不见；
 * - 保存被拒时主进程的提示原样显示。
 *
 * 约定的 data-testid（写进交付说明）：`fallback-list-analysis`、`fallback-list-chat`（两个列表），
 * `fallback-add-analysis`、`fallback-add-chat`（两个「添加」下拉框）。列表项里的按钮按文字找
 * （上移 / 下移 / 删掉 / 添加）。
 *
 * 第 11 条最后一小条「聊天里带替补提示的回答下面显示那句话」是聊天页的渲染，
 * 由 `apps/desktop/e2e/mp3b-fallback.spec.ts`（条件 12 的端到端）覆盖。
 *
 * 现在界面还没做（ModelsPage 里没有替补列表），本文件应当红：找不到 `fallback-list-analysis`。
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProviderView } from '@ixaeon/contracts';
import { ModelsPage } from '../../src/renderer/src/pages/Models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function provider(id: string, name: string, models: string[]): ModelProviderView {
  return {
    id,
    name,
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKeyPresent: true,
    apiKeyTail: 'c3d4',
    apiKeyUnreadable: false,
    savedModels: models,
    modelsCheckedAt: null,
    usedBy: [],
  };
}

const PROVIDERS = [
  provider('p-a', '合成甲', ['demo-a']),
  provider('p-b', '合成乙', ['demo-b']),
  provider('p-c', '合成丙', ['demo-c', 'demo-d', 'demo-e']),
];

interface Stub {
  saveModelUses: ReturnType<typeof vi.fn>;
  saveModelFallbacks: ReturnType<typeof vi.fn>;
  saveModelProvider: ReturnType<typeof vi.fn>;
}

let root: Root | null = null;
let container: HTMLElement;

function mount(
  stub: Stub,
  fallbacks: { analysis?: unknown[]; chat?: unknown[] } = {
    analysis: [{ providerId: 'p-b', model: 'demo-b' }],
  },
): void {
  (globalThis as unknown as { window: { ixaeon?: unknown } }).window.ixaeon = {
    getSettings: async () => ({
      config: {
        modelName: 'demo-a',
        chatModelName: '',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        savedModels: ['demo-a'],
        modelsCheckedAt: null,
        codingExecutor: 'codex',
        codingModelName: '',
        captureEnabled: false,
        autoAnalyze: false,
        extensionPaired: false,
        extensionLastSyncAt: null,
        webSearchProvider: 'none',
        webSearchKeyPresent: false,
        uses: { analysis: { providerId: 'p-a', model: 'demo-a' } },
        fallbacks,
      },
      dataDir: '',
    }),
    listModelProviders: async () => PROVIDERS,
    fetchProviderModels: async () => ({ models: [], error: null }),
    saveModelUses: stub.saveModelUses,
    saveModelFallbacks: stub.saveModelFallbacks,
    saveModelProvider: stub.saveModelProvider,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ModelsPage));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function stub(): Stub {
  return {
    saveModelUses: vi.fn(async () => ({ ok: true })),
    saveModelFallbacks: vi.fn(async () => ({ ok: true })),
    saveModelProvider: vi.fn(async () => ({ ok: true, id: 'p-new', keyCleared: false })),
  };
}

function el(testId: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`找不到 [data-testid="${testId}"]`);
  return node as HTMLElement;
}

function text(): string {
  return document.body.textContent ?? '';
}

/** 每项的文字（不算项里的按钮：上移 / 下移 / 删掉放在各自那一项里）。 */
function itemTexts(listTestId: string): string[] {
  return Array.from(el(listTestId).querySelectorAll('li')).map((li) => {
    const copy = li.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('button').forEach((b) => b.remove());
    return copy.textContent?.trim() ?? '';
  });
}

function buttonIn(host: HTMLElement, name: string): HTMLButtonElement {
  const b = Array.from(host.querySelectorAll('button')).find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`找不到按钮「${name}」`);
  return b as HTMLButtonElement;
}

beforeEach(() => {
  mount(stub());
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('MP3b 条件 11：用途里的替补列表', () => {
  it('两个用途下面各有替补列表，项是「供应商名 · 模型」，有上移/下移/删掉', async () => {
    await settle();
    expect(el('fallback-list-analysis')).toBeTruthy();
    expect(el('fallback-list-chat')).toBeTruthy();
    expect(itemTexts('fallback-list-analysis').join('|')).toContain('合成乙 · demo-b');
    expect(text()).toContain('上移');
    expect(text()).toContain('下移');
    expect(text()).toContain('删掉');
  });

  it('满 4 项时「添加」不能点（列表里确实有 4 项，不是没得选）', async () => {
    await settle();
    const list = el('fallback-list-analysis');
    const add = el('fallback-add-analysis');
    for (let i = 0; i < 3; i += 1) {
      act(() => buttonIn(add, '添加').dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
    }
    expect(list.querySelectorAll('li')).toHaveLength(4);
    expect(buttonIn(el('fallback-add-analysis'), '添加').hasAttribute('disabled')).toBe(true);
  });

  it('下拉框里没有主选和已在列表里的', async () => {
    await settle();
    const add = el('fallback-add-analysis');
    const options = Array.from(add.querySelectorAll('option')).map(
      (o) => o.textContent?.trim() ?? '',
    );
    expect(options.some((o) => o.includes('合成丙 · demo-c'))).toBe(true);
    expect(options.join('|')).not.toContain('合成甲 · demo-a');
    expect(options.join('|')).not.toContain('合成乙 · demo-b');
  });

  it('上移/下移/删掉真的动顺序，保存时 saveModelFallbacks 收到的就是新顺序', async () => {
    const s = stub();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(s, {
      analysis: [
        { providerId: 'p-b', model: 'demo-b' },
        { providerId: 'p-c', model: 'demo-c' },
      ],
    });
    await settle();

    const list = el('fallback-list-analysis');
    expect(itemTexts('fallback-list-analysis')).toEqual(['合成乙 · demo-b', '合成丙 · demo-c']);

    // 下移第一项 → 顺序反过来
    act(() => buttonIn(list, '下移').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(itemTexts('fallback-list-analysis')).toEqual(['合成丙 · demo-c', '合成乙 · demo-b']);

    // 上移第二项 → 回到原顺序
    act(() => {
      const upButtons = Array.from(list.querySelectorAll('button')).filter(
        (b) => b.textContent?.trim() === '上移',
      );
      upButtons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(itemTexts('fallback-list-analysis')).toEqual(['合成乙 · demo-b', '合成丙 · demo-c']);

    // 删掉第一项
    act(() => buttonIn(list, '删掉').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(itemTexts('fallback-list-analysis')).toEqual(['合成丙 · demo-c']);

    act(() =>
      buttonIn(el('models-uses'), '保存').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await settle();
    expect(s.saveModelFallbacks).toHaveBeenCalled();
    const payload = s.saveModelFallbacks.mock.calls.at(-1)?.[0] as {
      analysis?: Array<{ providerId: string; model: string }>;
    };
    expect(payload.analysis).toEqual([{ providerId: 'p-c', model: 'demo-c' }]);
  });

  it('保存后刷新页面：读回来的顺序跟存的一样', async () => {
    const s = stub();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(s, {
      analysis: [
        { providerId: 'p-c', model: 'demo-c' },
        { providerId: 'p-b', model: 'demo-b' },
      ],
    });
    await settle();
    expect(itemTexts('fallback-list-analysis')).toEqual(['合成丙 · demo-c', '合成乙 · demo-b']);

    // 重新挂载（等价刷新）：设置里仍是这个顺序
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(stub(), {
      analysis: [
        { providerId: 'p-c', model: 'demo-c' },
        { providerId: 'p-b', model: 'demo-b' },
      ],
    });
    await settle();
    expect(itemTexts('fallback-list-analysis')).toEqual(['合成丙 · demo-c', '合成乙 · demo-b']);
  });

  it('聊天选「跟着后台分析」时替补列表收起、显示那行说明，聊天的替补项看不见', async () => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(stub(), {
      analysis: [{ providerId: 'p-b', model: 'demo-b' }],
      chat: [{ providerId: 'p-c', model: 'demo-c' }],
    });
    await settle();
    const chat = document.querySelector('[data-testid="uses-chat"]') as HTMLSelectElement | null;
    expect(chat).toBeTruthy();
    act(() => {
      chat!.value = '';
      chat!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(text()).toContain('跟着后台分析，替补也用后台分析的');
    const chatList = document.querySelector('[data-testid="fallback-list-chat"]');
    expect(chatList ? (chatList.textContent ?? '') : '').not.toContain('合成丙 · demo-c');
  });

  it('保存被拒时主进程的提示原样显示', async () => {
    const s = stub();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(s);
    s.saveModelFallbacks.mockRejectedValueOnce(new Error('这个模型没有勾选保存过，先在模型页勾上'));
    await settle();
    act(() =>
      buttonIn(el('models-uses'), '保存').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await settle();
    expect(text()).toContain('这个模型没有勾选保存过');
  });
});
