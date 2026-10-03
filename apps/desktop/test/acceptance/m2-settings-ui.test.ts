// @vitest-environment jsdom
/**
 * M2 界面逻辑验收（规格 docs/委派/M2-模型管理-检测勾选保存.md 契约 1-5 的纯逻辑部分；
 * 全流程真机形态由 e2e m2-model-ui.spec.ts 照过）。
 *
 * 用 api 替身渲染设置页，逐条钉住：
 * - 契约 2：首次检测（一个已保存模型都没有）也有筛选框；新出现的标「新」；
 * - 契约 2：勾选尚未保存的模型后重检，该模型从上游消失 → 从勾选里清掉，
 *   保存时不会把看不见的模型写进清单；
 * - 契约 3/4：模型名称/聊天模型下拉只从已保存清单选，聊天多「跟随分析模型」；
 *   当前在用的模型不在清单里照样显示并标「不在已保存清单」；
 * - 契约 7：检测失败如实显示错误，清单与勾选保持不变。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Captured {
  modelName: string;
  chatModelName: string;
  apiBaseUrl: string;
  apiKey?: string;
  savedModels: string[];
}

const state: {
  view: SettingsView;
  upstream: Array<{ id: string }>;
  failWith: string | null;
  saved: Captured[];
  hangNext: boolean;
  hangRelease: (() => void) | null;
  hangRegistrar: ((release: () => void) => void) | null;
} = {
  view: null as unknown as SettingsView,
  upstream: [],
  failWith: null,
  saved: [],
  hangNext: false,
  hangRelease: null,
  hangRegistrar: null,
};

function baseView(savedModels: string[]): SettingsView {
  return {
    config: {
      modelName: 'wizard-model',
      chatModelName: '',
      apiBaseUrl: 'https://api.example.com/v1',
      apiKeyPresent: true,
      savedModels,
      modelsCheckedAt: null,
      captureEnabled: false,
      autoAnalyze: false,
      extensionPaired: false,
      extensionLastSyncAt: null,
      webSearchProvider: 'none',
      webSearchKeyPresent: false,
    },
    dataDir: 'TMP',
    askCaptureStatus: 'enabled',
    mcp: { serverName: 's', command: 'c', args: [], snippet: '', localToken: null },
    encryptionNotice: '',
    extensionLoadDir: null,
    apiKeyNeedsReentry: false,
    hermesFound: false,
    hermesNotice: '',
  };
}

vi.mock('../../src/renderer/src/api.js', () => {
  const specific = {
    getSettings: async () => state.view,
    listAuditEvents: async () => [],
    listAvailableModels: async () => {
      if (state.failWith !== null) throw new Error(state.failWith);
      if (state.hangNext) {
        state.hangNext = false;
        await new Promise<void>((resolve) => {
          state.hangRegistrar?.(resolve);
        });
      }
      return { models: state.upstream };
    },
    saveModelSettings: async (input: {
      modelName: string;
      chatModelName?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      savedModels?: string[];
    }) => {
      state.saved.push({
        modelName: input.modelName,
        chatModelName: input.chatModelName ?? '',
        apiBaseUrl: input.apiBaseUrl ?? '',
        apiKey: input.apiKey,
        savedModels: input.savedModels ?? [],
      });
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
  /**
   * 设置页其余卡片会各自调 api：没显式 mock 的方法一律给一个安静的空 Promise，
   * 别让未覆盖的卡片拖垮本测试（vi.mock 会提升，这些定义必须写在 factory 里）。
   */
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
  state.view = baseView([]);
  state.upstream = [];
  state.failWith = null;
  state.saved = [];
  state.hangNext = false;
  state.hangRelease = null;
  state.hangRegistrar = null;
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
}

const text = (): string => container.textContent ?? '';

async function clickFetch(): Promise<void> {
  await act(async () => {
    (
      container.querySelector('[data-testid="settings-fetch-models"]') as HTMLButtonElement
    )?.dispatchEvent(new MouseEvent('click', { bubbles: true } as MouseEventInit));
  });
}

