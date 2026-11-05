// @vitest-environment jsdom
/**
 * MP3c 验收条件 6（界面）：「模型」页有三行开发工具，显示找到 / 没找到、手填 / 自动。
 * 手填保存后这一行变成手填；「恢复自动」后变回自动。
 *
 * data-testid（规格第 4 条写死）：`devtool-row-<tool>`、`devtool-path-<tool>`、
 * `devtool-save-<tool>`、`devtool-auto-<tool>`。
 *
 * 现在界面还没做，本文件红在找不到 `devtool-row-codex`。
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  saved: [] as Array<{ tool: string; path: string | null }>,
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
      },
      dataDir: '',
    }),
    listModelProviders: async () => [],
    getDevTools: async () => harness.rows,
    saveDevToolPath: async (input: { tool: string; path: string | null }) => {
      harness.saved.push(input);
      const row = harness.rows.find((r) => r['tool'] === input.tool)!;
      row['found'] = input.path !== null;
      row['path'] = input.path;
      row['source'] = input.path === null ? 'auto' : 'manual';
      return { ok: true as const };
    },
    fetchProviderModels: async () => ({ models: [], error: null }),
    saveModelUses: async () => ({ ok: true as const }),
    saveModelFallbacks: async () => ({ ok: true as const }),
    saveModelProvider: async () => ({ ok: true as const, id: 'p', keyCleared: false }),
    saveCodingChain: async () => ({ ok: true as const }),
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
  harness.saved = [];
  harness.rows = [
    { tool: 'codex', found: false, path: null, source: null, note: '没找到，可以手填位置' },
    { tool: 'claude', found: true, path: 'C:/fake/claude.exe', source: 'auto', note: null },
    { tool: 'dsh', found: false, path: null, source: null, note: '没找到，可以手填位置' },
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

describe('MP3c 条件 6：开发工具三行', () => {
  it('三行都在，显示找到 / 没找到', async () => {
    for (const t of ['codex', 'claude', 'dsh']) {
      expect(el(`devtool-row-${t}`)).toBeTruthy();
    }
    expect(el('devtool-row-codex').textContent).toContain('没找到');
    expect(el('devtool-row-claude').textContent).toContain('找到');
    expect(el('devtool-row-claude').textContent).not.toContain('没找到');
  });

  it('手填保存后这一行变成手填；「恢复自动」后变回自动', async () => {
    const input = el('devtool-path-codex') as HTMLInputElement;
    act(() => {
      input.value = 'C:/fake/codex.exe';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    act(() => el('devtool-save-codex').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(harness.saved.at(-1)).toEqual({ tool: 'codex', path: 'C:/fake/codex.exe' });
    expect(el('devtool-row-codex').textContent).toContain('手填');

    act(() => el('devtool-auto-codex').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(harness.saved.at(-1)).toEqual({ tool: 'codex', path: null });
  });
});
