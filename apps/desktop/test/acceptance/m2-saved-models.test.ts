/**
 * M2 验收（后端，规格 docs/委派/M2-模型管理-检测勾选保存.md）
 *
 * 逐条对应规格契约（界面部分由 e2e m2-model-ui.spec.ts 照过）：
 *
 * - 契约 1/3：保存选择后 config.model.savedModels 正好是勾上的那些；旧配置
 *   （没有这两个字段）照常读得出来。检测成功才记 modelsCheckedAt（上次检测时间）。
 * - 契约 2（后端）：检测（listAvailableModels）成功只记检测时间，不改清单、
 *   不改在用的模型；保存选择之外的保存（只改模型名/地址/Key）不清空也不改动已保存清单。
 * - 契约 5：重新检测不碰当前在用的模型与清单，只刷新检测时间。
 * - 契约 7：检测失败抛错、config（含清单、检测时间、在用的模型）一点不变。
 * - 契约 6（Key 留空复用、界面与日志不见 Key）由既有
 *   apps/desktop/test/integration/model-key-reuse.test.ts 照过，这里不再重复。
 *
 * 钉住的接缝（实现必须兼容）：
 * - `AppRuntime.saveModelSettings(input)`：可选字段 savedModels（string[]）——
 *   传入时原样写进 config.model.savedModels 并记 modelsCheckedAt=现在；
 *   不传时清单与检测时间都保持原值。
 * - contracts：config.json schema 加 model.savedModels（默认 []）与
 *   model.modelsCheckedAt（默认 null），不加迁移。
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

import { appConfigSchema, defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

interface SaveRuntime {
  saveModelSettings(input: {
    modelName: string;
    chatModelName?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    savedModels?: string[];
  }): Promise<{ ok: true }>;
  listAvailableModels(input: {
    apiBaseUrl: string;
    apiKey: string;
  }): Promise<{ models: Array<{ id: string }> }>;
}

let dir: string;
let configFile: string;

function runtimeWith(model: Record<string, unknown>): {
  rt: SaveRuntime;
  read: () => Record<string, unknown>;
} {
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['config'] = { ...defaultAppConfig(), model: { ...defaultAppConfig().model, ...model } };
  rt['configFile'] = configFile;
  rt['askSessions'] = new Map();
  rt['conversations'] = { clearEngineSessions: () => undefined };
  const read = () => JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  return { rt: rt as unknown as SaveRuntime, read };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m2-'));
  configFile = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('M2 已保存的模型清单（后端）', () => {
  it('契约 1/3：保存选择后 savedModels 正好是勾选的，清单落盘、重启还在', async () => {
    const { rt, read } = runtimeWith({
      modelName: 'a',
      apiKeyPresent: false,
      apiKeyEncrypted: null,
    });
    await rt.saveModelSettings({ modelName: 'a', savedModels: ['gpt-x', 'gpt-y', 'gpt-z'] });
    const onDisk = read();
    const model = (onDisk['model'] as Record<string, unknown>) ?? {};
    expect(model['savedModels']).toEqual(['gpt-x', 'gpt-y', 'gpt-z']);
    // 没检测过：检测时间仍是空的——保存不伪造检测时间
    expect(model['modelsCheckedAt']).toBeNull();
    // 重启 = 重新从磁盘读：清单还在
    const reparsed = appConfigSchema.parse(onDisk);
    expect(reparsed.model.savedModels).toEqual(['gpt-x', 'gpt-y', 'gpt-z']);
  });

  it('契约 1/2：检测成功后才记 modelsCheckedAt（上次检测时间），保存不刷新它', async () => {
    const { rt, read } = runtimeWith({
      modelName: 'a',
      apiKeyPresent: true,
      apiKeyEncrypted: Buffer.from('enc:sk-saved').toString('base64'),
      apiBaseUrl: 'https://api.example.com/v1',
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await rt.listAvailableModels({ apiBaseUrl: 'https://api.example.com/v1', apiKey: '' });
    const afterDetect = (read()['model'] as Record<string, unknown>) ?? {};
    expect(typeof afterDetect['modelsCheckedAt']).toBe('string');
    const first = String(afterDetect['modelsCheckedAt']);
    await new Promise((r) => setTimeout(r, 5));
    await rt.saveModelSettings({ modelName: 'm1', savedModels: ['m1', 'm2'] });
    const afterSave = (read()['model'] as Record<string, unknown>) ?? {};
    expect(String(afterSave['modelsCheckedAt'])).toBe(first);
  });

  it('契约 1：旧配置没有 savedModels/modelsCheckedAt 也照常读得出来（默认空、不迁移）', () => {
    const parsed = appConfigSchema.parse({
      ...defaultAppConfig(),
      model: {
        provider: 'openai',
        modelName: 'legacy-model',
        apiBaseUrl: '',
        apiKeyEncrypted: null,
        apiKeyPresent: false,
      },
    });
    expect(parsed.model.savedModels).toEqual([]);
    expect(parsed.model.modelsCheckedAt).toBeNull();
  });

  it('契约 3：再次保存勾选（去掉一个）后清单精确更新，检测时间不动', async () => {
    const { rt, read } = runtimeWith({
      modelName: 'a',
      apiKeyPresent: true,
      apiKeyEncrypted: Buffer.from('enc:sk-saved').toString('base64'),
      apiBaseUrl: 'https://api.example.com/v1',
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await rt.listAvailableModels({ apiBaseUrl: 'https://api.example.com/v1', apiKey: '' });
    const first = String(((read()['model'] as Record<string, unknown>) ?? {})['modelsCheckedAt']);
    await rt.saveModelSettings({ modelName: 'm3', savedModels: ['m1', 'm2', 'm3'] });
    await new Promise((r) => setTimeout(r, 5));
    await rt.saveModelSettings({ modelName: 'm3', savedModels: ['m3'] });
    const model = (read()['model'] as Record<string, unknown>) ?? {};
    expect(model['savedModels']).toEqual(['m3']);
    expect(String(model['modelsCheckedAt'])).toBe(first);
  });

  it('契约 2/5：不传 savedModels 的保存（改模型名/地址/Key）不清空也不改动清单与检测时间', async () => {
    const { rt, read } = runtimeWith({
      modelName: 'a',
      apiKeyPresent: false,
      apiKeyEncrypted: null,
    });
    await rt.saveModelSettings({ modelName: 'a', savedModels: ['m1', 'm2'] });
    const first = String(((read()['model'] as Record<string, unknown>) ?? {})['modelsCheckedAt']);
    await rt.saveModelSettings({
      modelName: 'm1',
      chatModelName: 'm2',
      apiBaseUrl: 'https://other.example/v4',
      apiKey: 'sk-new',
    });
    const model = (read()['model'] as Record<string, unknown>) ?? {};
    expect(model['savedModels']).toEqual(['m1', 'm2']);
    expect(String(model['modelsCheckedAt'])).toBe(first);
    expect(model['modelName']).toBe('m1');
  });

  it('契约 5：检测（listAvailableModels）成功只刷新检测时间，不碰清单与在用的模型', async () => {
    const { rt, read } = runtimeWith({
      modelName: 'in-use',
      chatModelName: 'chat-in-use',
      apiKeyPresent: true,
      apiKeyEncrypted: Buffer.from('enc:sk-saved').toString('base64'),
    });
    await rt.saveModelSettings({ modelName: 'in-use', savedModels: ['m1', 'm2'] });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await rt.listAvailableModels({ apiBaseUrl: 'https://api.example.com/v1', apiKey: 'sk-typed' });
    const model = (read()['model'] as Record<string, unknown>) ?? {};
    expect(model['savedModels']).toEqual(['m1', 'm2']);
    expect(model['modelName']).toBe('in-use');
    expect(model['chatModelName']).toBe('chat-in-use');
    expect(typeof model['modelsCheckedAt']).toBe('string');
  });

  it('契约 7：检测失败抛错，config（清单/检测时间/在用的模型）一点不变', async () => {
    const { rt, read } = runtimeWith({
      modelName: 'a',
      apiKeyPresent: false,
      apiKeyEncrypted: null,
    });
    await rt.saveModelSettings({ modelName: 'a', savedModels: ['m1'] });
    const before = JSON.stringify(read());
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('upstream exploded', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(
      rt.listAvailableModels({ apiBaseUrl: 'https://api.example.com/v1', apiKey: 'sk-typed' }),
    ).rejects.toThrow(/获取模型列表失败/);
    expect(JSON.stringify(read())).toBe(before);
  });
});
