/**
 * K3 验收 条件 7（存储这一半）：规格 docs/委派/K3-驾驶舱页面.md。
 *
 * 条件 7：设置页填了仓库路径、保存 → `cockpit.ixaeon_repo` 存上了；清空保存 → 设置项变空。
 * 这一份走 IPC `saveCockpitSettings`，看真正写进 `app_settings` 的值；设置页那一半见
 * k3-cockpit-settings.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { getSetting, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
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

/** 真 runtime 的 db（registerIpc 从这里取），按通道名调用注册好的处理函数。 */
function ipc() {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string, arg?: unknown): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    const handler = entry[1] as (event: unknown, input?: unknown) => Promise<T>;
    return handler({}, arg);
  };
}

describe('条件 7：保存 IXAEON 仓库路径', () => {
  it('保存后 app_settings 的 cockpit.ixaeon_repo 是那个路径；清空保存后是空串', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-k3-settings-'));
    dirs.push(dir);
    db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);

    const call = ipc();
    await call('saveCockpitSettings', { ixaeonRepo: 'D:\\合成\\IXAEON' });
    expect(getSetting(db, 'cockpit.ixaeon_repo')?.value).toBe('D:\\合成\\IXAEON');

    await call('saveCockpitSettings', { ixaeonRepo: '' });
    expect(getSetting(db, 'cockpit.ixaeon_repo')?.value).toBe('');
  });
});
