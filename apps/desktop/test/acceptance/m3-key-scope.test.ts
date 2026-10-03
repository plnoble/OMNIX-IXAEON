/**
 * M3 验收（后端，规格 docs/委派/M3-换了地址旧Key不带过去.md）。
 * 执行方先推了一版，整合方 2026-10-03 锁定前改正补全（规格末尾「整合方审测试时的改正与补充」）。
 * 界面提示见同目录 m3-settings-ui.test.ts。
 *
 * 钉住的接缝：`AppRuntime.saveModelSettings` 返回 `{ ok: true, keyCleared: boolean }`——
 * 这次保存因为地址换了来源、又没填新 Key，把已保存的 Key 清掉了，才是 true。
 *
 * 与验收条件的对应：
 * - 条件 1：换了来源（主机、协议、端口、子域、官方默认与别家互换、解析不了的地址）、Key 留空
 *   → Key 被清掉；之后分析用的模型客户端拿不到，Key 留空去检测也发不出任何请求。
 * - 条件 2：换了来源、同时填了新 Key → 保存的是新 Key；之后发出去的只有新 Key。
 * - 条件 3、4：只改路径、没传地址、地址没变 → Key 保持原值（密文一个字不变）。
 * - 条件 5：主机名大小写、结尾斜杠、默认端口、前后空格、空地址与官方默认地址 → 都算没变。
 * - 补充：本来就没有 Key 的不谎报「清掉了」；清 Key 不动别的配置。
 *
 * 原版「大小写 / 尾斜杠 / 默认端口」那条把已保存的地址和新地址设成同一个字符串，
 * 等于没测规范化（两边一字不差，不规范化也相等），这里改成真的不同写法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { defaultAppConfig } from '@ixaeon/contracts';
import type { ModelProvider } from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

const OLD_KEY = 'sk-old-synthetic';
const NEW_KEY = 'sk-new-synthetic';
const enc = (key: string) => Buffer.from(`enc:${key}`).toString('base64');
const A = 'https://a.example.com/v1';
const B = 'https://b.example.com/v1';

interface Runtime {
  saveModelSettings(input: {
    modelName: string;
    chatModelName?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    savedModels?: string[];
  }): { ok: true; keyCleared: boolean };
  listAvailableModels(input: {
    apiBaseUrl: string;
    apiKey: string;
  }): Promise<{ models: Array<{ id: string }> }>;
  getProvider(): ModelProvider | null;
}

let dir: string;
let configFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['IXAEON_FAKE_MODEL', 'IXAEON_OPENAI_BASE_URL']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m3-'));
  configFile = join(dir, 'config.json');
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(model: Record<string, unknown> = {}): Runtime {
  const base = defaultAppConfig();
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['config'] = {
    ...base,
    setupComplete: true,
    model: {
      ...base.model,
      modelName: 'm',
      chatModelName: 'chat-m',
      apiBaseUrl: A,
      apiKeyPresent: true,
      apiKeyEncrypted: enc(OLD_KEY),
      savedModels: ['m', 'chat-m'],
      ...model,
    },
    webSearch: {
      provider: 'brave',
      apiKeyEncrypted: enc('search-key-synthetic'),
      apiKeyPresent: true,
    },
  };
  rt['configFile'] = configFile;
  rt['askSessions'] = new Map();
  rt['conversations'] = { clearEngineSessions: () => undefined };
  rt['logger'] = { warn: () => undefined, info: () => undefined };
  return rt as unknown as Runtime;
}

const onDisk = () =>
  JSON.parse(readFileSync(configFile, 'utf8')) as {
    model: Record<string, unknown>;
    webSearch: Record<string, unknown>;
  };

/** 记下发出去的每个请求：地址和 Authorization。 */
function recordFetch(): Array<{ url: string; auth: string | null }> {
  const calls: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

describe('条件 1：换了来源、Key 留空——旧 Key 清掉，不带到新地址', () => {
  const cases: Array<[string, string, string]> = [
    ['主机不同', A, B],
    ['协议不同', A, 'http://a.example.com/v1'],
    ['端口不同', A, 'https://a.example.com:9090/v1'],
    ['子域不同', A, 'https://api.a.example.com/v1'],
    ['官方默认（空地址）换成别家', '', B],
    ['别家换成官方默认（空地址）', B, ''],
    ['新地址解析不了：字面不同就算换了', A, 'not a url'],
  ];
  for (const [label, saved, next] of cases) {
    it(`${label}：Key 被清掉；模型客户端拿不到，Key 留空去检测也发不出请求`, async () => {
      const rt = runtimeWith({ apiBaseUrl: saved });
      const out = rt.saveModelSettings({ modelName: 'm', apiBaseUrl: next });
      expect(out).toEqual({ ok: true, keyCleared: true });
      const m = onDisk().model;
      expect(m['apiKeyEncrypted']).toBeNull();
      expect(m['apiKeyPresent']).toBe(false);
      expect(m['apiBaseUrl']).toBe(next);
      // 后台分析、兜底问答用的客户端：没有 Key 就建不出来
      expect(rt.getProvider()).toBeNull();
      // Key 留空去检测：不发任何请求
      const calls = recordFetch();
      await expect(rt.listAvailableModels({ apiBaseUrl: next, apiKey: '' })).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  }

  it('清 Key 不动别的：模型名、聊天模型、已保存清单、搜索用的 Key 都还在', () => {
    const rt = runtimeWith();
    rt.saveModelSettings({ modelName: 'm', apiBaseUrl: B });
    const disk = onDisk();
    expect(disk.model['modelName']).toBe('m');
    expect(disk.model['chatModelName']).toBe('chat-m');
    expect(disk.model['savedModels']).toEqual(['m', 'chat-m']);
    expect(disk.webSearch['apiKeyEncrypted']).toBe(enc('search-key-synthetic'));
    expect(disk.webSearch['apiKeyPresent']).toBe(true);
  });

  it('本来就没有 Key：换来源不谎报「清掉了」', () => {
    const rt = runtimeWith({ apiKeyPresent: false, apiKeyEncrypted: null });
    expect(rt.saveModelSettings({ modelName: 'm', apiBaseUrl: B })).toEqual({
      ok: true,
      keyCleared: false,
    });
    expect(onDisk().model['apiKeyPresent']).toBe(false);
  });
});

describe('条件 2：换了来源、同时填了新 Key', () => {
  it('保存的是新 Key；之后 Key 留空去检测，发到新地址的只有新 Key', async () => {
    const rt = runtimeWith();
    expect(rt.saveModelSettings({ modelName: 'm', apiBaseUrl: B, apiKey: NEW_KEY })).toEqual({
      ok: true,
      keyCleared: false,
    });
    const m = onDisk().model;
    expect(m['apiKeyEncrypted']).toBe(enc(NEW_KEY));
    expect(m['apiKeyPresent']).toBe(true);
    const calls = recordFetch();
    await rt.listAvailableModels({ apiBaseUrl: B, apiKey: '' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith(`${B}/`)).toBe(true);
      expect(c.auth).toBe(`Bearer ${NEW_KEY}`);
    }
  });

  it('清掉之后在新地址补填 Key：照常保存', () => {
    const rt = runtimeWith();
    expect(rt.saveModelSettings({ modelName: 'm', apiBaseUrl: B }).keyCleared).toBe(true);
    expect(rt.saveModelSettings({ modelName: 'm', apiBaseUrl: B, apiKey: NEW_KEY })).toEqual({
      ok: true,
      keyCleared: false,
    });
    expect(onDisk().model['apiKeyEncrypted']).toBe(enc(NEW_KEY));
    expect(rt.getProvider()).not.toBeNull();
  });
});

describe('条件 3、4、5：来源没变——Key 保持原值', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['只改路径', A, 'https://a.example.com/v2'],
    ['没传地址', A, undefined],
    ['地址一字不差', A, A],
    ['主机名、协议大小写不同', A, 'HTTPS://A.Example.COM/v1'],
    ['结尾多一个斜杠', A, 'https://a.example.com/v1/'],
    ['写了默认端口 443', A, 'https://a.example.com:443/v1'],
    ['http 写了默认端口 80', 'http://a.example.com/v1', 'http://a.example.com:80/v1'],
    ['前后有空格', A, `  ${A}  `],
    ['空地址换成官方默认地址写全', '', 'https://api.openai.com/v1'],
    ['官方默认地址写全换成空地址', 'https://api.openai.com/v1', ''],
    ['空地址换成只有空格', '', '   '],
  ];
  for (const [label, saved, next] of cases) {
    it(`${label}：Key 的密文一个字不变`, () => {
      const rt = runtimeWith({ apiBaseUrl: saved });
      const out = rt.saveModelSettings({
        modelName: 'm',
        ...(next !== undefined ? { apiBaseUrl: next } : {}),
      });
      expect(out).toEqual({ ok: true, keyCleared: false });
      const m = onDisk().model;
      expect(m['apiKeyEncrypted']).toBe(enc(OLD_KEY));
      expect(m['apiKeyPresent']).toBe(true);
      expect(m['apiBaseUrl']).toBe(next !== undefined ? next.trim() : saved);
    });
  }

  it('只改路径之后 Key 留空去检测：照现有规则复用已保存的 Key，发到的还是同一个来源', async () => {
    const rt = runtimeWith();
    rt.saveModelSettings({ modelName: 'm', apiBaseUrl: 'https://a.example.com/v2' });
    const calls = recordFetch();
    await rt.listAvailableModels({ apiBaseUrl: 'https://a.example.com/v2', apiKey: '' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith('https://a.example.com/')).toBe(true);
      expect(c.auth).toBe(`Bearer ${OLD_KEY}`);
    }
  });
});
