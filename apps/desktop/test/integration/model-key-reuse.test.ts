/**
 * 获取模型列表时复用已保存的 API Key（用户 2026-09-17 反馈：每次换模型都要重填 Key，
 * 同时要求注重隐私）。
 *
 * 断言的核心是「哪个 Key 被发往了哪个地址」：
 * - 输入框留空且地址没变 → 用已保存的 Key；
 * - 地址变了 → 拒绝，且已保存的 Key 一个字节都不发出去；
 * - 输入框有 Key → 用输入的，不碰已保存的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {},
  BrowserWindow: class {},
  // 测试替身：「加密」= 加前缀，「解密」= 去前缀
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

import { AppRuntime, normalizeApiBase } from '../../src/main/appRuntime.js';

const SAVED_KEY = 'sk-saved-0123456789abcdef';
const SAVED_ENCRYPTED = Buffer.from(`enc:${SAVED_KEY}`).toString('base64');

interface KeyRuntime {
  listAvailableModels(input: {
    apiBaseUrl: string;
    apiKey: string;
  }): Promise<{ models: Array<{ id: string }> }>;
}

function runtimeWith(model: Record<string, unknown>): KeyRuntime {
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['config'] = { model };
  return rt as unknown as KeyRuntime;
}

const saved = {
  modelName: 'old-model',
  apiBaseUrl: 'https://api.example.com/v1',
  apiKeyPresent: true,
  apiKeyEncrypted: SAVED_ENCRYPTED,
};

let calls: Array<{ url: string; authorization: string }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, authorization: init?.headers?.['authorization'] ?? '' });
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('获取模型列表：复用已保存的 Key', () => {
  it('输入框留空且地址没变：用已保存的 Key', async () => {
    const result = await runtimeWith(saved).listAvailableModels({
      apiBaseUrl: 'https://api.example.com/v1',
      apiKey: '',
    });
    expect(result.models.map((m) => m.id)).toEqual(['model-a', 'model-b']);
    expect(calls).toEqual([
      { url: 'https://api.example.com/v1/models', authorization: `Bearer ${SAVED_KEY}` },
    ]);
  });

  it('地址只是大小写或末尾斜杠不同：视为同一地址', async () => {
    await runtimeWith(saved).listAvailableModels({
      apiBaseUrl: '  HTTPS://API.Example.com/v1/  ',
      apiKey: '   ',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe(`Bearer ${SAVED_KEY}`);
  });

  it('地址变了：拒绝，已保存的 Key 不发往新地址', async () => {
    await expect(
      runtimeWith(saved).listAvailableModels({
        apiBaseUrl: 'https://other-provider.example.net/v1',
        apiKey: '',
      }),
    ).rejects.toThrow(/API 地址和已保存的不一样/);
    expect(calls).toEqual([]);
  });

  it('路径不同也算不同地址（同一主机上的另一个服务）', async () => {
    await expect(
      runtimeWith(saved).listAvailableModels({
        apiBaseUrl: 'https://api.example.com/other/v1',
        apiKey: '',
      }),
    ).rejects.toThrow(/API 地址和已保存的不一样/);
    expect(calls).toEqual([]);
  });

  it('从没保存过 Key：提示填写，不发请求', async () => {
    await expect(
      runtimeWith({ ...saved, apiKeyPresent: false, apiKeyEncrypted: null }).listAvailableModels({
        apiBaseUrl: 'https://api.example.com/v1',
        apiKey: '',
      }),
    ).rejects.toThrow(/还没有保存过 API Key/);
    expect(calls).toEqual([]);
  });

  it('已保存的 Key 解密不了（例如旧明文格式）：提示重填，不发请求', async () => {
    await expect(
      runtimeWith({ ...saved, apiKeyEncrypted: 'plain:c2stb2xk' }).listAvailableModels({
        apiBaseUrl: 'https://api.example.com/v1',
        apiKey: '',
      }),
    ).rejects.toThrow(/无法解密/);
    expect(calls).toEqual([]);
  });

  it('输入框填了 Key：用输入的，即使地址变了', async () => {
    await runtimeWith(saved).listAvailableModels({
      apiBaseUrl: 'https://other-provider.example.net/v1',
      apiKey: 'sk-typed-9876543210',
    });
    expect(calls).toEqual([
      {
        url: 'https://other-provider.example.net/v1/models',
        authorization: 'Bearer sk-typed-9876543210',
      },
    ]);
  });
});

describe('normalizeApiBase', () => {
  it('协议与主机不分大小写、忽略末尾斜杠、保留路径大小写', () => {
    expect(normalizeApiBase('HTTPS://API.Example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeApiBase('https://api.example.com/V1')).toBe('https://api.example.com/V1');
    expect(normalizeApiBase('http://203.0.113.10:3001/v1')).toBe('http://203.0.113.10:3001/v1');
  });

  it('空值表示官方默认', () => {
    expect(normalizeApiBase('')).toBe('');
    expect(normalizeApiBase('   ')).toBe('');
    expect(normalizeApiBase(null)).toBe('');
    expect(normalizeApiBase(undefined)).toBe('');
  });
});

/**
 * 2026-09-18 用户反馈：改聊天模型要去 Hermes 的 config.yaml，太麻烦。
 * 设置页新增「聊天模型」，留空跟随分析用的模型；模型是网关启动参数，
 * 改了必须丢掉在跑的引擎会话，否则下一问还在旧进程里、设置等于没生效。
 */
describe('聊天模型设置', () => {
  interface ChatRuntime {
    chatModelName(): string | null;
    resetChatSessions(): number;
  }
  function runtimeForChat(
    model: Record<string, unknown>,
    sessions?: Map<string, { invalidateContext: () => void }>,
    cleared?: { done: boolean },
  ): ChatRuntime {
    const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
    rt['config'] = { model };
    rt['askSessions'] = sessions ?? new Map();
    rt['conversations'] = {
      clearEngineSessions: () => {
        if (cleared) cleared.done = true;
      },
    };
    return rt as unknown as ChatRuntime;
  }

  it('聊天模型优先，留空则跟随分析用的模型，都空则不干预 Hermes', () => {
    expect(runtimeForChat({ modelName: 'grok-4.6', chatModelName: 'opus-5' }).chatModelName()).toBe(
      'opus-5',
    );
    expect(runtimeForChat({ modelName: 'grok-4.6', chatModelName: '  ' }).chatModelName()).toBe(
      'grok-4.6',
    );
    expect(runtimeForChat({ modelName: '', chatModelName: '' }).chatModelName()).toBeNull();
  });

  it('换模型后丢掉在跑的引擎会话：长驻网关退出，落库的引擎会话号清空', () => {
    let invalidated = 0;
    const sessions = new Map([
      ['c1', { invalidateContext: () => invalidated++ }],
      ['c2', { invalidateContext: () => invalidated++ }],
    ]);
    const cleared = { done: false };
    const rt = runtimeForChat({ modelName: 'a', chatModelName: 'b' }, sessions, cleared);
    expect(rt.resetChatSessions()).toBe(2);
    expect(invalidated).toBe(2);
    expect(sessions.size).toBe(0);
    expect(cleared.done).toBe(true);
  });
});
