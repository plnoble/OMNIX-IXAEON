/**
 * V1 验收测试（规格 docs/委派/V1-验证命令在应用里跑成新窗口.md，v2 写法）：
 * 逐条对应验收条件 1/2/4；条件 3（环境白名单）由现有回归照过。
 *
 * 1. Electron 中派生 process.execPath → 子进程环境 ELECTRON_RUN_AS_NODE=1；
 * 2. 普通 node → 不注入；验证命令照常执行、退出码如实（pass/fail 各一例）；
 * 4. stopServer 日志按原因区分（正常/数据恢复）。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultCheck,
  electronRunAsNodeEnv,
  runControlledVerifyCommand,
} from '../../src/execution/executor.js';

/** 常量：注入式 envFn（模拟 Electron 判定为真）。 */
const FORCE_RUN_AS_NODE = () => ({ ELECTRON_RUN_AS_NODE: '1' });
const FORCE_NONE = () => ({});

describe('V1 条件 1：Electron 当 node 用注入 ELECTRON_RUN_AS_NODE=1', () => {
  it('被派生的程序就是本进程自己且本进程是 Electron → 注入', () => {
    const exe = 'C:/fake/IXAEON.exe';
    const versions = { ...process.versions, electron: '44.1.1' };
    expect(electronRunAsNodeEnv(exe, exe, versions)).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('exe 与本进程不同（即使 Electron）→ 不注入', () => {
    const versions = { ...process.versions, electron: '44.1.1' };
    expect(electronRunAsNodeEnv('node.exe', 'C:/fake/IXAEON.exe', versions)).toEqual({});
  });

  it('配线级：默认检查计算出的环境确实传进真实子进程（通过例，退出 0）', async () => {
    // 删掉 defaultCheck 里的 envFn 传入也会让「环境没到子进程」暴露：
    // 注入 FORCE_RUN_AS_NODE 后子进程应打印 RUN_AS_NODE=1。
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v1-'));
    const r = await defaultCheck(
      [
        process.execPath,
        '-e',
        "console.log('RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE ?? 'NONE'))",
      ],
      dir,
      undefined,
      FORCE_RUN_AS_NODE,
    );
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('RUN_AS_NODE=1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('配线级：注入空环境 → 子进程无该变量（失败例，退出码 7 如实）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v1-'));
    const r = await defaultCheck(
      [process.execPath, '-e', 'process.exit(7)'],
      dir,
      undefined,
      FORCE_NONE,
    );
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(7);
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认路径 + 模拟 Electron：生产默认 envFn 判定，子进程收到变量（通过，退出 0）', async () => {
    // envFn 不传（走生产默认实现），只用 versions 参数模拟 process.versions.electron。
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v1-'));
    const versions = { ...process.versions, electron: '44.1.1' };
    const r = await defaultCheck(
      [
        process.execPath,
        '-e',
        "console.log('RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE ?? 'NONE'))",
      ],
      dir,
      undefined,
      undefined,
      versions,
    );
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('RUN_AS_NODE=1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认路径 + 模拟 Electron：失败例退出码 7 如实', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v1-'));
    const versions = { ...process.versions, electron: '44.1.1' };
    const r = await defaultCheck(
      [process.execPath, '-e', 'process.exit(7)'],
      dir,
      undefined,
      undefined,
      versions,
    );
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(7);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('V1 条件 2：普通 node 不注入；验证照常执行、退出码如实', () => {
  it('普通 node（无 versions.electron）→ 不注入', () => {
    expect(electronRunAsNodeEnv(process.execPath, process.execPath, process.versions)).toEqual({});
  });

  it('普通 node 里跑受控验证命令：环境无 ELECTRON_RUN_AS_NODE，通过退出码 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v1-'));
    const r = await runControlledVerifyCommand(
      [
        process.execPath,
        '-e',
        "console.log('RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE ?? 'NONE'))",
      ],
      dir,
    );
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('RUN_AS_NODE=NONE');
    rmSync(dir, { recursive: true, force: true });
  });

  it('普通 node 里跑受控验证命令：失败退出码如实反射', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v1-'));
    const r = await runControlledVerifyCommand([process.execPath, '-e', 'process.exit(7)'], dir);
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(7);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('V1 条件 4：stopServer 日志文案按原因区分', () => {
  it('正常退出写「本地服务已停止」；数据恢复写「（数据恢复）」', async () => {
    const { AppRuntime } = await import('../../../../../apps/desktop/src/main/appRuntime.js');
    const logCalls: string[] = [];
    const logger = {
      info: (m: string) => logCalls.push(m),
      warn: vi.fn(),
      error: vi.fn(),
      child() {
        return this;
      },
    };
    const runtime = Object.create(AppRuntime.prototype) as InstanceType<typeof AppRuntime>;
    Object.assign(runtime, { fastify: { close: async () => undefined }, logger });
    await (
      runtime as unknown as {
        stopServer: (reason: 'normal' | 'restore') => Promise<void>;
      }
    ).stopServer('normal');
    // 第一次调用把 fastify 置 null（与真实行为一致）：给第二次恢复一个新的服务
    Object.assign(runtime, { fastify: { close: async () => undefined } });
    await (
      runtime as unknown as {
        stopServer: (reason: 'normal' | 'restore') => Promise<void>;
      }
    ).stopServer('restore');
    expect(logCalls).toEqual(['本地服务已停止', '本地服务已停止（数据恢复）']);
  });

  it('服务没启动时不写日志（与旧行为一致）', async () => {
    const { AppRuntime } = await import('../../../../../apps/desktop/src/main/appRuntime.js');
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child() {
        return this;
      },
    };
    const runtime = Object.create(AppRuntime.prototype) as InstanceType<typeof AppRuntime>;
    Object.assign(runtime, { fastify: null, logger });
    await (
      runtime as unknown as {
        stopServer: (reason: 'normal' | 'restore') => Promise<void>;
      }
    ).stopServer('normal');
    expect(logger.info).not.toHaveBeenCalled();
  });
});
