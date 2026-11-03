// @vitest-environment jsdom
/**
 * MP2b 验收（界面）——规格 docs/委派/MP2-多个模型供应商.md 验收条件 11–15。
 *
 * - 条件 11：导航里有「模型」；设置页里没有 settings-model、settings-quota；
 *   有跳到「模型」页的按钮（点了到 models-page）；
 *   聊天里那个「去设置「模型接入」添加」入口仍然存在、点了会触发回调（落点由实现改成「模型」页）。
 * - 条件 12：卡片——Key 后四位「已保存 ····c3d4」；短 Key 只显示「已保存」；
 *   **没有 Key 显示「未配置」**；页面文本里找不到完整 Key；
 *   勾选清单：获取后新出现的行标「新」、上游已没有的行标「上游已没有」；**筛选框真的能筛**；
 *   magpie 那张有额度区；openai 那张没有；已有 magpie 时「用本机 magpie」不能点。
 * - 条件 13：用途三个下拉框显示「供应商名 · 模型」、聊天多「跟着后台分析」；
 *   聊天选成「合成乙 · demo-b」保存 → saveModelUses 收到 { providerId: 'p-b', model: 'demo-b' }；
 *   重新渲染后选中的还是它。
 * - 条件 14：设置页「编码任务交给谁」的模型下拉框、聊天里换模型的下拉框，选项也显示成「供应商名 · 模型」。
 * - 条件 15：删正在用的供应商 → 页面显示拒绝原因，卡片还在。
 *
 * 界面 testId：既有的沿用（nav-*、settings-model、settings-quota、model-retry-select）；
 * 新页面这一套是本文件定义的契约：models-page、provider-card-<id>、provider-key-<id>、
 * provider-models-<id>、model-row-<id>、model-filter-<id>、provider-quota-<id>、
 * provider-delete-<id>、provider-magpie-preset、uses-analysis/-chat/-coding、uses-save、
 * settings-model-jump、settings-coding-model。
 *
 * 不联网：api 全是替身，Key 是合成的。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ModelProviderView } from '@ixaeon/contracts';

let providerViews: ModelProviderView[] = [];
let uses: Record<string, unknown> = {};
let savedModelsState: string[] = [];
let upstream: string[] = [];
const deleted: string[] = [];
const deleteError = { message: '' as string };
let usesSaved: { chat?: { providerId: string; model: string } } | null = null;

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getState: async () => ({ setupComplete: true, version: '0.0.0', dataDir: '/tmp/x' }),
    listProjects: async () => [],
    listMatchedFindings: async () => [],
    getSettings: async () => ({
      config: {
        modelName: 'demo-a',
        chatModelName: '',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        savedModels: savedModelsState,
        uses,
      },
      cockpit: { magpieUrl: '' },
      providers: providerViews,
    }),
    listModelProviders: async () => providerViews,
    saveModelProvider: async () => ({ ok: true, id: 'p-new', keyCleared: false }),
    deleteModelProvider: async (id: string) => {
      if (deleteError.message) throw new Error(deleteError.message);
      deleted.push(id);
      return { ok: true };
    },
    fetchProviderModels: async () => ({ models: upstream, error: null }),
    saveModelUses: async (input: unknown) => {
      usesSaved = input as { chat?: { providerId: string; model: string } };
      return { ok: true };
    },
    listAvailableModels: async () => ({ models: [], error: null }),
    saveModelSettings: async () => ({ ok: true }),
    saveCodingSettings: async () => ({ ok: true }),
    getCockpit: async () => ({ quota: null }),
    refreshQuota: async () => ({ ok: true }),
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import App from '../../src/renderer/src/App.js';
import { AskMessage } from '../../src/renderer/src/pages/AskMessage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  providerViews = [];
  uses = {};
  savedModelsState = [];
  upstream = [];
  deleted.length = 0;
  deleteError.message = '';
  usesSaved = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host.remove();
});

async function renderApp(): Promise<void> {
  await act(async () => {
    root?.render(createElement(App));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function q(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function view(partial: Partial<ModelProviderView> & { id: string }): ModelProviderView {
  return {
    name: partial.id,
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKeyPresent: true,
    apiKeyTail: 'c3d4',
    apiKeyUnreadable: false,
    savedModels: [],
    modelsCheckedAt: null,
    usedBy: [],
    ...partial,
  };
}

async function openModelsPage(): Promise<void> {
  await renderApp();
  await act(async () => {
    (q('nav-models') as HTMLElement | null)?.click();
  });
  await flush();
}

describe('MP2b 条件 11：导航加「模型」，设置页搬走两张卡片', () => {
  it('导航里有「模型」；设置页没有 settings-model / settings-quota，有跳到模型页的按钮', async () => {
    await renderApp();
    expect(q('nav-models')).toBeTruthy();

    await act(async () => {
      (q('nav-settings') as HTMLElement | null)?.click();
    });
    await flush();

    expect(q('settings-model')).toBeNull();
    expect(q('settings-quota')).toBeNull();
    expect(q('settings-model-jump')).toBeTruthy();
  });

  it('点设置页那个按钮 → 到「模型」页', async () => {
    await renderApp();
    await act(async () => {
      (q('nav-settings') as HTMLElement | null)?.click();
    });
    await flush();
    await act(async () => {
      (q('settings-model-jump') as HTMLElement | null)?.click();
    });
    await flush();
    expect(q('models-page')).toBeTruthy();
  });

  it('聊天里「去设置「模型接入」添加」入口还在，点了会触发打开模型的回调', async () => {
    const onOpenModelSettings = vi.fn();
    const message = {
      id: 'm1',
      seq: 2,
      role: 'assistant',
      citations: [],
      content: '',
      status: 'failed',
      modelName: 'demo-a',
      // 组件内部用它认出「模型不可用」，没有它就不出换模型那一段
      errorMessage: 'No available channel for model demo-a',
      meta: {},
      createdAt: new Date().toISOString(),
    } as unknown as ConversationMessage;

    await act(async () => {
      root?.render(
        createElement(AskMessage, {
          message,
          savedModels: [],
          chatModelName: '',
          onOpenModelSettings,
        } as unknown as Parameters<typeof AskMessage>[0]),
      );
    });
    await flush();

    const button = q('model-unavailable-settings');
    expect(button, '没有这个入口按钮').toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(onOpenModelSettings).toHaveBeenCalled();
  });
});

describe('MP2b 条件 12：供应商卡片', () => {
  it('Key 后四位 / 短 Key / 未配置；页面文本里找不到完整 Key', async () => {
    providerViews = [
      view({ id: 'default', name: '默认', apiKeyTail: 'c3d4' }),
      view({ id: 'p-short', name: '合成短 Key', kind: 'magpie', apiKeyTail: null }),
      view({ id: 'p-none', name: '合成没配', apiKeyPresent: false, apiKeyTail: null }),
    ];
    await openModelsPage();

    expect(q('provider-key-default')?.textContent ?? '').toContain('c3d4');
    expect(q('provider-key-p-short')?.textContent ?? '').toContain('已保存');
    expect(q('provider-key-p-short')?.textContent ?? '').not.toContain('····');
    expect(q('provider-key-p-none')?.textContent ?? '').toContain('未配置');
    expect(host.textContent ?? '').not.toContain('sk-synthetic');
  });

  it('获取模型后：新出现的标「新」、上游已没有的标「上游已没有」；筛选框真的能筛', async () => {
    providerViews = [view({ id: 'default', name: '默认', savedModels: ['demo-a', 'demo-gone'] })];
    savedModelsState = ['demo-a', 'demo-gone'];
    upstream = ['demo-a', 'demo-new'];
    await openModelsPage();

    await act(async () => {
      (q('provider-models-default') as HTMLElement | null)?.click();
    });
    await flush();

    expect(q('model-row-demo-new')?.textContent ?? '').toContain('新');
    expect(q('model-row-demo-gone')?.textContent ?? '').toContain('上游已没有');

    // 筛选：输入 new 之后，demo-a 那一行看不到
    const filter = q('model-filter-default') as HTMLInputElement | null;
    expect(filter).toBeTruthy();
    await act(async () => {
      if (filter) {
        filter.value = 'new';
        filter.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await flush();
    expect(q('model-row-demo-a')).toBeNull();
    expect(q('model-row-demo-new')).toBeTruthy();
  });

  it('magpie 那张有额度区；openai 那张没有；已有 magpie 时预设按钮不能点', async () => {
    providerViews = [
      view({ id: 'default', name: '默认' }),
      view({ id: 'p-magpie', name: '本机 magpie', kind: 'magpie', savedModels: ['demo-m'] }),
    ];
    await openModelsPage();

    expect(q('provider-quota-p-magpie')).toBeTruthy();
    expect(q('provider-quota-default')).toBeNull();
    const preset = q('provider-magpie-preset') as HTMLButtonElement | null;
    expect(preset).toBeTruthy();
    expect(preset?.disabled).toBe(true);
  });
});

describe('MP2b 条件 13：用途三个下拉框', () => {
  it('选项是「供应商名 · 模型」，聊天多「跟着后台分析」；保存后重新打开还在', async () => {
    providerViews = [
      view({ id: 'default', name: '默认', savedModels: ['demo-a'] }),
      view({ id: 'p-b', name: '合成乙', savedModels: ['demo-b'] }),
    ];
    await openModelsPage();

    for (const id of ['uses-analysis', 'uses-chat', 'uses-coding']) {
      const select = q(id) as HTMLSelectElement | null;
      expect(select, `没有 ${id}`).toBeTruthy();
      const text = select?.textContent ?? '';
      expect(text).toContain('默认 · demo-a');
      expect(text).toContain('合成乙 · demo-b');
    }
    expect(q('uses-chat')?.textContent ?? '').toContain('跟着后台分析');

    // 聊天选成「合成乙 · demo-b」并保存
    const chatSelect = q('uses-chat') as HTMLSelectElement | null;
    const option = [...(chatSelect?.options ?? [])].find((o) =>
      (o.textContent ?? '').includes('合成乙 · demo-b'),
    );
    expect(option, '聊天下拉里没有「合成乙 · demo-b」').toBeTruthy();
    await act(async () => {
      if (chatSelect && option) {
        chatSelect.value = option.value;
        chatSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await flush();
    await act(async () => {
      (q('uses-save') as HTMLElement | null)?.click();
    });
    await flush();

    expect(usesSaved?.chat).toEqual({ providerId: 'p-b', model: 'demo-b' });

    // 重新渲染（getSettings 按规格返回 config.uses），选中的还是它
    uses = { chat: { providerId: 'p-b', model: 'demo-b' } };
    await act(async () => root?.unmount());
    root = createRoot(host);
    await openModelsPage();
    const after = q('uses-chat') as HTMLSelectElement | null;
    const selectedText = after?.selectedOptions[0]?.textContent ?? '';
    expect(selectedText).toContain('合成乙 · demo-b');
  });
});

describe('MP2b 条件 14：编码任务的模型下拉框、聊天里换模型', () => {
  it('设置页「编码任务交给谁」的模型下拉框，选项是「供应商名 · 模型」', async () => {
    providerViews = [view({ id: 'default', name: '默认', savedModels: ['demo-a'] })];
    savedModelsState = ['demo-a'];
    await renderApp();
    await act(async () => {
      (q('nav-settings') as HTMLElement | null)?.click();
    });
    await flush();

    const codingModel = q('settings-coding-model') as HTMLSelectElement | null;
    expect(codingModel, '设置页没有编码模型的模型下拉框').toBeTruthy();
    expect(codingModel?.textContent ?? '').toContain('默认 · demo-a');
  });

  it('聊天里换模型的下拉框，选项是「供应商名 · 模型」', async () => {
    const message = {
      id: 'm1',
      seq: 2,
      role: 'assistant',
      citations: [],
      content: '',
      status: 'failed',
      modelName: 'demo-a',
      // 组件内部用它认出「模型不可用」，没有它就不出换模型那一段
      errorMessage: 'No available channel for model demo-a',
      meta: {},
      createdAt: new Date().toISOString(),
    } as unknown as ConversationMessage;

    await act(async () => {
      root?.render(
        createElement(AskMessage, {
          message,
          savedModels: ['demo-a', 'demo-b'],
          chatModelName: '',
        } as unknown as Parameters<typeof AskMessage>[0]),
      );
    });
    await flush();

    const select = q('model-retry-select') as HTMLSelectElement | null;
    expect(select, '没有换模型的下拉框').toBeTruthy();
    // 失败的那个（demo-a）被过滤掉，剩下的是别的已保存模型；选项要带「供应商名 · 」前缀
    const options = [...(select?.options ?? [])].map((o) => (o.textContent ?? '').trim());
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toMatch(/·\s*demo-b$/);
    expect(options[0]).not.toBe('demo-b');
  });
});

describe('MP2b 条件 15：删正在用的供应商', () => {
  it('页面上显示拒绝的原因，卡片还在', async () => {
    providerViews = [
      view({ id: 'default', name: '默认' }),
      view({ id: 'p-b', name: '合成乙', savedModels: ['demo-b'], usedBy: ['chat'] }),
    ];
    deleteError.message = '聊天在用它，先在用途里换掉';
    await openModelsPage();

    await act(async () => {
      (q('provider-delete-p-b') as HTMLElement | null)?.click();
    });
    await flush();

    expect(host.textContent ?? '').toContain('聊天在用它');
    expect(q('provider-card-p-b')).toBeTruthy();
  });
});
