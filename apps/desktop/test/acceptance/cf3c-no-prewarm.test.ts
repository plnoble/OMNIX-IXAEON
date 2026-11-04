// @vitest-environment jsdom
/**
 * CF3c 验收（规格 docs/委派/CF3c-聊天只走直连.md）——条件 4：进聊天页不预热 Hermes。
 *
 * - IPC 上没有 `prewarmChat` 通道（主进程不再注册它）；
 * - 渲染「问答」页时，api 上的 `prewarmChat` 替身一次都没被调用。
 *
 * 合成数据、不联网。按现状实现应当失败（预热还在），这是 B 档先推测试的预期。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, unknown>());

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: unknown) => {
      handlers.set(channel, fn);
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => '',
    decryptString: () => '',
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const prewarmChat = vi.hoisted(() => vi.fn(async () => ({ warmed: true })));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getSettings: async () => ({
      config: {
        modelName: 'demo-a',
        chatModelName: '',
        apiBaseUrl: 'http://127.0.0.1:18081/v1',
        apiKeyPresent: true,
        savedModels: ['demo-a'],
        uses: {},
      },
      dataDir: '/tmp/x',
      cockpit: { magpieUrl: '' },
      providers: [],
    }),
    listConversations: async () => [],
    getConversation: async () => ({ conversation: null, messages: [] }),
    listTodos: async () => [],
    listModelProviders: async () => [],
    onAskDelta: () => () => undefined,
    onAskProgress: () => () => undefined,
    onTaskReport: () => () => undefined,
    prewarmChat,
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { registerIpc } from '../../src/main/ipc.js';
import { AskPage } from '../../src/renderer/src/pages/Ask.js';

describe('CF3c 条件 4：不预热 Hermes', () => {
  it('主进程不再注册 prewarmChat 通道', () => {
    const runtime = {
      db: {},
      state: { dataDir: '/tmp/x' },
      getConfig: () => ({ model: {}, capture: {}, webSearch: {}, coding: {}, extension: {} }),
      lastCaptureAt: () => null,
    } as unknown as Parameters<typeof registerIpc>[0];
    try {
      registerIpc(runtime);
    } catch {
      // 只关心注册了哪些通道；替身缺方法导致的异常不影响这条断言
    }
    // 整合方锁定时补：先确认通道真的注册上了，否则注册中途抛错也会让下面那条「没有 prewarm」成立
    expect(handlers.has('ixaeon:getSettings')).toBe(true);
    expect(handlers.has('ixaeon:rebuildSemanticIndex')).toBe(true);
    const channels = [...handlers.keys()].filter((c) => c.toLowerCase().includes('prewarm'));
    expect(channels).toEqual([]);
  });

  it('渲染「问答」页时没有调用 api.prewarmChat', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root | null = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(AskPage, {
          projects: [],
          openConversationId: null,
          onOpenTask: () => undefined,
          onOpenModelSettings: () => undefined,
        } as never),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(prewarmChat).not.toHaveBeenCalled();
    if (root) await act(async () => root?.unmount());
    root = null;
    host.remove();
  });
});

beforeEach(() => {
  handlers.clear();
  prewarmChat.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
