// @vitest-environment jsdom
/**
 * M3 界面验收（规格 docs/委派/M3-换了地址旧Key不带过去.md 契约 4、条件 6）。
 * 执行方先推了一版，整合方 2026-10-03 锁定前改正补全。后端见同目录 m3-key-scope.test.ts。
 *
 * 用 api 替身渲染设置页：
 * - 保存返回 keyCleared = true → Key 一栏显示「未配置」，并出现提示
 *   （`data-testid="settings-apikey-cleared"`）；保存时 Key 留空就不带 apiKey；
 * - 普通保存（keyCleared 是 false，或者返回里没有这一项）→ 不出现提示；
 * - 出现提示之后补填 Key 再保存 → 提示消失，显示「已保存」。
 *
 * 原版的替身不管怎么保存都返回「清掉了」，页面一打开 Key 就已经是「未配置」：
 * 每次保存后都无条件弹提示的实现也能过。这里补上了不该出现提示的两种情况。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'https://a.example.com/v1';
const B = 'https://b.example.com/v1';
const NEW_KEY = 'sk-new-synthetic';

interface SaveInput {
  modelName: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

const state: {
  view: SettingsView;
  saves: SaveInput[];
  /** 替身的保存：照后端的规则改视图，返回这次有没有清 Key。null = 返回里不带 keyCleared。 */
  nextKeyCleared: boolean | null;
} = { view: null as unknown as SettingsView, saves: [], nextKeyCleared: false };

function view(apiBaseUrl: string, apiKeyPresent: boolean): SettingsView {
  return {
    config: {
      modelName: 'm',
      chatModelName: '',
      apiBaseUrl,
      apiKeyPresent,
      savedModels: ['m'],
      modelsCheckedAt: null,
      captureEnabled: false,
      autoAnalyze: false,
      extensionPaired: false,
      extensionLastSyncAt: null,
      webSearchProvider: 'none',
      webSearchKeyPresent: true,
    },
    dataDir: 'TMP',
    askCaptureStatus: 'enabled',
    mcp: { serverName: 's', command: 'c', args: [], snippet: '', localToken: null },
    encryptionNotice: '',
    extensionLoadDir: null,
    apiKeyNeedsReentry: false,
    hermesFound: false,
    hermesNotice: '',
  } as unknown as SettingsView;
}

vi.mock('../../src/renderer/src/api.js', () => {
  const specific = {
    getSettings: async () => state.view,
    listAuditEvents: async () => [],
    saveModelSettings: async (input: SaveInput) => {
      state.saves.push({
        modelName: input.modelName,
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey,
      });
      const cleared = state.nextKeyCleared;
      const typedKey = typeof input.apiKey === 'string' && input.apiKey.length > 0;
      state.view = view(
        (input.apiBaseUrl ?? state.view.config.apiBaseUrl).trim(),
        cleared === true ? false : typedKey || state.view.config.apiKeyPresent,
      );
      return cleared === null ? { ok: true as const } : { ok: true as const, keyCleared: cleared };
    },
    getPersonalMemoryToChat: async () => ({ enabled: false, personalItems: 0 }),
    getHermesBridgeStatus: async () => ({ enabled: false, blockedReason: null }),
    getSemanticIndexStatus: async () => ({
      enabled: false,
      model: null,
      indexed: 0,
      total: 0,
      lastError: null,
    }),
    getUpdateStatus: async () => ({ state: 'none' as const }),
  };
  // 设置页其余卡片各自会调 api：没显式给的一律回一个安静的空 Promise
  const passthrough = new Proxy(specific, {
    get: (target, key) => {
      if (key in target) return (target as Record<string | symbol, unknown>)[key];
      return (name: string | symbol) =>
        name === 'on' ? () => () => undefined : async () => undefined;
    },
  });
  return {
    api: passthrough,
    errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

import { SettingsPage } from '../../src/renderer/src/pages/Settings.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.view = view(A, true);
  state.saves = [];
  state.nextKeyCleared = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(SettingsPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const $ = <T extends Element>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

/** 像用户那样往输入框里打字（React 的受控输入要走原生的 value 设置器）。 */
async function type(testId: string, value: string): Promise<void> {
  const el = $<HTMLInputElement>(testId)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect($<HTMLInputElement>(testId)!.value).toBe(value);
}

async function clickSave(): Promise<void> {
  await act(async () => {
    $<HTMLButtonElement>('settings-model-save')!.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 模型接入卡片里的文字（「未配置」在别的卡片里也有，只看这一张）。 */
const modelCard = () => $('settings-model')!.textContent ?? '';
const cleared = () => $('settings-apikey-cleared');

describe('M3 条件 6：Key 因为换地址被清掉之后，设置页说清楚', () => {
  it('地址改成另一家、Key 留空保存：显示「未配置」和提示；保存时没带 Key', async () => {
    await render();
    expect(modelCard()).toContain('已保存（不回显）');
    expect(cleared()).toBeNull();

    state.nextKeyCleared = true;
    await type('settings-api-base', B);
    await clickSave();

    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]!.apiBaseUrl!.trim()).toBe(B);
    expect(state.saves[0]!.apiKey ?? '').toBe('');
    expect(modelCard()).toContain('未配置');
    expect(modelCard()).not.toContain('已保存（不回显）');
    expect(cleared()).not.toBeNull();
    expect(cleared()!.textContent).toContain('地址变了，原来的 Key 没有带到新地址');
    expect(cleared()!.textContent).toContain('重新填');
  });

  for (const [label, flag] of [
    ['keyCleared 是 false', false],
    ['返回里没有 keyCleared（旧的主进程）', null],
  ] as Array<[string, boolean | null]>) {
    it(`普通保存（${label}）：不出现提示`, async () => {
      await render();
      state.nextKeyCleared = flag;
      await type('settings-api-base', 'https://a.example.com/v2');
      await clickSave();
      expect(state.saves).toHaveLength(1);
      expect(cleared()).toBeNull();
      expect(modelCard()).toContain('已保存（不回显）');
    });
  }

  it('出现提示之后补填 Key 再保存：提示消失，显示「已保存」，页面上看不到 Key', async () => {
    await render();
    state.nextKeyCleared = true;
    await type('settings-api-base', B);
    await clickSave();
    expect(cleared()).not.toBeNull();

    state.nextKeyCleared = false;
    await type('settings-api-key', NEW_KEY);
    await clickSave();

    expect(state.saves).toHaveLength(2);
    expect(state.saves[1]!.apiKey).toBe(NEW_KEY);
    expect(cleared()).toBeNull();
    expect(modelCard()).toContain('已保存（不回显）');
    // Key 不回显：输入框清空，页面文字里没有它
    expect($<HTMLInputElement>('settings-api-key')!.value).toBe('');
    expect(container.textContent ?? '').not.toContain(NEW_KEY);
  });
});
