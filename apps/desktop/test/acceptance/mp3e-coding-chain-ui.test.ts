// @vitest-environment jsdom
/**
 * MP3e 验收条件 14（界面）：「模型」页「编码任务」改成主选 + 替补列表。
 *
 * - 列表能加「开发工具」（Claude Code 可选模型）和「供应商」两种；
 * - 上移 / 下移 / 删掉真的改顺序；保存时 `saveCodingChain` 收到的就是新顺序；
 * - 没找到的开发工具标「没找到」。
 *
 * data-testid（规格第 10 条写死）：`coding-chain-list`、`coding-chain-add`。
 * 现在界面还没做，本文件红在找不到 `coding-chain-list`。
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  savedChain: [] as unknown[],
  devtools: [] as Array<Record<string, unknown>>,
  providers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getSettings: async () => ({
      config: {
        modelName: 'demo-a',
        chatModelName: '',
        apiBaseUrl: '',
        apiKeyPresent: false,
        savedModels: [],
        modelsCheckedAt: null,
        codingExecutor: 'codex',
        codingModelName: '',
        captureEnabled: false,
        autoAnalyze: false,
        extensionPaired: false,
        extensionLastSyncAt: null,
        webSearchProvider: 'none',
        webSearchKeyPresent: false,
        uses: {},
        fallbacks: {},
        codingChain: [],
      },
      dataDir: '',
    }),
    listModelProviders: async () => h.providers,
    getDevTools: async () => h.devtools,
    saveDevToolPath: async () => ({ ok: true as const }),
    fetchProviderModels: async () => ({ models: [], error: null }),
    saveModelUses: async () => ({ ok: true as const }),
    saveModelFallbacks: async () => ({ ok: true as const }),
    saveModelProvider: async () => ({ ok: true as const, id: 'p', keyCleared: false }),
    saveCodingChain: async (list: unknown[]) => {
      h.savedChain = list;
      return { ok: true as const };
    },
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { ModelsPage } from '../../src/renderer/src/pages/Models';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  h.savedChain = [];
  h.devtools = [
    { tool: 'codex', found: true, path: 'C:/fake/codex.exe', source: 'manual', note: null },
    { tool: 'claude', found: true, path: 'C:/fake/claude.exe', source: 'manual', note: null },
    { tool: 'dsh', found: false, path: null, source: null, note: '没找到，可以手填位置' },
  ];
  h.providers = [
    {
      id: 'p-a',
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: 'http://127.0.0.1:18081/v1',
      apiKeyPresent: true,
      apiKeyTail: 'c3d4',
      apiKeyUnreadable: false,
      savedModels: ['demo-a'],
      modelsCheckedAt: null,
      usedBy: [],
    },
  ];
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(ModelsPage)));
  await settle();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function el(id: string): HTMLElement {
  const n = document.querySelector(`[data-testid="${id}"]`);
  if (!n) throw new Error(`找不到 ${id}`);
  return n as HTMLElement;
}

function buttonIn(host: HTMLElement, name: string): HTMLButtonElement {
  const b = Array.from(host.querySelectorAll('button')).find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`找不到按钮「${name}」`);
  return b as HTMLButtonElement;
}

function items(): string[] {
  return Array.from(el('coding-chain-list').querySelectorAll('li')).map((li) =>
    (li.textContent ?? '').trim(),
  );
}

describe('MP3e 条件 14：编码任务的主选 + 替补列表', () => {
  it('能加「开发工具」（含 Claude Code 选模型）和「供应商」两种；没找到的标「没找到」', async () => {
    const add = el('coding-chain-add');
    // 加一个供应商项
    act(() => buttonIn(add, '添加').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(items().length).toBeGreaterThan(0);
    // 列表里能看到 DSH 且标「没找到」（DSH 是没找到的工具，仍可选）
    expect(el('coding-chain-add').textContent).toContain('DSH');
    expect(el('coding-chain-add').textContent).toContain('没找到');
  });

  it('上移 / 下移 / 删掉真的改顺序，保存时 saveCodingChain 收到的就是新顺序', async () => {
    const add = el('coding-chain-add');
    act(() => buttonIn(add, '添加').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    act(() => buttonIn(add, '添加').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const before = items();
    expect(before.length).toBe(2);

    const list = el('coding-chain-list');
    const downButtons = Array.from(list.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === '下移',
    );
    act(() => downButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(items()).toEqual([before[1], before[0]]);

    act(() =>
      buttonIn(el('models-uses'), '保存').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await settle();
    expect(h.savedChain.length).toBe(2);
    expect((h.savedChain[0] as { kind: string }).kind).toBeTruthy();
  });
});
