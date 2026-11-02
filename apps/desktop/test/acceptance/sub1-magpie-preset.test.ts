// @vitest-environment jsdom
/**
 * SUB1 验收（界面，「模型接入」的 magpie 一键预设；规格 docs/委派/SUB1-直接接magpie.md）。
 *
 * 条件 1：合成 magpie（测试里的 listAvailableModels 替身回 3 个 `prov/model`）
 *         → 点「用本机 magpie」后 API 地址、Key 填好，模型清单里正好这 3 个。
 * 条件 2：合成服务没起（检测抛错）→ 出「没连上本机 magpie（127.0.0.1:3425），先把 magpie 打开」，
 *         地址和 Key 不变。
 *
 * 走现有检测通道（`api.listAvailableModels`），不另开写配置的 IPC；保存仍由用户勾选后
 * 「保存选择」完成（这里只钉住预设与检测）。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAGPIE_BASE = 'http://127.0.0.1:3425/v1';
const MAGPIE_ERROR = '没连上本机 magpie（127.0.0.1:3425），先把 magpie 打开';

const state = vi.hoisted(() => ({
  view: null as unknown,
  upstream: [] as Array<{ id: string }>,
  failWith: null as string | null,
  calls: [] as Array<{ apiBaseUrl: string; apiKey: string }>,
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/renderer/src/api.js', () => {
  const specific = {
    getSettings: async () => state.view,
    listAuditEvents: async () => [],
    listAvailableModels: async (input: { apiBaseUrl: string; apiKey: string }) => {
      state.calls.push({ apiBaseUrl: input.apiBaseUrl, apiKey: input.apiKey });
      if (state.failWith !== null) throw new Error(state.failWith);
      return { models: state.upstream };
    },
    saveModelSettings: async (input: Record<string, unknown>) => {
      state.saved.push(input);
      return { ok: true as const, keyCleared: false };
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
  // 设置页其余卡片会各自调 api：没显式 mock 的方法一律给安静的空 Promise。
  const passthrough = new Proxy(specific, {
    get: (target, key) => {
      if (key in target) return (target as Record<string | symbol, unknown>)[key];
      return key === 'on' ? () => () => undefined : async () => undefined;
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

function view(over: { apiBaseUrl?: string; savedModels?: string[] } = {}): SettingsView {
  return <SettingsView>(<unknown>{
    config: {
      modelName: '',
      chatModelName: '',
      apiBaseUrl: over.apiBaseUrl ?? '',
      apiKeyPresent: false,
      savedModels: over.savedModels ?? [],
      modelsCheckedAt: null,
      codingExecutor: 'codex',
      codingModelName: '',
      captureEnabled: false,
      autoAnalyze: false,
      extensionPaired: false,
      extensionLastSyncAt: null,
      webSearchProvider: 'none',
      webSearchKeyPresent: false,
    },
    dataDir: 'TMP',
    cockpit: {
      ixaeonRepo: '',
      magpieUrl: '',
      manualQuotas: [],
      mobileEnabled: false,
      mobilePort: 43192,
    },
    askCaptureStatus: 'enabled',
    mcp: { serverName: 's', command: 'c', args: [], snippet: '', localToken: null },
    encryptionNotice: '',
    extensionLoadDir: null,
    apiKeyNeedsReentry: false,
    hermesFound: false,
    hermesNotice: '',
  });
}

beforeEach(() => {
  state.view = view();
  state.upstream = [];
  state.failWith = null;
  state.calls = [];
  state.saved = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(SettingsPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickMagpie(): Promise<void> {
  await act(async () => {
    $<HTMLButtonElement>('settings-magpie')!.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('SUB1 模型接入：用本机 magpie', () => {
  it('条件 1：点「用本机 magpie」→ 地址、Key 填好，模型清单正好是上游那 3 个 prov/model', async () => {
    // 合成 magpie 的 /v1/models：3 个 provider/model
    state.upstream = [{ id: 'prov/m1' }, { id: 'prov/m2' }, { id: 'prov/m3' }];
    await render();
    await clickMagpie();

    // 检测走的是 magpie 预设的地址与 Key（不是表单原来的空值）
    expect(state.calls).toEqual([{ apiBaseUrl: MAGPIE_BASE, apiKey: 'magpie' }]);
    const base = $<HTMLInputElement>('settings-api-base')!;
    expect(base.value).toBe(MAGPIE_BASE);
    expect($<HTMLInputElement>('settings-api-key')!.value).toBe('magpie');

    // 清单里正好这 3 个（顺序按上游）
    const ids = [
      ...container.querySelectorAll<HTMLInputElement>('[data-testid="settings-model-check"]'),
    ].map((el) => el.dataset['modelId']);
    expect(ids).toEqual(['prov/m1', 'prov/m2', 'prov/m3']);
    expect($('settings-model-checklist')!.textContent).not.toContain('上游已没有');
    // 用户照旧勾选后保存（这里只钉住预设没有偷偷保存）
    expect(state.saved).toEqual([]);
  });

  it('条件 2：magpie 没起 → 出那句话，地址和 Key 保持不变，清单也不动', async () => {
    state.view = view({ apiBaseUrl: 'https://api.example.com/v1', savedModels: ['kept-model'] });
    state.failWith = '获取模型列表失败：fetch failed';
    await render();
    await clickMagpie();

    expect(state.calls).toEqual([{ apiBaseUrl: MAGPIE_BASE, apiKey: 'magpie' }]);
    expect($<HTMLInputElement>('settings-api-base')!.value).toBe('https://api.example.com/v1');
    // Key 输入框本来就没填（已保存的 Key 不回显）→ 还是空
    expect($<HTMLInputElement>('settings-api-key')!.value).toBe('');
    expect($('settings-magpie-error')!.textContent).toContain(MAGPIE_ERROR);
    // 已保存清单还在，没有被 magpie 的失败清掉
    const ids = [
      ...container.querySelectorAll<HTMLInputElement>('[data-testid="settings-model-check"]'),
    ].map((el) => el.dataset['modelId']);
    expect(ids).toEqual(['kept-model']);
  });
});
