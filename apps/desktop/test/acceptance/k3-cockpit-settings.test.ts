// @vitest-environment jsdom
/**
 * K3 验收 条件 7（界面这一半）：规格 docs/委派/K3-驾驶舱页面.md。
 *
 * 条件 7：设置页填了仓库路径、保存 → `cockpit.ixaeon_repo` 存上了；清空保存 → 设置项变空。
 * 这一份测设置页的输入框与保存调用；IPC 真正写进设置项见 k3-cockpit-settings-ipc.test.ts。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: {
  view: SettingsView;
  saved: Array<{ ixaeonRepo: string }>;
} = { view: null as unknown as SettingsView, saved: [] };

function baseView(repo: string): SettingsView {
  return {
    config: {
      modelName: 'm1',
      chatModelName: '',
      apiBaseUrl: 'https://api.example.com/v1',
      apiKeyPresent: true,
      savedModels: ['m1'],
      modelsCheckedAt: null,
      captureEnabled: false,
      autoAnalyze: false,
      extensionPaired: false,
      extensionLastSyncAt: null,
      webSearchProvider: 'none',
      webSearchKeyPresent: false,
    },
    cockpit: { ixaeonRepo: repo },
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
    saveCockpitSettings: async (input: { ixaeonRepo: string }) => {
      state.saved.push({ ixaeonRepo: input.ixaeonRepo });
      return { ok: true as const };
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
  };
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

beforeEach(() => {
  state.view = baseView('');
  state.saved = [];
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

async function save(): Promise<void> {
  await act(async () => {
    $<HTMLButtonElement>('settings-cockpit-save')!.click();
  });
}

async function fill(value: string): Promise<void> {
  await act(async () => {
    const input = $<HTMLInputElement>('settings-cockpit-repo')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('条件 7：设置页的 IXAEON 仓库路径', () => {
  it('填了路径、保存 → 调用 api.saveCockpitSettings({ ixaeonRepo: 路径 })', async () => {
    await render();
    const input = $<HTMLInputElement>('settings-cockpit-repo')!;
    expect(input.value).toBe('');
    await fill('D:\\合成\\IXAEON');
    await save();
    expect(state.saved).toEqual([{ ixaeonRepo: 'D:\\合成\\IXAEON' }]);
  });

  it('已有的路径打开时显示在输入框里；清空保存 → 传空串', async () => {
    state.view = baseView('D:\\合成\\IXAEON');
    await render();
    const input = $<HTMLInputElement>('settings-cockpit-repo')!;
    expect(input.value).toBe('D:\\合成\\IXAEON');
    await fill('');
    await save();
    expect(state.saved).toEqual([{ ixaeonRepo: '' }]);
  });
});
