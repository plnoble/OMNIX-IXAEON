// @vitest-environment jsdom
/**
 * V4 验收（规格 docs/委派/V4-依赖档验证的授权入口.md，条件 10、11）：设置页那一块。
 *
 * 条件 10：打开时调了一次 `getVerifySandbox`；那一块排在「编码任务交给谁」后面；
 *   四种状态各显示契约 4 的那句话（逐字，带版本号）；只有 `unauthorized` 有「授权」按钮。
 * 条件 11：点「授权」——确认框文字逐字；取消不调 `authorizeVerifySandbox`；确认之后调了
 *   一次，等结果的时候按钮不可点、文字是「授权中……（等 Windows 的确认）」；结果是 `ok`
 *   → 状态换成「已授权」那句、显示「授权好了。」、按钮没了；结果是 `unauthorized`
 *   → 显示「没授权成」那句、按钮还在；出错显示在报错条里。
 *
 * 界面只通过 `api` 拿数据：这里的 `getVerifySandbox`、`authorizeVerifySandbox` 都是替身，
 * 不会真的发起授权。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView, VerifySandboxView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  view: null as unknown as SettingsView,
  sandbox: { status: 'ok', codexVersion: '9.9.9' } as VerifySandboxView,
  calls: [] as string[],
  reply: null as Promise<VerifySandboxView> | null,
  fail: null as string | null,
}));

vi.mock('../../src/renderer/src/api.js', () => {
  const specific = {
    getSettings: async () => state.view,
    listAuditEvents: async () => [],
    getVerifySandbox: async () => {
      state.calls.push('getVerifySandbox');
      return state.sandbox;
    },
    authorizeVerifySandbox: async () => {
      state.calls.push('authorizeVerifySandbox');
      if (state.fail) throw new Error(state.fail);
      return state.reply ? await state.reply : state.sandbox;
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

function view(): SettingsView {
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
      codingExecutor: 'codex',
      codingModelName: '',
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

const OK_TEXT =
  '已授权（Codex 9.9.9）。带 npm 依赖的项目，验收测试在 Codex 的沙箱里跑：不能联网，只能写任务副本。';
const UNAUTHORIZED_TEXT =
  '还没授权（Codex 9.9.9）。带 npm 依赖的项目，验收测试现在跑不了。授权一次就行；Codex 升级之后要再授权一次。';
const CODEX_MISSING_TEXT = '没找到 Codex 命令行，依赖档验证跑不了。';
const UNSUPPORTED_TEXT = '依赖档验证只在 Windows 上跑得了。';
const CONFIRM_TEXT = [
  '给 Codex 沙箱授权？',
  '',
  'Windows 会弹一次管理员确认。同意之后，Codex 会在这台机器上装好它的沙箱：两个专用的本机账户、一个 Windows 服务和几条防火墙规则（已经装过的不重装）。之后跑依赖档验证不用再问。',
  '',
  '只有点这个按钮才会弹；任务在后台跑的时候绝不弹。Codex 升级之后要再点一次。',
].join('\n');
const FAILED_TEXT =
  '没授权成：可能是 Windows 的确认被取消了，也可能是 Codex 的沙箱没装好。可以再点一次。';

let container: HTMLDivElement;
let root: Root;
const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  state.view = view();
  state.sandbox = { status: 'ok', codexVersion: '9.9.9' };
  state.calls.length = 0;
  state.reply = null;
  state.fail = null;
  confirm.mockReset().mockReturnValue(true);
  (window as unknown as { confirm: unknown }).confirm = confirm;
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
const statusText = () => $('settings-verify-sandbox-status')?.textContent ?? '';
const authorizeButton = () => $<HTMLButtonElement>('settings-verify-sandbox-authorize');

async function clickAuthorize(): Promise<void> {
  const btn = authorizeButton();
  if (!btn) throw new Error('设置页没有「授权」按钮（依赖档验证那一块还没接上）');
  await act(async () => {
    btn.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('条件 10：设置页那一块', () => {
  it('打开时查了一次；排在「编码任务交给谁」后面；已授权时的那句话逐字、没有按钮', async () => {
    await render();

    expect(state.calls).toEqual(['getVerifySandbox']);
    const card = $('settings-verify-sandbox');
    const coding = $('settings-coding');
    expect(card).not.toBeNull();
    expect(coding).not.toBeNull();
    expect(
      coding!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING,
      '「依赖档验证」该排在「编码任务交给谁」后面',
    ).toBeTruthy();
    expect(statusText()).toBe(OK_TEXT);
    expect(authorizeButton()).toBeNull();
  });

  it('没授权：那句话逐字，有「授权」按钮；点了会问一次', async () => {
    state.sandbox = { status: 'unauthorized', codexVersion: '9.9.9' };
    await render();

    expect(statusText()).toBe(UNAUTHORIZED_TEXT);
    expect(authorizeButton()?.textContent).toContain('授权');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('没找到 Codex：那句话逐字，没有按钮', async () => {
    state.sandbox = { status: 'codex_missing', codexVersion: null };
    await render();

    expect(statusText()).toBe(CODEX_MISSING_TEXT);
    expect(authorizeButton()).toBeNull();
  });

  it('不是 Windows：那句话逐字，没有按钮', async () => {
    state.sandbox = { status: 'unsupported_platform', codexVersion: null };
    await render();

    expect(statusText()).toBe(UNSUPPORTED_TEXT);
    expect(authorizeButton()).toBeNull();
  });
});

describe('条件 11：点「授权」', () => {
  beforeEach(() => {
    state.sandbox = { status: 'unauthorized', codexVersion: '9.9.9' };
  });

  it('确认框文字逐字', async () => {
    await render();
    await clickAuthorize();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toBe(CONFIRM_TEXT);
  });

  it('取消确认：不调 authorizeVerifySandbox，状态不变、按钮还在', async () => {
    confirm.mockReturnValue(false);
    await render();
    await clickAuthorize();

    expect(state.calls).toEqual(['getVerifySandbox']);
    expect(statusText()).toBe(UNAUTHORIZED_TEXT);
    expect(authorizeButton()).not.toBeNull();
    expect($('settings-verify-sandbox-message')).toBeNull();
  });

  it('确认：等结果时按钮不可点、文字是「授权中……（等 Windows 的确认）」', async () => {
    let release!: (v: VerifySandboxView) => void;
    state.reply = new Promise<VerifySandboxView>((r) => {
      release = r;
    });
    await render();
    await clickAuthorize();

    expect(state.calls).toEqual(['getVerifySandbox', 'authorizeVerifySandbox']);
    const btn = authorizeButton();
    expect(btn?.disabled).toBe(true);
    expect(btn?.textContent).toContain('授权中……（等 Windows 的确认）');

    await act(async () => {
      release({ status: 'ok', codexVersion: '9.9.9' });
    });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('结果 ok：状态换成「已授权」那句、显示「授权好了。」、按钮没了', async () => {
    state.reply = Promise.resolve({ status: 'ok', codexVersion: '9.9.9' });
    await render();
    await clickAuthorize();

    expect(state.calls).toEqual(['getVerifySandbox', 'authorizeVerifySandbox']);
    expect(statusText()).toBe(OK_TEXT);
    expect($('settings-verify-sandbox-message')?.textContent).toContain('授权好了。');
    expect(authorizeButton()).toBeNull();
  });

  it('结果还是没授权：显示「没授权成」那句、按钮还在', async () => {
    state.reply = Promise.resolve({ status: 'unauthorized', codexVersion: '9.9.9' });
    await render();
    await clickAuthorize();

    expect($('settings-verify-sandbox-message')?.textContent).toContain(FAILED_TEXT);
    expect(statusText()).toBe(UNAUTHORIZED_TEXT);
    expect(authorizeButton()).not.toBeNull();
    expect(authorizeButton()?.disabled).toBe(false);
  });

  it('出错：显示在报错条里，按钮还能再点', async () => {
    state.fail = '合成的授权失败';
    await render();
    await clickAuthorize();

    expect($('error-banner')?.textContent).toContain('合成的授权失败');
    expect(authorizeButton()).not.toBeNull();
    expect(authorizeButton()?.disabled).toBe(false);
  });
});
