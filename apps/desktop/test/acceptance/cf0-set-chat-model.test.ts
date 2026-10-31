/**
 * CF0 验收（后端，规格 docs/委派/CF0-聊天先能用.md）
 *
 * 条件 8：`setChatModel`（规格允许新加的那个只改聊天模型的 IPC）传不在 `savedModels`
 * 里的模型 → 被拒、设置不变。
 *
 * 另外钉住正路：传已保存的模型 → `config.model.chatModelName` 变成它，落盘；
 * 走的是现有保存设置的同一条路（不另外发明写配置的通道）。
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
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

import { defaultAppConfig, ErrorCodes, IxaError } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

interface ChatModelRuntime {
  setChatModel(input: { model: string }): Promise<{ ok: true }>;
  getConfig(): ReturnType<typeof defaultAppConfig>;
}

let dir: string;
let configFile: string;

function runtimeWith(savedModels: string[], chatModelName: string): ChatModelRuntime {
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['config'] = {
    ...defaultAppConfig(),
    model: { ...defaultAppConfig().model, modelName: 'demo-a', chatModelName, savedModels },
  };
  rt['configFile'] = configFile;
  rt['askSessions'] = new Map();
  rt['conversations'] = { clearEngineSessions: () => undefined };
  rt['disposeWarmSession'] = () => undefined;
  rt['warm'] = null;
  return rt as unknown as ChatModelRuntime;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf0-'));
  configFile = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CF0 setChatModel：只能换到已保存的模型', () => {
  it('条件 8：传不在 savedModels 里的模型 → 被拒、设置不变（磁盘也不变）', async () => {
    const rt = runtimeWith(['demo-a', 'demo-b'], 'demo-a');
    const before = rt.getConfig();
    await expect(rt.setChatModel({ model: 'demo-x' })).rejects.toBeInstanceOf(IxaError);
    await expect(rt.setChatModel({ model: 'demo-x' })).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(rt.getConfig().model.chatModelName).toBe('demo-a');
    expect(before.model.savedModels).toEqual(['demo-a', 'demo-b']);
    // 没写盘：保存设置的落盘路径一次都没走
    expect(() => readFileSync(configFile, 'utf8')).toThrow();
  });

  it('正路：传已保存的 demo-b → 聊天模型变成 demo-b、落盘，别的设置不动', async () => {
    const rt = runtimeWith(['demo-a', 'demo-b'], 'demo-a');
    await rt.setChatModel({ model: 'demo-b' });
    expect(rt.getConfig().model.chatModelName).toBe('demo-b');
    expect(rt.getConfig().model.modelName).toBe('demo-a');
    expect(rt.getConfig().model.savedModels).toEqual(['demo-a', 'demo-b']);
    const onDisk = JSON.parse(readFileSync(configFile, 'utf8')) as {
      model: { chatModelName: string };
    };
    expect(onDisk.model.chatModelName).toBe('demo-b');
  });
});
