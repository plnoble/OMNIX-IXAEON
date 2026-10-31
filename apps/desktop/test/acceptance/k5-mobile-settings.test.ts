// @vitest-environment jsdom
/**
 * K5 验收（设置页这一半）：规格 docs/委派/K5-手机只读页.md。
 *
 * 「要什么」：
 * - 设置页加开关「手机查看」，默认关；
 * - 端口默认 43192，可在设置里改；
 * - 打开后显示一条命令和说明，由用户自己执行：`tailscale serve --bg 43192`；
 * - 说明里写清怎么关（`tailscale serve status` / `tailscale serve reset`）、
 *   tailnet 里所有设备都能打开、共享给别人的话先在 Tailscale 里限制访问；
 * - 不许用 `tailscale funnel`。
 *
 * 这里只测设置页的显示与保存调用；真正写进设置项、以及保存后按设置起停见
 * k5-mobile-settings-ipc.test.ts。端口真正监听见 k5-mobile-server.test.ts。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface SavedMobile {
  enabled: boolean;
  port: number;
}

const state: { view: SettingsView; saved: SavedMobile[] } = {
  view: null as unknown as SettingsView,
  saved: [],
};

function baseView(enabled: boolean, port: number): SettingsView {
  return {
    config: {
      modelName: 'm1',
      chatModelName: '',
      apiBaseUrl: 'https://api.example.com/v1',
      apiKeyPresent: true,
      savedModels: ['m1'],
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
    cockpit: { ixaeonRepo: '', mobileEnabled: enabled, mobilePort: port },
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
    saveMobileSettings: async (input: SavedMobile) => {
      state.saved.push({ enabled: input.enabled, port: input.port });
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
  state.view = baseView(false, 43192);
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

/** 找不到就给出缺哪个 testid，而不是 null 上的 TypeError。 */
function el<T extends Element>(testId: string): T {
  const found = $(testId);
  if (!found) throw new Error(`设置页没有 data-testid="${testId}" 的元素（实现还没写）`);
  return found as T;
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    el<HTMLElement>(testId).click();
  });
}

async function fill(testId: string, value: string): Promise<void> {
  await act(async () => {
    const input = el<HTMLInputElement>(testId);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('设置页：「手机查看」开关、端口与 Tailscale 说明', () => {
  it('默认关、端口 43192', async () => {
    await render();
    const enabled = el<HTMLInputElement>('settings-mobile-enabled');
    expect(enabled.checked).toBe(false);
    expect(el<HTMLInputElement>('settings-mobile-port').value).toBe('43192');
  });

  it('打开后显示 `tailscale serve --bg 43192`，并写清怎么关、谁能看、别用 funnel', async () => {
    state.view = baseView(true, 43192);
    await render();

    expect(el<HTMLInputElement>('settings-mobile-enabled').checked).toBe(true);
    const command = el<HTMLElement>('settings-mobile-command');
    expect(command.textContent ?? '').toContain('tailscale serve --bg 43192');
    expect(command.textContent ?? '').not.toContain('funnel');

    const notes = el<HTMLElement>('settings-mobile-notes').textContent ?? '';
    expect(notes).toContain('tailscale serve status');
    expect(notes).toContain('tailscale serve reset');
    expect(notes).toContain('所有设备');
    expect(notes).toContain('共享');
    expect(notes).toContain('限制访问');
  });

  it('打开开关、把端口改成 43200、保存 → 调用 saveMobileSettings({enabled:true, port:43200})，命令跟着换端口', async () => {
    await render();
    await click('settings-mobile-enabled');
    await fill('settings-mobile-port', '43200');

    const command = el<HTMLElement>('settings-mobile-command');
    expect(command.textContent ?? '').toContain('tailscale serve --bg 43200');

    await click('settings-mobile-save');
    expect(state.saved).toEqual([{ enabled: true, port: 43200 }]);
  });

  it('打开后再关掉、保存 → 传 enabled:false', async () => {
    state.view = baseView(true, 43192);
    await render();
    await click('settings-mobile-enabled');
    await click('settings-mobile-save');
    expect(state.saved).toEqual([{ enabled: false, port: 43192 }]);
  });
});