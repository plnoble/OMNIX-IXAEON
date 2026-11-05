// @vitest-environment jsdom
/**
 * MP3e 验收条件 14（界面）：「模型」页「编码任务」改成主选 + 替补列表。
 *
 * - 列表能加「开发工具」（Claude Code 可选模型）和「供应商」两种；
 * - 上移 / 下移 / 删掉真的改顺序；保存时 `saveCodingChain` 收到的就是新顺序；
 * - 没找到的开发工具标「没找到」。
 *
 * data-testid（规格第 10 条写死）：`coding-chain-list`、`coding-chain-add`；添加区四个下拉见下（规格「测试入口」）。
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

/**
 * 整合方 11-05 改：原来只点「添加」用默认选中的那一项，没真的选种类、工具、模型，也没核对保存的内容。
 * 规格「测试入口」补写死：`coding-chain-add` 里有四个下拉——
 * `coding-chain-kind`（选项文字「开发工具」「供应商」）、`coding-chain-tool`（「Codex」「Claude Code」「DSH」，
 * 没找到的选项文字带「没找到」）、`coding-chain-claude-model`（「默认」「opus」「sonnet」「haiku」，只在选了 Claude Code 时出现）、
 * `coding-chain-provider`（「<供应商名> · <模型>」）。测试按选项文字选。
 * 列表每项文字（不算项里的按钮）：「Codex」「Claude Code · sonnet」「DSH」「合成甲 · demo-a」；没找到的工具项后面带「没找到」。
 */
function pick(testId: string, text: string): void {
  const sel = el(testId) as HTMLSelectElement;
  const opt = Array.from(sel.options).find((o) => (o.textContent ?? '').trim().startsWith(text));
  if (!opt) throw new Error(`${testId} 里没有「${text}」`);
  act(() => {
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function addTool(tool: string, model?: string): Promise<void> {
  pick('coding-chain-kind', '开发工具');
  await settle();
  pick('coding-chain-tool', tool);
  await settle();
  if (model) {
    pick('coding-chain-claude-model', model);
    await settle();
  }
  act(() =>
    buttonIn(el('coding-chain-add'), '添加').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    ),
  );
  await settle();
}

async function addProvider(label: string): Promise<void> {
  pick('coding-chain-kind', '供应商');
  await settle();
  pick('coding-chain-provider', label);
  await settle();
  act(() =>
    buttonIn(el('coding-chain-add'), '添加').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    ),
  );
  await settle();
}

/** 每项文字，不算项里的按钮。 */
function labels(): string[] {
  return Array.from(el('coding-chain-list').querySelectorAll('li')).map((li) => {
    const copy = li.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('button').forEach((b) => b.remove());
    return (copy.textContent ?? '').trim();
  });
}

function clickIn(host: Element, name: string, index = 0): void {
  const b = Array.from(host.querySelectorAll('button')).filter(
    (x) => x.textContent?.trim() === name,
  )[index];
  if (!b) throw new Error(`找不到第 ${index + 1} 个「${name}」`);
  act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function save(): Promise<void> {
  act(() => el('uses-save').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
}

describe('MP3e 条件 14：编码任务的主选 + 替补列表', () => {
  it('能加开发工具（Claude Code 选模型）和供应商两种；没找到的工具标「没找到」；保存收到的就是这几项', async () => {
    await addTool('Claude Code', 'sonnet');
    await addProvider('合成甲 · demo-a');
    await addTool('DSH');
    const got = labels();
    expect(got[0]).toBe('Claude Code · sonnet');
    expect(got[1]).toBe('合成甲 · demo-a');
    expect(got[2]).toContain('DSH');
    expect(got[2]).toContain('没找到');
    // 没找到的工具在下拉里也标出来
    expect(el('coding-chain-tool').textContent).toContain('没找到');
    await save();
    expect(h.savedChain).toEqual([
      { kind: 'tool', tool: 'claude', model: 'sonnet' },
      { kind: 'provider', providerId: 'p-a', model: 'demo-a' },
      { kind: 'tool', tool: 'dsh' },
    ]);
  });

  it('Claude Code 选「默认」时保存的那一项不带 model', async () => {
    await addTool('Claude Code', '默认');
    await save();
    expect(h.savedChain).toEqual([{ kind: 'tool', tool: 'claude' }]);
  });

  it('上移 / 下移 / 删掉真的改顺序，保存时 saveCodingChain 收到的就是新顺序', async () => {
    await addTool('Codex');
    await addTool('Claude Code', 'opus');
    await addProvider('合成甲 · demo-a');
    expect(labels()).toEqual(['Codex', 'Claude Code · opus', '合成甲 · demo-a']);
    const list = el('coding-chain-list');
    clickIn(list, '下移', 0);
    await settle();
    expect(labels()).toEqual(['Claude Code · opus', 'Codex', '合成甲 · demo-a']);
    clickIn(el('coding-chain-list'), '上移', 2);
    await settle();
    expect(labels()).toEqual(['Claude Code · opus', '合成甲 · demo-a', 'Codex']);
    clickIn(el('coding-chain-list'), '删掉', 0);
    await settle();
    expect(labels()).toEqual(['合成甲 · demo-a', 'Codex']);
    await save();
    expect(h.savedChain).toEqual([
      { kind: 'provider', providerId: 'p-a', model: 'demo-a' },
      { kind: 'tool', tool: 'codex' },
    ]);
  });

  it('满 5 项时「添加」不能点', async () => {
    await addTool('Codex');
    await addTool('Claude Code', 'opus');
    await addTool('Claude Code', 'sonnet');
    await addTool('Claude Code', 'haiku');
    await addProvider('合成甲 · demo-a');
    expect(labels()).toHaveLength(5);
    expect(buttonIn(el('coding-chain-add'), '添加').disabled).toBe(true);
  });
});
