// @vitest-environment jsdom
/**
 * SUB1b 验收（界面：设置页额度来源；规格 docs/委派/SUB1-直接接magpie.md 条件 8）。
 *
 * 条件 8：设置页里不再有 QuotaHub 地址（字段与提示都不再出现），换成 magpie 地址；
 *         手动登记照旧出现、能删。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  view: null as unknown,
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getSettings: async () => state.view,
    saveCockpitSettings: async (input: Record<string, unknown>) => {
      state.saved.push(input);
      return { ok: true as const };
    },
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { QuotaSettingsCard } from '../../src/renderer/src/pages/QuotaSettings.js';

let container: HTMLDivElement;
let root: Root;

function view(magpieUrl = ''): SettingsView {
  return <SettingsView>(<unknown>{
    config: {
      modelName: '',
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
    },
    dataDir: 'TMP',
    cockpit: {
      ixaeonRepo: '',
      magpieUrl,
      manualQuotas: [
        {
          account: '手动合成账号',
          window: '每周',
          resetAt: null,
          expiresAt: null,
          registeredAt: '2026-10-30T12:00:00.000Z',
        },
      ],
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

async function render(v: SettingsView): Promise<void> {
  state.view = v;
  await act(async () => {
    root.render(createElement(QuotaSettingsCard));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  state.saved = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('SUB1b 设置页额度来源', () => {
  it('条件 8：没有 QuotaHub 地址，改成 magpie 地址；手动登记照旧出现', async () => {
    await render(view(''));

    expect(container.textContent).not.toContain('QuotaHub');
    expect($('settings-quotahub-url')).toBeNull();
    expect($<HTMLInputElement>('settings-magpie-url')).toBeTruthy();
    expect($<HTMLInputElement>('settings-magpie-url')!.value).toBe('');
    expect($('settings-manual-quota')!.textContent).toContain('手动合成账号');
  });

  it('保存 magpie 地址 → 只写 magpieUrl；已保存的地址回显', async () => {
    await render(view('http://127.0.0.1:3425'));
    const input = $<HTMLInputElement>('settings-magpie-url')!;
    expect(input.value).toBe('http://127.0.0.1:3425');

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'http://localhost:3999');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      $<HTMLButtonElement>('settings-magpie-url-save')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.saved).toEqual([{ magpieUrl: 'http://localhost:3999' }]);
  });
});
