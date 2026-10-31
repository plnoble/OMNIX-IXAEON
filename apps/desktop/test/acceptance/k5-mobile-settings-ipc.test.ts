/**
 * K5 验收（设置项与 IPC 这一半）：规格 docs/委派/K5-手机只读页.md。
 *
 * 「要什么」：设置页的「手机查看」开关与端口要能存下来（默认关、默认 43192），
 * 打开设置项后手机只读页按它起停。这里核对：
 * - 新库里 `getSettings()` 的 cockpit.mobileEnabled 是 false、mobilePort 是 43192；
 * - `saveMobileSettings({enabled, port})` 写进设置项，`getSettings()` 读回来是新值；
 * - 保存后立刻按新设置起停（调用 `runtime.mobileServer.apply()`），不是等下次重启。
 *
 * 端口真正监听、只读路由与 Host 白名单见 k5-mobile-server.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import type { AppConfig, AppState, SettingsView } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

/**
 * 实现写出来之前 SettingsView 还没有这两个字段；测试按规格先认它们
 * （整合方锁定之后，实现把字段加进 contracts）。
 */
type MobileSettingsView = SettingsView & {
  cockpit: SettingsView['cockpit'] & { mobileEnabled: boolean; mobilePort: number };
};

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\合成\\ixaeon.exe' },
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
  shell: {},
}));

const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  try {
    if (db?.open) db.close();
  } catch {
    /* 已关 */
  }
  db = null;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

/** registerIpc 的 getSettings 会读这些 runtime 成员；只给够它用。 */
function fakeRuntime(database: CoreDatabase, mobileServer: { apply: () => Promise<void> }) {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const config = {
    model: {
      modelName: 'm1',
      chatModelName: '',
      apiBaseUrl: 'https://api.example.com/v1',
      apiKeyPresent: true,
      savedModels: ['m1'],
      modelsCheckedAt: null,
    },
    capture: { enabled: false, autoAnalyze: false, pausedConversations: [] },
    extension: { token: null },
    coding: { executor: 'codex', modelName: '' },
    webSearch: { provider: 'none', apiKeyPresent: false },
    localToken: 'token',
  } as unknown as AppConfig;
  Object.defineProperty(runtime, 'state', {
    value: { dataDir: 'TMP' } as AppState,
    configurable: true,
  });
  Object.assign(runtime, {
    db: database,
    mobileServer,
    getConfig: () => config,
    lastCaptureAt: () => null,
    askCaptureStatus: () => 'enabled',
    extensionUnpackedDir: () => null,
    apiKeyNeedsReentry: () => false,
    hermesFound: () => false,
    hermesNotice: () => '',
  });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return {
    runtime,
    call: async <T>(name: string, arg?: unknown): Promise<T> => {
      const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
      if (!entry) throw new Error(`没有注册 IPC：${name}`);
      const handler = entry[1] as (event: unknown, input?: unknown) => Promise<T>;
      return handler({}, arg);
    },
  };
}

function makeDb(): CoreDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-k5-ipc-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  return db;
}

describe('设置项与 IPC：手机查看', () => {
  it('新库默认关、端口 43192；保存后读回新值，并立刻 apply', async () => {
    const database = makeDb();
    const apply = vi.fn(async () => undefined);
    const { call } = fakeRuntime(database, { apply });

    const before = await call<MobileSettingsView>('getSettings');
    expect(before.cockpit.mobileEnabled).toBe(false);
    expect(before.cockpit.mobilePort).toBe(43192);
    expect(apply).not.toHaveBeenCalled();

    await call('saveMobileSettings', { enabled: true, port: 43200 });
    expect(apply).toHaveBeenCalledTimes(1);

    const after = await call<MobileSettingsView>('getSettings');
    expect(after.cockpit.mobileEnabled).toBe(true);
    expect(after.cockpit.mobilePort).toBe(43200);

    await call('saveMobileSettings', { enabled: false, port: 43200 });
    expect(apply).toHaveBeenCalledTimes(2);
    const off = await call<MobileSettingsView>('getSettings');
    expect(off.cockpit.mobileEnabled).toBe(false);
    expect(off.cockpit.mobilePort).toBe(43200);
  });
});
