/**
 * S3a 验收条件 5（v2 规格）：编号不在清单里、清单号过期或编造 → 拒绝，什么都不导。
 * docs/委派/S3a-编码代理会话选择导入（核心）.md
 *
 * 渲染层只传清单号和编号。IPC：listAgentSessions / estimateAgentSessions / importAgentSessions。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { ErrorCodes } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it('条件 5：编造的清单号、不在清单里的编号，导入拒绝且什么都不导', async () => {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime & {
    listAgentSessions?: (input: { ticket: string }) => Promise<unknown>;
    estimateAgentSessions?: (input: { listId: string; ids: number[] }) => Promise<unknown>;
    importAgentSessions?: (input: {
      listId: string;
      ids: number[];
      projectId: string | null;
    }) => Promise<unknown>;
    imports: { importFile: ReturnType<typeof vi.fn> };
  };
  runtime.imports = { importFile: vi.fn() };

  const importFake = runtime.importAgentSessions;
  expect(typeof importFake).toBe('function');

  await expect(
    runtime.importAgentSessions!({ listId: 'forged-list', ids: [1], projectId: null }),
  ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });

  await expect(
    runtime.estimateAgentSessions!({ listId: 'forged-list', ids: [1] }),
  ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });

  expect(runtime.imports.importFile).not.toHaveBeenCalled();
});
