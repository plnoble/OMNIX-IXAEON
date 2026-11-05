// @vitest-environment jsdom
/**
 * MP3b 验收条件 11（界面）：「模型」页「用途」里的替补列表。
 *
 * 对应规格「验收条件」第 11 条的前五小条：
 * - 两个用途下面各有替补列表；每项「供应商名 · 模型」，带上移 / 下移 / 删掉；
 * - 列表下面一个下拉框加「添加」，选项是所有供应商勾选过的模型，去掉主选和已在列表里的；满 4 项「添加」不能点；
 * - 和主选共用「保存」，一次存主选和替补；
 * - 聊天选「跟着后台分析」时替补列表收起，原地写一行说明；
 * - 保存被拒时主进程的提示原样显示。
 *
 * 第 11 条最后一小条「聊天里带替补提示的回答下面显示那句话」是聊天页的渲染，
 * 由 `apps/desktop/e2e/mp3b-fallback.spec.ts`（条件 12 的端到端）覆盖——那里会断言对话里出现那句话。
 *
 * 现在界面还没做（ModelsPage 里没有替补列表），本文件应当红：找不到「替补（这一个不行按顺序换下一个）」。
 * 用 jsdom 渲染真的 ModelsPage，`window.ixaeon` 换成合成桩。
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

interface Stub {
  saveModelUses: ReturnType<typeof vi.fn>;
  saveModelFallbacks: ReturnType<typeof vi.fn>;
  saveModelProvider: ReturnType<typeof vi.fn>;
}

let root: Root | null = null;
let container: HTMLElement;

function mount(stub: Stub): void {
  (globalThis as unknown as { window: Window & { ixaeon?: unknown } }).window.ixaeon = {
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
        fallbacks: { analysis: [{ providerId: 'p-b', model: 'demo-b' }] },
      },
      dataDir: '',
    }),
    listModelProviders: async () => [
      provider('p-a', '合成甲', ['demo-a']),
      provider('p-b', '合成乙', ['demo-b']),
      provider('p-c', '合成丙', ['demo-c']),
    ],
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

beforeEach(() => {
  mount(stub());
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function card(): HTMLElement {
  const el = document.querySelector('[data-testid="models-uses"]');
  if (!el) throw new Error('没有「用途」卡片');
  return el as HTMLElement;
}

function text(): string {
  return document.body.textContent ?? '';
}

describe('MP3b 条件 11：用途里的替补列表', () => {
  it('两个用途下面各有替补列表，项是「供应商名 · 模型」，有上移/下移/删掉', async () => {
    await settle();
    expect(text()).toContain('替补（这一个不行按顺序换下一个）');
    expect(text()).toContain('合成乙 · demo-b');
    expect(text()).toContain('上移');
    expect(text()).toContain('下移');
    expect(text()).toContain('删掉');
  });

  it('满 4 项时「添加」不能点', async () => {
    await settle();
    const addButtons = Array.from(card().querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === '添加',
    );
    expect(addButtons.length).toBeGreaterThan(0);
    // 列表里已有 1 项；再加 3 项到满 4，然后「添加」应变灰
    for (let i = 0; i < 3; i += 1) {
      act(() => addButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await settle();
    }
    const after = Array.from(card().querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === '添加',
    );
    expect(after[0]!.hasAttribute('disabled')).toBe(true);
  });

  it('下拉框里没有主选和已在列表里的', async () => {
    await settle();
    const selects = Array.from(card().querySelectorAll('select')).filter(
      (s) => s.querySelectorAll('option').length > 0,
    );
    const options = selects.flatMap((s) =>
      Array.from(s.querySelectorAll('option')).map((o) => o.textContent?.trim() ?? ''),
    );
    // 有一个可选的（合成丙 · demo-c），且不含主选和已在列表里的
    expect(options.some((o) => o.includes('合成丙 · demo-c'))).toBe(true);
    expect(options.join('|')).not.toContain('合成甲 · demo-a');
    expect(options.join('|')).not.toContain('合成乙 · demo-b');
  });

  it('聊天选「跟着后台分析」时替补列表收起，显示那一行说明', async () => {
    await settle();
    const chat = card().querySelector('[data-testid="uses-chat"]') as HTMLSelectElement | null;
    expect(chat).toBeTruthy();
    act(() => {
      chat!.value = '';
      chat!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(text()).toContain('跟着后台分析，替补也用后台分析的');
  });

  it('保存被拒时主进程的提示原样显示', async () => {
    const s = stub();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    mount(s);
    s.saveModelFallbacks.mockRejectedValueOnce(new Error('这个模型没有勾选保存过，先在模型页勾上'));
    await settle();
    const save = card().querySelector('[data-testid="uses-save"]') as HTMLButtonElement;
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(text()).toContain('这个模型没有勾选保存过');
  });
});
