/**
 * SUB1 验收（桌面层接线，规格 docs/委派/SUB1-直接接magpie.md 条件 3）。
 *
 * 条件 3 的前半段：保存 magpie 预设后，「模型接入」里的 API 地址与 Key 要交给 Hermes。
 * 这里钉住 AppRuntime 把已保存的地址、解密后的 Key、聊天模型一起交给启动参数——
 * 起真 Hermes 的替身测试在 packages/core（sub1-hermes-gateway.test.ts），
 * 这里只覆盖「设置 → 启动参数」这段接线，不联网、不起进程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

interface Launch {
  chatModel: string | null;
  chatBaseUrl: string | null;
  chatApiKey: string | null;
}

let dir: string;

function runtimeWith(over: {
  modelName?: string;
  chatModelName?: string;
  apiBaseUrl?: string;
  apiKeyEncrypted?: string | null;
  apiKeyPresent?: boolean;
}): { launch(): Launch } {
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['config'] = {
    ...defaultAppConfig(),
    model: {
      ...defaultAppConfig().model,
      modelName: over.modelName ?? '',
      chatModelName: over.chatModelName ?? '',
      apiBaseUrl: over.apiBaseUrl ?? '',
      apiKeyEncrypted: over.apiKeyEncrypted ?? null,
      apiKeyPresent: over.apiKeyPresent ?? false,
      savedModels: [],
    },
  };
  rt['configFile'] = join(dir, 'config.json');
  return {
    launch: () => (rt['chatLaunchOptions'] as () => Launch).call(rt),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-sub1-launch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SUB1 设置 → Hermes 启动参数', () => {
  it('magpie 预设 + 聊天模型 prov/m1 → 地址、解密后的 Key、模型一起传', () => {
    const rt = runtimeWith({
      modelName: 'prov/m1',
      chatModelName: 'prov/m1',
      apiBaseUrl: 'http://127.0.0.1:3425/v1',
      // 真实格式：safeStorage 加密后 base64（见 encryptApiKey）。
      apiKeyEncrypted: Buffer.from('enc:magpie').toString('base64'),
      apiKeyPresent: true,
    });
    expect(rt.launch()).toEqual({
      chatModel: 'prov/m1',
      chatBaseUrl: 'http://127.0.0.1:3425/v1',
      chatApiKey: 'magpie',
    });
  });

  it('没有聊天模型 → 不碰网关（留给 Hermes 自己的 config.yaml）', () => {
    const rt = runtimeWith({
      modelName: '',
      chatModelName: '',
      apiBaseUrl: 'http://127.0.0.1:3425/v1',
      apiKeyEncrypted: 'enc:magpie',
      apiKeyPresent: true,
    });
    expect(rt.launch()).toEqual({ chatModel: null, chatBaseUrl: null, chatApiKey: null });
  });

  it('地址为空 → 只传模型，不改网关', () => {
    const rt = runtimeWith({
      modelName: 'prov/m1',
      chatModelName: '',
      apiBaseUrl: '',
      apiKeyEncrypted: null,
      apiKeyPresent: false,
    });
    expect(rt.launch()).toEqual({ chatModel: 'prov/m1', chatBaseUrl: null, chatApiKey: null });
  });
});
