/**
 * V4 验收（规格 docs/委派/V4-依赖档验证的授权入口-新版沙箱.md，条件 1 的后半句）：
 * **执行器在应用启动时找一次，之后判断有没有 Codex 不再问版本。**
 *
 * 这一条要真的起一次运行时（`AppRuntime.create()`）才测得到：找 Codex 的时机钉在
 * `createCodingExecutor`（应用启动）上，`codingDispatch` 判断有没有 Codex 时用记下的结果。
 * 沙箱那边是另一回事——每次查授权之前都重新找（见 v4-codex-latest.test.ts）。
 *
 * 子进程全是替身（`--version` 按脚本回话），不碰真的 Codex；接口监听用随机端口，
 * 测完 `stop()` 收干净。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';

// 端口在约定包加载时就读了，所以要在 import 之前设好（vi.hoisted 比 import 先跑）
const env = vi.hoisted(() => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env['IXAEON_HTTP_PORT'] = String(port);
  process.env['IXAEON_EMBED_MODEL'] = 'none';
  return { port };
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getPath: () => '',
    getAppPath: () => '',
    isPackaged: false,
  },
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

const child = vi.hoisted(() => ({
  scripts: new Map<string, { code: number; stdout: string; stderr: string }>(),
  sync: [] as string[],
  async: [] as string[],
  key: (exe: unknown, args: unknown) =>
    `${String(exe)}|${(Array.isArray(args) ? args : []).map(String).join('\0')}`,
}));

// 子进程替身（整合方 2026-10-19 统一成一份，见 v4-child-double.js）
vi.mock('node:child_process', async (importOriginal) => {
  const { childProcessDouble } =
    await import('../../../../packages/core/test/acceptance/v4-child-double.js');
  return childProcessDouble(await importOriginal<typeof ChildProcess>(), child);
});

const { AppRuntime } = await import('../../src/main/appRuntime.js');

const dirs: string[] = [];
const saved = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  IXAEON_CODEX_EXE: process.env.IXAEON_CODEX_EXE,
  IXAEON_DATA_DIR: process.env.IXAEON_DATA_DIR,
};

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 合成的 codex.exe；问版本走替身。 */
function fakeCodex(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'codex.exe');
  writeFileSync(exe, '');
  child.scripts.set(child.key(exe, ['--version']), {
    code: 0,
    stdout: `codex-cli ${version}\n`,
    stderr: '',
  });
  return exe;
}

const versionAsks = () =>
  [...child.sync, ...child.async].filter((k) => k.endsWith('|--version')).length;

let runtime: Awaited<ReturnType<typeof AppRuntime.create>> | null = null;
let newest = '';
let asksAfterStartup = 0;

beforeAll(async () => {
  const local = temp('ixa-v4-local-');
  process.env.LOCALAPPDATA = local;
  delete process.env.IXAEON_CODEX_EXE;
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  fakeCodex(bin, '0.10.0');
  newest = fakeCodex(join(bin, 'hash-new'), '0.11.0');
  process.env.IXAEON_DATA_DIR = temp('ixa-v4-data-');

  runtime = await AppRuntime.create();
  asksAfterStartup = versionAsks();
}, 60_000);

afterAll(async () => {
  try {
    await runtime?.stop();
  } catch {
    // 收尾失败不影响断言
  }
  runtime = null;
  if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
  if (saved.IXAEON_CODEX_EXE === undefined) delete process.env.IXAEON_CODEX_EXE;
  else process.env.IXAEON_CODEX_EXE = saved.IXAEON_CODEX_EXE;
  if (saved.IXAEON_DATA_DIR === undefined) delete process.env.IXAEON_DATA_DIR;
  else process.env.IXAEON_DATA_DIR = saved.IXAEON_DATA_DIR;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('条件 1：执行器在应用启动时找一次', () => {
  it('启动时问了版本、取的是最新的那个；之后判断有没有 Codex 不再问版本', () => {
    expect(asksAfterStartup).toBeGreaterThan(0);
    expect(runtime!.codexLocator?.()?.exe).toBe(newest);

    const before = versionAsks();
    runtime!.codexLocator?.();
    runtime!.codexLocator?.();
    expect(versionAsks()).toBe(before);
  });

  it('端口是这次设的那个（确认没去占默认端口）', () => {
    expect(env.port).toBeGreaterThanOrEqual(20000);
    expect(runtime!.state.serverPort).toBe(env.port);
  });
});
