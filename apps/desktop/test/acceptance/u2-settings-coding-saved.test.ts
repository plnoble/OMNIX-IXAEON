// @vitest-environment jsdom
/**
 * U2 验收（设置页那一半）：「编码任务交给谁」写明现在生效的是哪个，改了没保存要提醒。
 *
 * 来由（用户 2026-10-05 试场景一）：用户以为已经交给自己的模型了，任务却是 Codex 做的——
 * 设置里保存的还是 Codex。这张卡片有自己的「保存」按钮，下拉框改了不点它不算数，
 * 页面上又看不出现在生效的到底是哪个。
 *
 * 条件：
 * 5. 卡片上写明现在生效的：Codex，或者「我的模型（<模型名>）」；选了我的模型却没选模型的，
 *    写明编码任务会停在排队里。
 * 6. 下拉框改了、还没点保存：出现提醒，「现在生效的」不变；保存之后提醒消失，「现在生效的」跟着变。
 * 7. 没改的时候不提醒（包括刚打开页面时）。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: { view: SettingsView } = { view: null as unknown as SettingsView };

function view(codingExecutor: string, codingModelName: string): SettingsView {
  return {
    config: {
      modelName: 'm1',
      chatModelName: '',
      apiBaseUrl: 'https://api.example.com/v1',
      apiKeyPresent: true,
      savedModels: ['m1', 'm2'],
      modelsCheckedAt: null,
      captureEnabled: false,
      autoAnalyze: false,
      extensionPaired: false,
      extensionLastSyncAt: null,
      webSearchProvider: 'none',
      webSearchKeyPresent: false,
      codingExecutor,
      codingModelName,
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
    // 像真的主进程那样：保存之后，再读到的就是新的
    saveCodingSettings: async (input: { executor: string; modelName: string }) => {
      state.view = view(input.executor, input.modelName);
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
    getUpdateStatus: async () => ({ state: 'none' as const }),
  };
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
  state.view = view('codex', '');
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
const current = () => $('settings-coding-current')?.textContent ?? '';
const unsaved = () => $('settings-coding-unsaved');

async function choose(testId: string, value: string): Promise<void> {
  const el = $<HTMLSelectElement>(testId)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect($<HTMLSelectElement>(testId)!.value).toBe(value);
}

async function save(): Promise<void> {
  await act(async () => {
    $<HTMLButtonElement>('settings-coding-save')!.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('U2 设置页「编码任务交给谁」：现在生效的是哪个', () => {
  it('条件 5、7：刚打开——写着现在生效的是 Codex，没有提醒', async () => {
    await render();
    expect(current()).toContain('现在生效的');
    expect(current()).toContain('Codex');
    expect(current()).not.toContain('我的模型');
    expect(unsaved()).toBeNull();
  });

  it('条件 6：选了「我的模型」和模型但没点保存——提醒；生效的还是 Codex；保存后跟着变', async () => {
    await render();
    await choose('settings-coding-executor', 'model');
    expect(unsaved(), '只改了执行器就该提醒').not.toBeNull();
    await choose('settings-coding-model', 'm2');
    expect(unsaved()).not.toBeNull();
    expect(unsaved()!.textContent).toContain('保存');
    expect(current()).toContain('Codex');
    expect(current()).not.toContain('我的模型');

    await save();
    expect(unsaved()).toBeNull();
    expect(current()).toContain('我的模型（m2）');
    expect(current()).not.toContain('Codex');
  });

  it('条件 6：已经是我的模型（m1），下拉框换成 m2 没保存——提醒；换回 m1 提醒消失', async () => {
    state.view = view('model', 'm1');
    await render();
    expect(current()).toContain('我的模型（m1）');
    expect(unsaved()).toBeNull();
    await choose('settings-coding-model', 'm2');
    expect(unsaved()).not.toBeNull();
    expect(current()).toContain('我的模型（m1）');
    await choose('settings-coding-model', 'm1');
    expect(unsaved()).toBeNull();
  });

  it('条件 5：选了我的模型却没选模型（或选的已不在清单里）——写明编码任务会停在排队里', async () => {
    for (const name of ['', 'gone']) {
      state.view = view('model', name);
      await render();
      expect(current()).toContain('我的模型');
      expect(current()).toContain('还没选模型');
      expect(current()).toContain('排队');
      expect(current()).not.toContain('gone');
      expect(unsaved()).toBeNull();
      act(() => root.unmount());
      root = createRoot(container);
    }
  });
});