async function clickSave(): Promise<void> {
  await act(async () => {
    (
      container.querySelector('[data-testid="settings-model-save"]') as HTMLButtonElement
    )?.dispatchEvent(new MouseEvent('click', { bubbles: true } as MouseEventInit));
  });
}

async function uncheckRow(id: string): Promise<void> {
  await act(async () => {
    (
      container.querySelector(
        `[data-testid="settings-model-check"][data-model-id="${id}"]`,
      ) as HTMLInputElement
    ).click();
  });
  expect(
    (
      container.querySelector(
        `[data-testid="settings-model-check"][data-model-id="${id}"]`,
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
}

async function checkRow(id: string): Promise<void> {
  await act(async () => {
    // 真实点击：jsdom 会像浏览器一样翻转 checked 并派发 click/change，
    // React 的受控 onChange 才接得到；直接写 checked 再派 change 是空测。
    (
      container.querySelector(
        `[data-testid="settings-model-check"][data-model-id="${id}"]`,
      ) as HTMLInputElement
    ).click();
  });
  // 勾选必须真的生效才继续（防「点了没反应」的空测）
  expect(
    (
      container.querySelector(
        `[data-testid="settings-model-check"][data-model-id="${id}"]`,
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
}

function selectValues(testId: string): string[] {
  return Array.from(
    container.querySelectorAll<HTMLOptionElement>(`[data-testid="${testId}"] option`),
  ).map((o) => o.value);
}

describe('M2 模型管理（设置页逻辑）', () => {
  it('契约 2：首次检测（无已保存模型）也显示筛选框，全部标「新」', async () => {
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-b' }];
    await render();
    await clickFetch();
    expect(container.querySelector('[data-testid="settings-model-filter"]')).not.toBeNull();
    expect(text()).toContain('gpt-a');
    expect(text()).toContain('新');
    // 都没保存过：默认不打勾
    const box = container.querySelector(
      '[data-testid="settings-model-check"][data-model-id="gpt-a"]',
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('契约 2：勾了还没保存的模型重检后消失 → 从勾选清掉、不进保存清单', async () => {
    state.view = baseView(['gpt-a']);
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-b' }];
    await render();
    await clickFetch();
    await checkRow('gpt-b'); // 勾上还没保存的（勾选确实生效：checkRow 断言）
    // 上游变了：gpt-b 消失
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-c' }];
    await clickFetch();
    expect(
      container.querySelector('[data-testid="settings-model-check"][data-model-id="gpt-b"]'),
    ).toBeNull();
    await clickSave();
    expect(state.saved[state.saved.length - 1]!.savedModels).toEqual(['gpt-a']);
  });

  it('契约 2：勾了还没保存、上游里仍有的模型，重检后勾选保留（不丢未保存的有效勾选）', async () => {
    state.view = baseView(['gpt-a']);
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-b' }];
    await render();
    await clickFetch();
    await checkRow('gpt-b'); // 勾上还没保存的
    // 重检：gpt-b 仍在上游 → 勾选必须保留；新多一个 gpt-c 标「新」
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-b' }, { id: 'gpt-c' }];
    await clickFetch();
    expect(
      (
        container.querySelector(
          '[data-testid="settings-model-check"][data-model-id="gpt-b"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await clickSave();
    // gpt-c 没勾过：保存只含已保存的 gpt-a + 保留下来的 gpt-b
    expect(state.saved[state.saved.length - 1]!.savedModels.sort()).toEqual(['gpt-a', 'gpt-b']);
  });

  it('竞态：检测期间保存了新配置（改 Key），迟到的旧清单不覆盖新界面', async () => {
    state.view = baseView(['gpt-a']);
    // 旧凭据下的上游多一个 stale-x：invalidation 失效的话它就会漏到新界面上
    state.upstream = [{ id: 'gpt-a' }, { id: 'stale-x' }];
    await render();
    state.hangNext = true;
    let released: (() => void) | null = null;
    state.hangRegistrar = (r) => {
      released = r;
    };
    // 第一笔检测发出去并挂起
    await clickFetch();
    // 在途期间用户保存（改 Key）——保存使在途检测作废
    await clickSave();
    expect(state.saved).toHaveLength(1);
    // 旧检测此刻才回来，带着旧凭据下的清单——必须被丢弃；界面只剩已保存行
    await act(async () => {
      released?.();
    });
    await act(async () => {});
    expect(
      container.querySelector('[data-testid="settings-model-check"][data-model-id="stale-x"]'),
    ).toBeNull();
    expect(container.querySelectorAll('[data-testid="settings-model-check"]').length).toBe(1);
  });

  it('契约 5：重检不撤销用户刚取消的勾选（只更新标记）', async () => {
    state.view = baseView(['gpt-a']);
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-b' }];
    await render();
    await clickFetch();
    // 用户把已保存的 gpt-a 取消勾选（准备移除，还没保存）
    await uncheckRow('gpt-a');
    // 同一上游重检：只更新标记，不允许把用户刚取消的 gpt-a 勾回来
    await clickFetch();
    expect(
      (
        container.querySelector(
          '[data-testid="settings-model-check"][data-model-id="gpt-a"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    await clickSave();
    expect(state.saved[state.saved.length - 1]!.savedModels).toEqual([]);
  });

  it('契约 1：已保存但上游已没有的照样显示并标「上游已没有」', async () => {
    state.view = baseView(['gpt-a', 'gemini-b']);
    state.upstream = [{ id: 'gpt-a' }];
    await render();
    await clickFetch();
    // gemini-b 上游没了：仍显示、仍默认勾上、带「上游已没有」标记
    expect(
      container.querySelector('[data-testid="settings-model-check"][data-model-id="gemini-b"]'),
    ).not.toBeNull();
    expect(text()).toContain('上游已没有');
    expect(
      (
        container.querySelector(
          '[data-testid="settings-model-check"][data-model-id="gemini-b"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('契约 3/4：下拉只从已保存清单选；在用的不在清单照样显示并标注', async () => {
    state.view = baseView(['gpt-a']);
    await render();
    // 模型名称：只有已保存的 gpt-a + 在用的 wizard-model（标注）
    expect(selectValues('settings-model-select')).toEqual(['wizard-model', 'gpt-a']);
    expect(
      container.querySelector('[data-testid="settings-model-select"] option[value="wizard-model"]')
        ?.textContent,
    ).toContain('不在已保存清单');
    // 聊天模型：第一项「跟随分析模型」+ 清单
    expect(selectValues('settings-chat-model')).toEqual(['', 'gpt-a']);
    expect(
      container.querySelector('[data-testid="settings-chat-model"] option[value=""]')?.textContent,
    ).toContain('跟随分析模型');
    // 没有手输模型名的入口（模型名称绝对是下拉框）
    expect(container.querySelector('[data-testid="settings-model-name"]')).toBeNull();
  });

  it('契约 7：检测失败如实显示错误，清单与勾选保持不变', async () => {
    state.view = baseView(['gpt-a']);
    state.upstream = [{ id: 'gpt-a' }, { id: 'gpt-b' }];
    await render();
    await clickFetch();
    await expect(
      (container.querySelector(
        '[data-testid="settings-model-check"][data-model-id="gpt-a"]',
      ) as HTMLInputElement) !== null,
    ).toBe(true);
    const counted = container.querySelectorAll('[data-testid="settings-model-check"]').length;
    state.failWith = 'upstream exploded';
    await clickFetch();
    expect(text()).toContain('upstream exploded');
    expect(container.querySelectorAll('[data-testid="settings-model-check"]').length).toBe(counted);
    expect(
      (
        container.querySelector(
          '[data-testid="settings-model-check"][data-model-id="gpt-a"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
});
