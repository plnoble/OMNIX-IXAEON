/**
 * V4 验收测试共用的 `node:child_process` 替身（整合方 2026-10-19 锁定前统一）。
 *
 * 四份 V4 测试原来各写一份替身，有的只认 `spawn`，有的认回调式的 `execFile` 却不认
 * `promisify(execFile)`（真的 Node 会给 `{ stdout, stderr }`，原来的替身只给一个字符串）——
 * 实现选了另一种异步写法，写对了也过不了。这里把常用的几种都照真的 Node 的样子接上，
 * 按同一张脚本表回话；没登记的命令回失败码（不会挂住）。
 *
 * - 异步：`spawn`（发 `exit` 和 `close`）、`execFile` / `exec`（回调式，以及 `promisify` 之后
 *   给 `{ stdout, stderr }`、失败时 reject 一个带 `code`、`stdout`、`stderr` 的错误）。记进 `async`。
 * - 同步：`spawnSync`、`execFileSync`、`execSync`。记进 `sync`；`forbidSync` 时一调就抛错。
 *
 * 用法（替身状态要在 `vi.hoisted` 里建，工厂里再引这个文件）：
 *
 *   const child = vi.hoisted(() => ({ scripts: new Map(), sync: [], async: [], key: … }));
 *   vi.mock('node:child_process', async (importOriginal) => {
 *     const { childProcessDouble } = await import('./v4-child-double.js');
 *     return childProcessDouble(await importOriginal(), child);
 *   });
 */
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import type * as ChildProcess from 'node:child_process';

export interface ChildScript {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ChildDouble {
  scripts: Map<string, ChildScript>;
  sync: string[];
  async: string[];
  /** 脚本表的键：`exe|参数（\0 拼）`。 */
  key: (exe: unknown, args: unknown) => string;
}

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

export function childProcessDouble(
  actual: typeof ChildProcess,
  d: ChildDouble,
  opts: { forbidSync?: boolean } = {},
): Record<string, unknown> {
  const answer = (exe: unknown, args: unknown): ChildScript =>
    d.scripts.get(d.key(exe, args)) ?? {
      code: 1,
      stdout: '',
      stderr: 'V4 替身：没有登记这个命令\n',
    };
  const failure = (a: ChildScript) =>
    Object.assign(new Error(`V4 替身：退出码 ${a.code}`), {
      code: a.code,
      stdout: a.stdout,
      stderr: a.stderr,
    });
  const fakeProcess = () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: () => boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 1;
    proc.kill = () => true;
    return proc;
  };

  const spawn = (exe: unknown, args?: unknown) => {
    const list = Array.isArray(args) ? args : [];
    d.async.push(d.key(exe, list));
    const a = answer(exe, list);
    const proc = fakeProcess();
    queueMicrotask(() => {
      if (a.stdout) proc.stdout.emit('data', Buffer.from(a.stdout));
      if (a.stderr) proc.stderr.emit('data', Buffer.from(a.stderr));
      proc.emit('exit', a.code, null);
      proc.emit('close', a.code, null);
    });
    return proc;
  };

  /** execFile(file, args?, options?, callback?)：参数可以省略，回调是最后一个函数。 */
  const execFile = (exe: unknown, ...rest: unknown[]) => {
    const list = Array.isArray(rest[0]) ? rest[0] : [];
    const done = rest.find((x) => typeof x === 'function') as Callback | undefined;
    d.async.push(d.key(exe, list));
    const a = answer(exe, list);
    queueMicrotask(() => done?.(a.code === 0 ? null : failure(a), a.stdout, a.stderr));
    return fakeProcess();
  };
  Object.defineProperty(execFile, promisify.custom, {
    value: (exe: unknown, args?: unknown) => {
      const list = Array.isArray(args) ? args : [];
      d.async.push(d.key(exe, list));
      const a = answer(exe, list);
      return a.code === 0
        ? Promise.resolve({ stdout: a.stdout, stderr: a.stderr })
        : Promise.reject(failure(a));
    },
  });

  /** exec(command, options?, callback?)：整条命令当 exe，参数为空。 */
  const exec = (command: unknown, ...rest: unknown[]) => {
    const done = rest.find((x) => typeof x === 'function') as Callback | undefined;
    d.async.push(d.key(command, []));
    const a = answer(command, []);
    queueMicrotask(() => done?.(a.code === 0 ? null : failure(a), a.stdout, a.stderr));
    return fakeProcess();
  };
  Object.defineProperty(exec, promisify.custom, {
    value: (command: unknown) => {
      d.async.push(d.key(command, []));
      const a = answer(command, []);
      return a.code === 0
        ? Promise.resolve({ stdout: a.stdout, stderr: a.stderr })
        : Promise.reject(failure(a));
    },
  });

  const forbidden =
    (name: string) =>
    (...args: unknown[]) => {
      d.sync.push(`${name}:${String(args[0])}`);
      throw new Error(`V4 条件 2：${name} 不许在检查和授权里用`);
    };
  const spawnSync = (exe: unknown, args?: unknown) => {
    const list = Array.isArray(args) ? args : [];
    d.sync.push(d.key(exe, list));
    const a = answer(exe, list);
    return {
      pid: 1,
      status: a.code,
      signal: null,
      stdout: a.stdout,
      stderr: a.stderr,
      output: [null, a.stdout, a.stderr],
    };
  };
  const execFileSync = (exe: unknown, args?: unknown) => {
    const list = Array.isArray(args) ? args : [];
    d.sync.push(d.key(exe, list));
    const a = answer(exe, list);
    if (a.code !== 0) throw failure(a);
    return a.stdout;
  };
  const execSync = (command: unknown) => {
    d.sync.push(d.key(command, []));
    const a = answer(command, []);
    if (a.code !== 0) throw failure(a);
    return a.stdout;
  };

  const patched = {
    ...actual,
    spawn,
    execFile,
    exec,
    spawnSync: opts.forbidSync ? forbidden('spawnSync') : spawnSync,
    execFileSync: opts.forbidSync ? forbidden('execFileSync') : execFileSync,
    execSync: opts.forbidSync ? forbidden('execSync') : execSync,
  };
  return { ...patched, default: patched };
}
