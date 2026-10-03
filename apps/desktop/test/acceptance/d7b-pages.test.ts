// @vitest-environment jsdom
/**
 * D7b 验收（整合方写死，执行方不改）。规格：docs/委派/D7b-按设置选执行器.md
 * 条件 10（页面部分）、条件 11。后端与整条流程见 d7b-executor-selection.test.ts。
 *
 * 用 api 替身渲染设置页和任务页：
 * - 设置页「编码任务交给谁」一栏（契约 9）：两个选项；选「我的模型」才出现模型下拉框，
 *   选项只来自已保存清单；保存调用 api.saveCodingSettings({ executor, modelName })。
 * - 任务页（契约 8）：`model:<模型名>` 显示成「我的模型（<模型名>）」；选了「我的模型」时
 *   顶部写的是主进程给的说明，不再出现 Fake / 真机 Codex 那两句。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask, SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: {
  view: SettingsView;
  savedCoding: Array<{ executor: string; modelName: string }>;
  snap: { executor: string; realDispatchEnabled: boolean; notice: string; tasks: CodingTask[] };
} = {
  view: null as unknown as SettingsView,
  savedCoding: [],
  snap: { executor: 'fake', realDispatchEnabled: false, notice: '', tasks: [] },
};

function baseView(coding?: { codingExecutor: string; codingModelName: string }): SettingsView {
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
      ...(coding ?? {}),
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
    saveCodingSettings: async (input: { executor: string; modelName: string }) => {
      state.savedCoding.push({ executor: input.executor, modelName: input.modelName });
      return { ok: true as const };
    },
    listCodingTasks: async () => state.snap,
    listSkillCandidates: async () => [],
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
  // 两个页面其余的卡片各自会调 api：没显式给的一律回一个安静的空 Promise
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
import { TasksPage } from '../../src/renderer/src/pages/Tasks.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.view = baseView();
  state.savedCoding = [];
  state.snap = { executor: 'fake', realDispatchEnabled: false, notice: '', tasks: [] };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(page: 'settings' | 'tasks'): Promise<void> {
  await act(async () => {
    root.render(
      page === 'settings'
        ? createElement(SettingsPage)
        : createElement(TasksPage, { projects: [] }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const $ = <T extends Element>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

function options(testId: string): string[] {
  return Array.from(
    container.querySelectorAll<HTMLOptionElement>(`[data-testid="${testId}"] option`),
  ).map((o) => o.value);
}

async function choose(testId: string, value: string): Promise<void> {
  const el = $<HTMLSelectElement>(testId)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // 选择必须真的生效才继续（防「选了没反应」的空测）
  expect($<HTMLSelectElement>(testId)!.value).toBe(value);
}

async function clickSave(): Promise<void> {
  await act(async () => {
    $<HTMLButtonElement>('settings-coding-save')!.click();
  });
}

describe('条件 11：设置页「编码任务交给谁」', () => {
  it('默认是 Codex：两个选项，模型下拉框不出现', async () => {
    await render('settings');
    const card = $('settings-coding');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('编码任务交给谁');
    expect($<HTMLSelectElement>('settings-coding-executor')!.value).toBe('codex');
    expect(options('settings-coding-executor')).toEqual(['codex', 'model']);
    const labels = Array.from(
      container.querySelectorAll('[data-testid="settings-coding-executor"] option'),
    ).map((o) => o.textContent ?? '');
    expect(labels[0]).toContain('Codex');
    expect(labels[1]).toContain('我的模型');
    expect($('settings-coding-model')).toBeNull();
  });

  it('选「我的模型」：出现模型下拉框，选项只有「请选择」和已保存的；写明文件内容会发给它；保存', async () => {
    await render('settings');
    await choose('settings-coding-executor', 'model');
    expect($('settings-coding-model')).not.toBeNull();
    expect(options('settings-coding-model')).toEqual(['', 'm1', 'm2']);
    expect($('settings-coding')!.textContent).toMatch(/发给/);
    await choose('settings-coding-model', 'm2');
    await clickSave();
    expect(state.savedCoding).toEqual([{ executor: 'model', modelName: 'm2' }]);
  });

  it('已经选了「我的模型」和模型：打开设置页显示的就是它们', async () => {
    state.view = baseView({ codingExecutor: 'model', codingModelName: 'm1' });
    await render('settings');
    expect($<HTMLSelectElement>('settings-coding-executor')!.value).toBe('model');
    expect($<HTMLSelectElement>('settings-coding-model')!.value).toBe('m1');
  });

  it('选的模型已不在已保存清单里：下拉框停在「请选择」，不把它当成可选项；能改回 Codex', async () => {
    state.view = baseView({ codingExecutor: 'model', codingModelName: 'gone' });
    await render('settings');
    expect(options('settings-coding-model')).toEqual(['', 'm1', 'm2']);
    expect($<HTMLSelectElement>('settings-coding-model')!.value).toBe('');
    await choose('settings-coding-executor', 'codex');
    expect($('settings-coding-model')).toBeNull();
    await clickSave();
    expect(state.savedCoding).toHaveLength(1);
    expect(state.savedCoding[0]!.executor).toBe('codex');
    expect(state.savedCoding[0]!.modelName).not.toBe('gone');
  });
});

function task(id: string, executorName: string | null): CodingTask {
  return {
    id,
    goal: `合成任务 ${id}`,
    status: 'pending_accept',
    version: 1,
    executor_name: executorName,
  } as unknown as CodingTask;
}

describe('条件 10：任务页', () => {
  it('卡片：model:<模型名> 显示成「我的模型（<模型名>）」，Codex 与别的照旧', async () => {
    state.snap = {
      executor: 'model',
      realDispatchEnabled: true,
      notice: '合成说明',
      tasks: [task('a', 'model:gpt-x'), task('b', 'codex-cli'), task('c', 'fake')],
    };
    await render('tasks');
    const a = $('task-a')!.textContent ?? '';
    expect(a).toContain('我的模型（gpt-x）');
    expect(a).not.toContain('model:gpt-x');
    expect($('task-b')!.textContent).toContain('执行器 Codex');
    expect($('task-c')!.textContent).toContain('执行器 fake');
  });

  for (const realDispatchEnabled of [true, false]) {
    it(`顶部（选了「我的模型」，realDispatchEnabled=${realDispatchEnabled}）：写的是主进程给的说明，没有 Fake / 真机 Codex 那两句`, async () => {
      state.snap = {
        executor: 'model',
        realDispatchEnabled,
        notice: '合成说明：编码任务现在交给我的模型（gpt-x）',
        tasks: [],
      };
      await render('tasks');
      const top = $('tasks-notice')!.textContent ?? '';
      expect(top).toContain('合成说明：编码任务现在交给我的模型（gpt-x）');
      expect(top).not.toContain('Fake');
      expect(top).not.toContain('真机 Codex');
    });
  }

  it('顶部（默认）：Fake / 真机 Codex 的说明与现在一样', async () => {
    state.snap = { executor: 'fake', realDispatchEnabled: false, notice: '合成说明', tasks: [] };
    await render('tasks');
    expect($('tasks-notice')!.textContent).toContain('当前执行器：Fake');
    act(() => root.unmount());
    root = createRoot(container);
    state.snap = {
      executor: 'codex-cli',
      realDispatchEnabled: true,
      notice: '合成说明',
      tasks: [],
    };
    await render('tasks');
    expect($('tasks-notice')!.textContent).toContain('当前执行器：真机 Codex');
  });
});
