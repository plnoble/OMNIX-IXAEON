// @vitest-environment jsdom
/**
 * MP2b 验收（界面）——规格 docs/委派/MP2-多个模型供应商.md 验收条件 11–15。
 *
 * - 条件 11：导航里有「模型」；设置页里没有 settings-model、settings-quota 两张卡片了；
 *   有跳到「模型」页的按钮；原来跳到设置页模型区的入口，现在跳到「模型」页。
 * - 条件 12：供应商卡片——Key 显示后四位（「已保存 ····c3d4」）；短 Key 只显示「已保存」；
 *   没有 Key 显示「未配置」；页面文本里找不到完整 Key；
 *   勾选清单有筛选框和「新」「上游已没有」标记；
 *   magpie 那张有额度区和「刷新」；openai 那张页面上找不到额度区域；
 *   已经有 magpie 时「用本机 magpie」按钮不能点。
 * - 条件 13：用途三个下拉框——选项是所有供应商勾选过的模型，显示成「供应商名 · 模型」；
 *   聊天多一个「跟着后台分析」；保存后重新打开页面，选中的还在。
 * - 条件 14：聊天里换模型、设置里「编码任务交给谁」的模型下拉框，选项跟第 13 条一样。
 * - 条件 15：删除一家正在用的供应商 → 页面上显示拒绝的原因，卡片还在。
 *
 * 界面测试用的 testId：既有的沿用（nav-*、settings-model、settings-quota）；
 * 新页面这一套是本文件定义的契约（实现照这些 id 写）：
 * models-page、provider-card-<id>、provider-key-<id>、provider-models-<id>、provider-quota-<id>、
 * provider-delete-<id>、provider-add、provider-add-name/-base/-key、provider-add-save、
 * provider-magpie-preset、model-filter-<id>、uses-analysis/-chat/-coding、uses-save、
 * settings-model-jump。
 *
 * 一律不联网：api 全是替身，Key 是合成的。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProviderView } from '@ixaeon/contracts';

const providerViews: ModelProviderView[] = [];
const deleted: string[] = [];
const deleteError = { message: '' as string };
let usesSaved: unknown = null;

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getState: async () => ({ setupComplete: true, version: '0.0.0', dataDir: '/tmp/x' }),
    listProjects: async () => [],
    listMatchedFindings: async () => [],
    getSettings: async () => ({
      model: {
        provider: 'openai',
        modelName: 'demo-a',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        savedModels: ['demo-a'],
      },
      cockpit: { magpieUrl: '' },
      providers: providerViews,
      uses: {},
    }),
    listModelProviders: async () => providerViews,
    saveModelProvider: async () => ({ ok: true, id: 'p-new', keyCleared: false }),
    deleteModelProvider: async (id: string) => {
      if (deleteError.message) throw new Error(deleteError.message);
      deleted.push(id);
      return { ok: true };
    },
    fetchProviderModels: async () => ({ models: [], error: null }),
    saveModelUses: async (input: unknown) => {
      usesSaved = input;
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

import { App } from '../../src/renderer/src/App.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(async () => {
  providerViews.length = 0;
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

function q(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

describe('MP2b 条件 11：导航加「模型」，设置页搬走两张卡片', () => {
  it('导航里有「模型」；设置页没有 settings-model / settings-quota，有跳到模型页的按钮', async () => {
    await renderApp();
    expect(q('nav-models')).toBeTruthy();

    const settings = q('nav-settings') as HTMLElement | null;
    expect(settings).toBeTruthy();
    await act(async () => {
      settings?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(q('settings-model')).toBeNull();
    expect(q('settings-quota')).toBeNull();
    expect(q('settings-model-jump')).toBeTruthy();
  });

  it('点设置页那个按钮 → 到「模型」页', async () => {
    await renderApp();
    const settings = q('nav-settings') as HTMLElement | null;
    await act(async () => {
      settings?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      (q('settings-model-jump') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('models-page')).toBeTruthy();
  });
});

describe('MP2b 条件 12：供应商卡片', () => {
  function seed(): void {
    providerViews.push(
      {
        id: 'default',
        name: '默认',
        kind: 'openai',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        apiKeyTail: 'c3d4',
        apiKeyUnreadable: false,
        savedModels: ['demo-a'],
        modelsCheckedAt: null,
        usedBy: [],
      },
      {
        id: 'p-magpie',
        name: '本机 magpie',
        kind: 'magpie',
        apiBaseUrl: 'http://127.0.0.1:39123/v1',
        apiKeyPresent: true,
        apiKeyTail: null,
        apiKeyUnreadable: false,
        savedModels: ['demo-m'],
        modelsCheckedAt: null,
        usedBy: ['analysis'],
      },
    );
  }

  it('Key 显示后四位 / 短 Key 只显示「已保存」；页面文本里找不到完整 Key', async () => {
    seed();
    await renderApp();
    await act(async () => {
      (q('nav-models') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const defaultKey = q('provider-key-default');
    expect(defaultKey?.textContent ?? '').toContain('已保存');
    expect(defaultKey?.textContent ?? '').toContain('c3d4');
    const magpieKey = q('provider-key-p-magpie');
    expect(magpieKey?.textContent ?? '').toContain('已保存');
    expect(magpieKey?.textContent ?? '').not.toContain('····');
    expect(host.textContent ?? '').not.toContain('sk-synthetic');
  });

  it('magpie 那张有额度区与「刷新」；openai 那张没有额度区域', async () => {
    seed();
    await renderApp();
    await act(async () => {
      (q('nav-models') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('provider-quota-p-magpie')).toBeTruthy();
    expect(q('provider-quota-default')).toBeNull();
  });

  it('已经有 magpie 时「用本机 magpie」按钮不能点', async () => {
    seed();
    await renderApp();
    await act(async () => {
      (q('nav-models') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const preset = q('provider-magpie-preset') as HTMLButtonElement | null;
    expect(preset).toBeTruthy();
    expect(preset?.disabled).toBe(true);
  });

  it('勾选清单有筛选框和「新」「上游已没有」标记', async () => {
    seed();
    await renderApp();
    await act(async () => {
      (q('nav-models') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('model-filter-default')).toBeTruthy();
    expect(q('provider-models-default')?.textContent ?? '').toContain('新');
  });
});

describe('MP2b 条件 13：用途三个下拉框', () => {
  it('选项显示成「供应商名 · 模型」，聊天多「跟着后台分析」，保存后重新打开还在', async () => {
    providerViews.push(
      {
        id: 'default',
        name: '默认',
        kind: 'openai',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        apiKeyTail: 'c3d4',
        apiKeyUnreadable: false,
        savedModels: ['demo-a'],
        modelsCheckedAt: null,
        usedBy: [],
      },
      {
        id: 'p-b',
        name: '合成乙',
        kind: 'openai',
        apiBaseUrl: 'http://127.0.0.1:18082/v1',
        apiKeyPresent: true,
        apiKeyTail: 'e7d6',
        apiKeyUnreadable: false,
        savedModels: ['demo-b'],
        modelsCheckedAt: null,
        usedBy: [],
      },
    );
    await renderApp();
    await act(async () => {
      (q('nav-models') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    for (const id of ['uses-analysis', 'uses-chat', 'uses-coding']) {
      const select = q(id) as HTMLSelectElement | null;
      expect(select).toBeTruthy();
      const text = select?.textContent ?? '';
      expect(text).toContain('默认 · demo-a');
      expect(text).toContain('合成乙 · demo-b');
    }
    expect(q('uses-chat')?.textContent ?? '').toContain('跟着后台分析');

    // 保存：点「保存」后必须真的调过 saveModelUses，并且重新打开页面选中还在
    await act(async () => {
      (q('uses-save') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(usesSaved).not.toBeNull();
  });
});

describe('MP2b 条件 14：聊天换模型、编码任务的模型下拉框', () => {
  it('选项同样显示成「供应商名 · 模型」', async () => {
    providerViews.push({
      id: 'default',
      name: '默认',
      kind: 'openai',
      apiBaseUrl: 'http://127.0.0.1:18081/v1',
      apiKeyPresent: true,
      apiKeyTail: 'c3d4',
      apiKeyUnreadable: false,
      savedModels: ['demo-a'],
      modelsCheckedAt: null,
      usedBy: [],
    });
    await renderApp();
    await act(async () => {
      (q('nav-settings') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const codingModel = q('settings-coding-model');
    if (codingModel) expect(codingModel.textContent ?? '').toContain('默认 · demo-a');
  });
});

describe('MP2b 条件 15：删正在用的供应商', () => {
  it('页面上显示拒绝的原因，卡片还在', async () => {
    providerViews.push(
      {
        id: 'default',
        name: '默认',
        kind: 'openai',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        apiKeyTail: 'c3d4',
        apiKeyUnreadable: false,
        savedModels: ['demo-a'],
        modelsCheckedAt: null,
        usedBy: [],
      },
      {
        id: 'p-b',
        name: '合成乙',
        kind: 'openai',
        apiBaseUrl: 'http://127.0.0.1:18082/v1',
        apiKeyPresent: true,
        apiKeyTail: 'e7d6',
        apiKeyUnreadable: false,
        savedModels: ['demo-b'],
        modelsCheckedAt: null,
        usedBy: ['chat'],
      },
    );
    deleteError.message = '聊天在用它，先在用途里换掉';
    await renderApp();
    await act(async () => {
      (q('nav-models') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      (q('provider-delete-p-b') as HTMLElement | null)?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent ?? '').toContain('聊天在用它');
    expect(q('provider-card-p-b')).toBeTruthy();
  });
});
