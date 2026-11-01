/**
 * K10a 验收（规格 docs/委派/K10a-调度器面板.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 契约里的 IPC：`getRelayModels(): Promise<RelayModels>`、`setRelayModel(input)`（contracts 加类型、
 * preload 暴露）。`relayDir` 照 K2：默认 ~/.ixaeon/relay，IXAEON_RELAY_DIR 覆盖。
 * 这里用合成 relay 目录，按通道名调 registerIpc 注册的处理函数。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
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

const PATCH = `- id: llm-pi-ai
  config:
    providers:
      gw-a:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: model-a1
            name: model-a1
- id: agent-default-model
  config:
    provider: gw-a
    model: model-a1
`;

let relayDir: string;
const saved = process.env.IXAEON_RELAY_DIR;

beforeEach(() => {
  relayDir = mkdtempSync(join(tmpdir(), 'ixaeon-k10a-ipc-'));
  const patch = join(relayDir, 'relay.patch.yml');
  writeFileSync(patch, PATCH, 'utf8');
  writeFileSync(
    join(relayDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          developer: { argv: ['dsh', '--patch', patch] },
          integrator: { argv: ['claude.exe', '-p', '{prompt_file}'] },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.env.IXAEON_RELAY_DIR = relayDir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.IXAEON_RELAY_DIR;
  else process.env.IXAEON_RELAY_DIR = saved;
  try {
    rmSync(relayDir, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
  }
});

function ipc() {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    const handler = entry[1] as (event: unknown, ...a: unknown[]) => Promise<T>;
    return handler({} as never, ...args);
  };
}

describe('K10a IPC', () => {
  it('getRelayModels 从 IXAEON_RELAY_DIR 读；setRelayModel 写回补丁，下一棒生效', async () => {
    const call = ipc();
    const before = await call<{ roles: Array<{ role: string; current: string | null }> }>(
      'getRelayModels',
    );
    expect(before.roles.find((r) => r.role === 'developer')!.current).toBe('gw-a / model-a1');

    await expect(call('setRelayModel', { role: 'integrator', value: 'sonnet' })).resolves.toEqual({
      ok: true,
    });
    const config = JSON.parse(readFileSync(join(relayDir, 'config.json'), 'utf8')) as {
      roles: { integrator: { argv: string[] } };
    };
    expect(config.roles.integrator.argv).toContain('sonnet');

    const after = await call<{ roles: Array<{ role: string; current: string | null }> }>(
      'getRelayModels',
    );
    expect(after.roles.find((r) => r.role === 'integrator')!.current).toBe('sonnet');
  });

  it('setRelayModel 拒绝没登记的模型：IPC 报 VALIDATION_FAILED，文件不动', async () => {
    const call = ipc();
    const before = readFileSync(join(relayDir, 'config.json'), 'utf8');
    await expect(
      call('setRelayModel', { role: 'developer', value: 'gw-a / nope' }),
    ).rejects.toThrow(/IXA0012/);
    expect(readFileSync(join(relayDir, 'config.json'), 'utf8')).toBe(before);
  });
});
