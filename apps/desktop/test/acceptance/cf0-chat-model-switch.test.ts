/**
 * CF0 验收（后端，规格 docs/委派/CF0-聊天先能用.md）——换模型走的现有保存设置通道。
 *
 * 规格条件 8 是「`setChatModel`（如果加了）」。本棒没有新开 IPC，改用现有
 * `saveModelSettings({ modelName, chatModelName })`；这条测试钉住它只改聊天模型，
 * 不碰 Key、地址、已保存清单，也不发网络请求：
 * - 传 `modelName`（分析模型原样）+ `chatModelName`（新聊天模型）→ `chatModelName` 变、
 *   `modelName` / `apiBaseUrl` / Key 状态 / `savedModels` 都不变；
 * - 返回 `keyCleared: false`，配置落盘；
 * - 整个过程一次 `fetch` 都没有（保存设置不是「检测模型」）。
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

import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

interface SwitchRuntime {
  saveModelSettings(input: {
    modelName: string;
    chatModelName?: string;
  }): Promise<{ ok: true; keyCleared: boolean }>;
  getConfig(): ReturnType<typeof defaultAppConfig>;
}

let dir: string;
let configFile: string;

function runtimeWith(): SwitchRuntime {
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['config'] = {
    ...defaultAppConfig(),
    model: {
      ...defaultAppConfig().model,
      modelName: 'demo-a',
      chatModelName: 'demo-a',
      apiBaseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEncrypted: 'enc:sk-synthetic',
      apiKeyPresent: true,
      savedModels: ['demo-a', 'demo-b'],
    },
  };
  rt['configFile'] = configFile;
  rt['askSessions'] = new Map();
  rt['conversations'] = { clearEngineSessions: () => undefined };
  rt['disposeWarmSession'] = () => undefined;
  rt['warm'] = null;
  return rt as unknown as SwitchRuntime;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf0-switch-'));
  configFile = join(dir, 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('CF0 换聊天模型走现有保存设置通道', () => {
  it('只改 chatModelName：Key、地址、分析模型、已保存清单都不动，也不发网络请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const rt = runtimeWith();
    const result = await rt.saveModelSettings({ modelName: 'demo-a', chatModelName: 'demo-b' });

    expect(result).toEqual({ ok: true, keyCleared: false });
    const config = rt.getConfig();
    expect(config.model.chatModelName).toBe('demo-b');
    expect(config.model.modelName).toBe('demo-a');
    expect(config.model.apiBaseUrl).toBe('http://127.0.0.1:9/v1');
    expect(config.model.apiKeyPresent).toBe(true);
    expect(config.model.apiKeyEncrypted).toBe('enc:sk-synthetic');
    expect(config.model.savedModels).toEqual(['demo-a', 'demo-b']);
    expect(fetchSpy).not.toHaveBeenCalled();

    const onDisk = JSON.parse(readFileSync(configFile, 'utf8')) as {
      model: {
        chatModelName: string;
        modelName: string;
        apiBaseUrl: string;
        savedModels: string[];
      };
    };
    expect(onDisk.model.chatModelName).toBe('demo-b');
    expect(onDisk.model.modelName).toBe('demo-a');
    expect(onDisk.model.apiBaseUrl).toBe('http://127.0.0.1:9/v1');
    expect(onDisk.model.savedModels).toEqual(['demo-a', 'demo-b']);
  });
});
