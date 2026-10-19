/**
 * V4 验收（规格 docs/委派/V4-依赖档验证的授权入口.md，条件 2：不卡住窗口）。
 *
 * 契约 3.2：`checkSandboxAuth`、`requestSandboxAuth` 跑在 Electron 主进程里，
 * 不许用 `spawnSync`（授权那一步要等用户点完 Windows 的确认框，最长 120 秒；
 * 用同步子进程的话这段时间整个窗口都不动）。函数的名字、参数、返回类型都不变，
 * 只把子进程换成异步的。
 *
 * 这一份把 `spawnSync` 换成一调就抛错的替身（连 `execSync`、`execFileSync` 一起），
 * 异步的子进程换成按脚本回话的替身。四样齐全时检查本来就该是 `ok`：实现要是还在用
 * 同步子进程，这里会直接炸，而不是「悄悄还是 unauthorized」。
 *
 * 子进程全是替身，不碰真的 Codex；`requestSandboxAuth` 这一步不让替身给出提权成功的
 * 回话（回失败码），所以它只会走到「没授权」就收尾，绝不会真的弹管理员确认。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';

const child = vi.hoisted(() => ({
  scripts: new Map<string, { code: number; stdout: string; stderr: string }>(),
  syncCalls: [] as string[],
  asyncCalls: [] as string[],
  key: (exe: unknown, args: unknown) =>
    `${String(exe)}|${(Array.isArray(args) ? args : []).map(String).join('\0')}`,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const { EventEmitter } = await import('node:events');
  const answer = (exe: unknown, args: unknown) =>
    child.scripts.get(child.key(exe, args)) ?? { code: 1, stdout: '', stderr: '替身\n' };
  const forbidden =
    (name: string) =>
    (...args: unknown[]) => {
      child.syncCalls.push(`${name}:${String(args[0])}`);
      throw new Error(`V4 条件 2：${name} 不许在检查和授权里用`);
    };
  const spawn = ((exe: unknown, args?: readonly string[]) => {
    child.asyncCalls.push(child.key(exe, args));
    const a = answer(exe, args);
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => true;
    queueMicrotask(() => {
      if (a.stdout) proc.stdout.emit('data', Buffer.from(a.stdout));
      if (a.stderr) proc.stderr.emit('data', Buffer.from(a.stderr));
      proc.emit('exit', a.code);
      proc.emit('close', a.code);
    });
    return proc;
  }) as unknown as typeof actual.spawn;
  const callbackStyle = (exe: unknown, args?: unknown, opts?: unknown, cb?: unknown) => {
    const done = (typeof opts === 'function' ? opts : cb) as
      ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    child.asyncCalls.push(child.key(exe, args));
    const a = answer(exe, args);
    queueMicrotask(() => {
      const err =
        a.code === 0
          ? null
          : Object.assign(new Error(`替身退出码 ${a.code}`), {
              code: a.code,
              stdout: a.stdout,
              stderr: a.stderr,
            });
      done?.(err, a.stdout, a.stderr);
    });
    return { pid: 1, kill: () => true, stdout: null, stderr: null };
  };
  const patched = {
    ...actual,
    spawn,
    execFile: callbackStyle as unknown as typeof actual.execFile,
    exec: callbackStyle as unknown as typeof actual.exec,
    spawnSync: forbidden('spawnSync') as unknown as typeof actual.spawnSync,
    execSync: forbidden('execSync') as unknown as typeof actual.execSync,
    execFileSync: forbidden('execFileSync') as unknown as typeof actual.execFileSync,
  };
  return { ...patched, default: patched };
});

const { checkSandboxAuth, requestSandboxAuth } =
  await import('../../src/execution/verifySandbox.js');

const dirs: string[] = [];
const savedLocal = process.env.LOCALAPPDATA;

beforeEach(() => {
  child.scripts.clear();
  child.syncCalls.length = 0;
  child.asyncCalls.length = 0;
});

afterEach(() => {
  if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocal;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 四样齐全的数据目录；Codex 用合成的空文件顶替，问版本走替身。 */
function ready(): { dataDir: string; exe: string } {
  const local = temp('ixa-v4-local-');
  process.env.LOCALAPPDATA = local;
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, 'codex.exe');
  writeFileSync(exe, '');
  child.scripts.set(child.key(exe, ['--version']), {
    code: 0,
    stdout: 'codex-cli 9.9.9\n',
    stderr: '',
  });
  const dataDir = temp('ixa-v4-data-');
  const home = join(dataDir, 'codex-sandbox-home');
  mkdirSync(join(home, '.sandbox-bin'), { recursive: true });
  mkdirSync(join(home, '.sandbox'), { recursive: true });
  writeFileSync(
    join(home, 'cap_sid'),
    JSON.stringify({ workspace: 'S-1', readonly: 'S-2', workspace_by_cwd: { 'D:/x': 'S-3' } }),
  );
  writeFileSync(join(home, '.sandbox-bin', 'codex-command-runner-9.9.9.exe'), '');
  writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}');
  for (const sc of ['sc', 'sc.exe']) {
    child.scripts.set(child.key(sc, ['query', 'CodexSandboxService.OpenAI.Codex']), {
      code: 0,
      stdout: 'STATE              : 4  RUNNING\n',
      stderr: '',
    });
  }
  return { dataDir, exe };
}

describe('条件 2：检查与授权都不用同步子进程', () => {
  it('checkSandboxAuth 用异步子进程，四样齐了照样是 ok；spawnSync 一次都没被调', async () => {
    const { dataDir } = ready();

    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(child.syncCalls).toEqual([]);
    expect(child.asyncCalls.length).toBeGreaterThan(0);
  });

  it('requestSandboxAuth 也用异步子进程；spawnSync 一次都没被调', async () => {
    const { dataDir, exe } = ready();

    // 提权那一步的替身回失败码：只会走到「没授权」，不会真的弹确认框
    const result = await requestSandboxAuth(dataDir);

    expect(child.syncCalls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
    // 它确实起了异步的 codex（找版本 + 派沙箱），只是没成功
    expect(child.asyncCalls.some((k) => k.startsWith(`${exe}|`))).toBe(true);
  });

  it('检查期间没有同步子进程（异步替身照常回话）', async () => {
    const { dataDir } = ready();
    const before = child.asyncCalls.length;

    await checkSandboxAuth(dataDir, { platform: 'win32' });

    expect(child.syncCalls).toEqual([]);
    expect(child.asyncCalls.length).toBeGreaterThan(before);
  });
});
