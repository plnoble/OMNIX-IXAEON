/**
 * V4（新版沙箱）验收条件 1–6 的核心层测试（规格 docs/委派/V4-依赖档验证的授权入口-新版沙箱.md）。
 * 先测试后实现（B 档）：实现没改之前这些是红的。旧版锁定的 v4-codex-latest / v4-sandbox-async /
 * d2-sandbox-tier 钉着旧口径，本文件不碰它们；新旧冲突的清单写在交付说明里，由整合方重锁。
 *
 * 条件 1：找 Codex 只有一套、取最新版（数字比）；IXAEON_CODEX_EXE 指定/none；执行器、
 *   检查、授权、依赖档派生找到的是同一个文件；执行器启动时找一次。
 * 条件 2：检查与授权里不许用同步子进程（spawnSync/execFileSync/execSync 一调就抛错）。
 * 条件 3：检查口径换成「授权记录 + 版本一致 + setup 标记」；只起 --version 一种子进程；
 *   不往数据目录写任何东西；旧的四样都在但没有授权记录 = unauthorized。
 * 条件 4：发起授权 = setup（参数逐字）→ 试跑（参数逐字、输出要有标记）→ 写授权记录；
 *   两步的环境里 CODEX_HOME 是专用 HOME；半路失败不写记录。
 * 条件 5：依赖档派生 argv 逐字（契约 3.4）；config.toml 有契约 3.3 的每一条、写权限只有副本。
 * 条件 6：三种没跑成的原因，验证输出逐字、ran=false、不派生。
 *
 * 子进程全用替身（本文件自带一份会记 env 的；测试绝不真的提权），版本号用合成的（9.9.9）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import type * as ChildProcess from 'node:child_process';
import type { IndependentCheck } from '../../src/execution/executor.js';

const child = vi.hoisted(() => ({
  scripts: new Map<string, { code: number; stdout: string; stderr: string }>(),
  calls: [] as Array<{ key: string; env: NodeJS.ProcessEnv | undefined }>,
  sync: [] as string[],
  /** 条件 2 的开关：打开后同步子进程一调就抛（检查与授权里不许有）。 */
  forbidSync: false,
  key: (exe: unknown, args: unknown) =>
    `${String(exe)}|${(Array.isArray(args) ? args : []).map(String).join('\0')}`,
}));

// 子进程替身：按「exe|参数」回话，记下每次调用的 env（条件 4 要核对 CODEX_HOME）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  type Callback = (err: Error | null, stdout: string, stderr: string) => void;
  const answer = (exe: unknown, args: unknown) =>
    child.scripts.get(child.key(exe, args)) ?? {
      code: 1,
      stdout: '',
      stderr: 'V4 替身：没有登记这个命令\n',
    };
  const failure = (a: { code: number; stdout: string; stderr: string }) =>
    Object.assign(new Error(`V4 替身：退出码 ${a.code}`), a);
  const fakeProcess = () => {
    const proc = new EventEmitter() as EventEmitter & { pid: number };
    proc.pid = 1;
    return proc;
  };
  const spawn = (exe: unknown, args?: unknown, opts?: { env?: NodeJS.ProcessEnv }) => {
    const list = Array.isArray(args) ? args : [];
    child.calls.push({ key: child.key(exe, list), env: opts?.env });
    const a = answer(exe, list);
    const proc = fakeProcess();
    queueMicrotask(() => {
      proc.emit('exit', a.code, null);
      proc.emit('close', a.code, null);
    });
    return proc;
  };
  const execFile = (exe: unknown, ...rest: unknown[]) => {
    const list = Array.isArray(rest[0]) ? rest[0] : [];
    const opts = rest.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as
      { env?: NodeJS.ProcessEnv } | undefined;
    const done = rest.find((x) => typeof x === 'function') as Callback | undefined;
    child.calls.push({ key: child.key(exe, list), env: opts?.env });
    const a = answer(exe, list);
    queueMicrotask(() => done?.(a.code === 0 ? null : failure(a), a.stdout, a.stderr));
    return fakeProcess();
  };
  Object.defineProperty(execFile, promisify.custom, {
    value: (exe: unknown, args?: unknown, opts?: { env?: NodeJS.ProcessEnv }) => {
      const list = Array.isArray(args) ? args : [];
      child.calls.push({ key: child.key(exe, list), env: opts?.env });
      const a = answer(exe, list);
      return a.code === 0
        ? Promise.resolve({ stdout: a.stdout, stderr: a.stderr })
        : Promise.reject(failure(a));
    },
  });
  const forbid = (name: string) => () => {
    throw new Error(`V4 条件 2：${name} 不许在检查和授权里用`);
  };
  // spawnSync 默认按脚本表应答（执行器「启动时找一次」那条合法的同步路径要用的），
  // forbidSync 打开时一调就抛（条件 2：检查与授权里不许有同步子进程）。
  const spawnSync = (exe: unknown, args?: unknown) => {
    if (child.forbidSync) forbid('spawnSync')();
    const list = Array.isArray(args) ? args : [];
    child.sync.push(child.key(exe, list));
    const a = answer(exe, list);
    return { status: a.code, stdout: a.stdout, stderr: a.stderr };
  };
  const patched = {
    ...actual,
    spawn,
    execFile,
    spawnSync,
    execFileSync: () => {
      if (child.forbidSync) forbid('execFileSync')();
      throw new Error('V4 替身：execFileSync 没接');
    },
    execSync: () => {
      if (child.forbidSync) forbid('execSync')();
      throw new Error('V4 替身：execSync 没接');
    },
  };
  return { ...patched, default: patched };
});

const { findLatestCodex, checkSandboxAuth, requestSandboxAuth } =
  await import('../../src/execution/verifySandbox.js');
const { resolveCodexLocator, defaultCheck } = await import('../../src/execution/executor.js');

const dirs: string[] = [];
const saved = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  IXAEON_CODEX_EXE: process.env.IXAEON_CODEX_EXE,
};

beforeEach(() => {
  child.scripts.clear();
  child.calls.length = 0;
  child.sync.length = 0;
  child.forbidSync = false;
  delete process.env.IXAEON_CODEX_EXE;
});

afterEach(() => {
  if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
  if (saved.IXAEON_CODEX_EXE === undefined) delete process.env.IXAEON_CODEX_EXE;
  else process.env.IXAEON_CODEX_EXE = saved.IXAEON_CODEX_EXE;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 合成的 codex.exe：空文件；问版本时替身照 version 回话。null = 问不出来。 */
function fakeCodex(dir: string, version: string | null): string {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'codex.exe');
  writeFileSync(exe, '');
  child.scripts.set(
    child.key(exe, ['--version']),
    version === null
      ? { code: 1, stdout: '', stderr: 'V4 替身：问不出版本\n' }
      : { code: 0, stdout: `codex-cli ${version}\n`, stderr: '' },
  );
  return exe;
}

/** 新口径「已授权」的数据目录：授权记录 + setup 标记（版本配对）；返回 exe 与专用 HOME。 */
function authorizedNew(version = '9.9.9'): { dataDir: string; exe: string; home: string } {
  const local = temp('ixa-v4n-local-');
  process.env.LOCALAPPDATA = local;
  const exe = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), version);
  const dataDir = temp('ixa-v4n-data-');
  const home = join(dataDir, 'codex-sandbox-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'ixaeon-sandbox-auth.json'), JSON.stringify({ codexVersion: version }));
  mkdirSync(join(home, '.sandbox'), { recursive: true });
  writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}');
  return { dataDir, exe, home };
}

/** 旧口径的四样都摆好（cap_sid、helper、setup 标记、服务 RUNNING），但没有授权记录。 */
function legacyArtifacts(version = '9.9.9'): { dataDir: string } {
  const local = temp('ixa-v4n-legacy-local-');
  process.env.LOCALAPPDATA = local;
  const exe = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), version);
  const dataDir = temp('ixa-v4n-legacy-data-');
  const home = join(dataDir, 'codex-sandbox-home');
  mkdirSync(join(home, '.sandbox-bin'), { recursive: true });
  mkdirSync(join(home, '.sandbox'), { recursive: true });
  writeFileSync(
    join(home, 'cap_sid'),
    JSON.stringify({ workspace: 'S-1', readonly: 'S-2', workspace_by_cwd: { 'D:/x': 'S-3' } }),
  );
  writeFileSync(join(home, '.sandbox-bin', `codex-command-runner-${version}.exe`), '');
  writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}');
  child.scripts.set(child.key('sc', ['query', 'CodexSandboxService.OpenAI.Codex']), {
    code: 0,
    stdout: 'STATE              : 4  RUNNING\n',
    stderr: '',
  });
  void exe;
  return { dataDir };
}

const UNAUTHORIZED =
  '这台机器还没给 Codex 沙箱授权，依赖档验证跑不了：到设置页「依赖档验证」点「授权」。授权之后新派的任务才会跑这一档验证。';
const CODEX_MISSING = '没找到 Codex 命令行，依赖档验证跑不了（这一档要用 Codex 的沙箱）。';
const UNSUPPORTED = '依赖档验证只在 Windows 上跑得了。';

describe('条件 1：找 Codex 只有一套，取最新版', () => {
  it('顶层 0.10.0、子目录 0.9.0 和 0.11.0：找到说 0.11.0 的（按数字比，0.11 比 0.9 大）', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    fakeCodex(bin, '0.10.0');
    fakeCodex(join(bin, 'hash-old'), '0.9.0');
    const newest = fakeCodex(join(bin, 'hash-new'), '0.11.0');
    expect(await findLatestCodex()).toEqual({ exe: newest, version: '0.11.0' });
    expect(resolveCodexLocator()?.exe).toBe(newest);
  });

  it('问不出版本号的不算；顶层没有、只有子目录里有，照样找得到；一个都没有是 null', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    fakeCodex(join(bin, 'hash-blank'), null);
    const only = fakeCodex(join(bin, 'hash-only'), '9.9.9');
    expect((await findLatestCodex())?.exe).toBe(only);
    expect(resolveCodexLocator()?.exe).toBe(only);

    const empty = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = empty;
    mkdirSync(join(empty, 'OpenAI', 'Codex', 'bin'), { recursive: true });
    expect(await findLatestCodex()).toBeNull();
    expect(resolveCodexLocator()).toBeNull();
  });

  it('IXAEON_CODEX_EXE 指向一个文件：用它，别的候选一个都不问；=none 是 null', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    const pinned = fakeCodex(temp('ixa-v4n-pinned-'), '1.0.0');
    fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), '9.9.9');
    process.env.IXAEON_CODEX_EXE = pinned;
    const asked = child.calls.length;
    expect((await findLatestCodex())?.exe).toBe(pinned);
    expect(resolveCodexLocator()?.exe).toBe(pinned);
    expect(child.calls.slice(asked).some((c) => c.key.includes('hash-new'))).toBe(false);

    process.env.IXAEON_CODEX_EXE = 'none';
    expect(await findLatestCodex()).toBeNull();
    expect(resolveCodexLocator()).toBeNull();
    const dataDir = temp('ixa-v4n-data-');
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'codex_missing' });
  });

  it('指定的那个问不出版本号：{ exe, version: null }，检查是 unauthorized', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    const pinned = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), null);
    process.env.IXAEON_CODEX_EXE = pinned;
    expect(await findLatestCodex()).toEqual({ exe: pinned, version: null });
    const dataDir = temp('ixa-v4n-data-');
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('检查、授权、依赖档派生用的都是最新版那个文件', async () => {
    const { dataDir, exe } = authorizedNew('0.11.0');
    const local = process.env.LOCALAPPDATA!;
    const top = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), '0.10.0');
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(resolveCodexLocator()?.exe).toBe(exe);
    // 授权：替身给 setup 成功、试跑成功，只核对用的是哪个 exe
    const home = join(dataDir, 'codex-sandbox-home');
    child.scripts.set(
      child.key(exe, ['sandbox', 'setup', '--elevated', '--current-user', '--codex-home', home]),
      {
        code: 0,
        stdout: '',
        stderr: '',
      },
    );
    child.scripts.set(
      child.key(exe, [
        '-c',
        'windows.sandbox="elevated"',
        'sandbox',
        '--permission-profile',
        'ixaeon',
        '-C',
        join(home, 'auth-probe'),
        '--',
        'cmd',
        '/c',
        'echo ixaeon-sandbox-auth-ok',
      ]),
      { code: 0, stdout: 'ixaeon-sandbox-auth-ok\n', stderr: '' },
    );
    await requestSandboxAuth(dataDir);
    const sandboxCalls = child.calls.filter(
      (c) => c.key.includes('|sandbox') || c.key.includes('\0sandbox'),
    );
    expect(sandboxCalls.length).toBeGreaterThan(0);
    expect(sandboxCalls.every((c) => c.key.startsWith(`${exe}|`))).toBe(true);
    expect(sandboxCalls.some((c) => c.key.startsWith(`${top}|`))).toBe(false);
  });
});

describe('条件 2：检查与授权不卡窗口（同步子进程一调就抛）', () => {
  beforeEach(() => {
    child.forbidSync = true;
  });
  it('checkSandboxAuth 与 requestSandboxAuth 全程没有 spawnSync/execFileSync/execSync', async () => {
    const { dataDir } = authorizedNew();
    await checkSandboxAuth(dataDir);
    const home = join(dataDir, 'codex-sandbox-home');
    child.scripts.set(
      child.key(join(process.env.LOCALAPPDATA!, 'OpenAI', 'Codex', 'bin', 'hash-new'), [
        'sandbox',
        'setup',
        '--elevated',
        '--current-user',
        '--codex-home',
        home,
      ]),
      {
        code: 0,
        stdout: '',
        stderr: '',
      },
    );
    await requestSandboxAuth(dataDir);
    expect(child.sync).toEqual([]);
  });
});

describe('条件 3：检查口径 = 授权记录 + 版本一致 + setup 标记', () => {
  it('记录在、版本一样、标记在 → ok；只起过 --version 一种子进程', async () => {
    const { dataDir } = authorizedNew();
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(child.sync).toEqual([]);
    expect(child.calls.length).toBeGreaterThan(0);
    expect(child.calls.every((c) => c.key.endsWith('|--version'))).toBe(true);
  });

  it('缺记录、记录坏了、版本不一样、缺标记 → 各是 unauthorized；检查不写数据目录', async () => {
    const listAll = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();
    const cases: Array<[string, (home: string) => void]> = [
      ['缺记录', (home) => rmSync(join(home, 'ixaeon-sandbox-auth.json'))],
      ['记录坏了', (home) => writeFileSync(join(home, 'ixaeon-sandbox-auth.json'), '{ 不是 JSON')],
      [
        '版本不一样',
        (home) =>
          writeFileSync(
            join(home, 'ixaeon-sandbox-auth.json'),
            JSON.stringify({ codexVersion: '9.9.8' }),
          ),
      ],
      ['缺标记', (home) => rmSync(join(home, '.sandbox', 'setup_marker.json'))],
    ];
    for (const [name, breakIt] of cases) {
      const { dataDir, home } = authorizedNew();
      breakIt(home);
      const before = listAll(dataDir);
      expect(await checkSandboxAuth(dataDir), name).toEqual({ ok: false, reason: 'unauthorized' });
      expect(listAll(dataDir), name).toEqual(before);
    }
    // ok 的那条也要核对不写
    const { dataDir } = authorizedNew();
    const before = listAll(dataDir);
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(listAll(dataDir)).toEqual(before);
  });

  it('旧的四样都在、但没有授权记录：unauthorized（不再认 cap_sid/helper/服务）', async () => {
    const { dataDir } = legacyArtifacts();
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('不是 Windows 是 unsupported_platform（不起任何子进程）', async () => {
    const dataDir = temp('ixa-v4n-data-');
    expect(await checkSandboxAuth(dataDir, { platform: 'linux' })).toEqual({
      ok: false,
      reason: 'unsupported_platform',
    });
    expect(child.calls).toEqual([]);
  });
});

describe('条件 4：发起授权（setup → 试跑 → 写记录）', () => {
  it('两步都成：参数逐字、CODEX_HOME 是专用 HOME、{ok:true}、记录写了版本对；之后检查是 ok', async () => {
    const { dataDir, exe, home } = authorizedNew();
    // requestSandboxAuth 不传 codexExe 接缝，走统一找法；authorizedNew 只放了一个 codex
    const probe = join(home, 'auth-probe');
    child.scripts.set(
      child.key(exe, ['sandbox', 'setup', '--elevated', '--current-user', '--codex-home', home]),
      {
        code: 0,
        stdout: '',
        stderr: '',
      },
    );
    child.scripts.set(
      child.key(exe, [
        '-c',
        'windows.sandbox="elevated"',
        'sandbox',
        '--permission-profile',
        'ixaeon',
        '-C',
        probe,
        '--',
        'cmd',
        '/c',
        'echo ixaeon-sandbox-auth-ok',
      ]),
      { code: 0, stdout: 'ixaeon-sandbox-auth-ok\n', stderr: '' },
    );
    expect(await requestSandboxAuth(dataDir)).toEqual({ ok: true });
    const keys = child.calls.map((c) => c.key);
    const setupCall = child.calls.find((c) => c.key.includes('\0setup\0'));
    const probeCall = child.calls.find((c) => c.key.includes('\0--\0'));
    expect(setupCall, '先 setup').toBeTruthy();
    expect(probeCall, '再试跑').toBeTruthy();
    expect(keys.indexOf(setupCall!.key)).toBeLessThan(keys.indexOf(probeCall!.key));
    expect(
      setupCall!.key.endsWith(`|sandbox\0setup\0--elevated\0--current-user\0--codex-home\0${home}`),
    ).toBe(true);
    expect(
      probeCall!.key.endsWith(
        `|-c\0windows.sandbox="elevated"\0sandbox\0--permission-profile\0ixaeon\0-C\0${probe}\0--\0cmd\0/c\0echo ixaeon-sandbox-auth-ok`,
      ),
    ).toBe(true);
    expect(setupCall!.env?.CODEX_HOME).toBe(home);
    expect(probeCall!.env?.CODEX_HOME).toBe(home);
    const record = JSON.parse(readFileSync(join(home, 'ixaeon-sandbox-auth.json'), 'utf8')) as {
      codexVersion: string;
    };
    expect(record.codexVersion).toBe('9.9.9');
    // Codex 装好时会写 setup 标记；摆上之后检查应当是 ok
    mkdirSync(join(home, '.sandbox'), { recursive: true });
    writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}');
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
  });

  it('setup 退出非 0：unauthorized、没起试跑、没写记录', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    const exe = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), '9.9.9');
    const dataDir = temp('ixa-v4n-data-');
    const home = join(dataDir, 'codex-sandbox-home');
    child.scripts.set(
      child.key(exe, ['sandbox', 'setup', '--elevated', '--current-user', '--codex-home', home]),
      {
        code: 1,
        stdout: '',
        stderr: '替身：setup 失败\n',
      },
    );
    expect(await requestSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'unauthorized' });
    expect(child.calls.some((c) => c.key.includes('\0--\0'))).toBe(false);
    expect(() => readFileSync(join(home, 'ixaeon-sandbox-auth.json'))).toThrow();
  });

  it('试跑退出非 0、或输出里没有那串标记：unauthorized、没写记录', async () => {
    for (const [name, script] of [
      ['退出非 0', { code: 1, stdout: '', stderr: '替身：试跑失败\n' }],
      ['输出没有标记', { code: 0, stdout: '别的输出\n', stderr: '' }],
    ] as const) {
      const local = temp('ixa-v4n-local-');
      process.env.LOCALAPPDATA = local;
      const exe = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), '9.9.9');
      const dataDir = temp('ixa-v4n-data-');
      const home = join(dataDir, 'codex-sandbox-home');
      child.scripts.set(
        child.key(exe, ['sandbox', 'setup', '--elevated', '--current-user', '--codex-home', home]),
        {
          code: 0,
          stdout: '',
          stderr: '',
        },
      );
      child.scripts.set(
        child.key(exe, [
          '-c',
          'windows.sandbox="elevated"',
          'sandbox',
          '--permission-profile',
          'ixaeon',
          '-C',
          join(home, 'auth-probe'),
          '--',
          'cmd',
          '/c',
          'echo ixaeon-sandbox-auth-ok',
        ]),
        script,
      );
      expect(await requestSandboxAuth(dataDir), name).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
      expect(() => readFileSync(join(home, 'ixaeon-sandbox-auth.json')), name).toThrow();
    }
  });

  it('没有 Codex / 不是 Windows / 问不出版本：一个装的子进程都没起', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    const blank = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), null);
    const dataDir = temp('ixa-v4n-data-');
    // 问不出版本（没指定、只有它一个 → codex_missing）
    expect(await requestSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'codex_missing' });
    expect(child.calls.every((c) => c.key.endsWith('|--version'))).toBe(true);
    // 指定了、问不出版本 → unauthorized，也不起
    process.env.IXAEON_CODEX_EXE = blank;
    expect(await requestSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'unauthorized' });
    expect(child.calls.every((c) => c.key.endsWith('|--version'))).toBe(true);
    // 不是 Windows：连版本都不问
    expect(await requestSandboxAuth(dataDir, { platform: 'linux' } as never)).toEqual({
      ok: false,
      reason: 'unsupported_platform',
    });
    expect(child.calls.every((c) => c.key.endsWith('|--version'))).toBe(true);
    // 没有 Codex：什么都不起
    process.env.IXAEON_CODEX_EXE = 'none';
    expect(await requestSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'codex_missing' });
    const after = child.calls.length;
    process.env.IXAEON_CODEX_EXE = 'none';
    expect(await requestSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'codex_missing' });
    expect(child.calls.length).toBe(after);
  });
});

describe('条件 5：依赖档派生（新版 argv 与 config.toml）', () => {
  function tierHarness() {
    const root = temp('ixa-v4n-proj-');
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
    const copy = temp('ixa-v4n-copy-');
    const dataDir = temp('ixa-v4n-data-');
    const spawned: Array<{ cmd: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } }> = [];
    const check = defaultCheck as unknown as (
      argv: string[],
      cwd: string,
      signal?: AbortSignal,
      runAsNode?: unknown,
      versions?: unknown,
      context?: unknown,
    ) => Promise<IndependentCheck>;
    return { root, copy, dataDir, spawned, check };
  }

  it('授权过了：argv 正好是契约 3.4 那一串，codex.exe 是最新版；config.toml 有 3.3 的每一条', async () => {
    const local = temp('ixa-v4n-local-');
    process.env.LOCALAPPDATA = local;
    fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), '0.10.0');
    const newest = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), '0.11.0');
    const { root, copy, dataDir, spawned, check } = tierHarness();
    await check(['ixaeon:vitest', 'run', 'src/a.test.ts'], copy, undefined, undefined, undefined, {
      projectRoot: root,
      dataDir,
      checkAuth: async () => ({ ok: true }),
      spawnCommand: async (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        spawned.push({ cmd, args, opts });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe(newest);
    const node = process.execPath;
    expect(spawned[0]!.args).toEqual([
      '-c',
      'windows.sandbox="elevated"',
      'sandbox',
      '--permission-profile',
      'ixaeon',
      '-C',
      copy,
      '--',
      node,
      join(copy, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--config-loader',
      'runner',
      '--no-cache',
      'src/a.test.ts',
    ]);
    expect(spawned[0]!.opts.env?.CODEX_HOME).toBe(join(dataDir, 'codex-sandbox-home'));
    const toml = readFileSync(join(dataDir, 'codex-sandbox-home', 'config.toml'), 'utf8');
    expect(toml).toContain('[permissions.ixaeon]');
    expect(toml).toContain('[permissions.ixaeon.workspace_roots]');
    expect(toml).toContain(`"${copy.replaceAll('\\', '/')}" = true`);
    expect(toml).toContain('[permissions.ixaeon.filesystem]');
    expect(toml).toContain('":root" = "read"');
    expect(toml).toContain(`"${copy.replaceAll('\\', '/').replace(/\/$/, '')}/**" = "write"`);
    // 依赖只读：realDeps 是项目根里的 node_modules（prepareDependencyCopy 记的）
    expect(toml).toContain(`"${root.replaceAll('\\', '/')}/node_modules/**" = "read"`);
    expect(toml).toContain('[permissions.ixaeon.network]');
    expect(toml).toContain('enabled = false');
    expect(toml).toContain('[shell_environment_policy]');
    expect(toml).toContain('inherit = "all"');
    expect(toml).toContain('[windows]');
    expect(toml).toContain('sandbox = "elevated"');
    expect(toml).not.toContain('default_permissions');
    // 写权限只有副本一条
    const writeLines = toml.split('\n').filter((l) => l.includes(' = "write"'));
    expect(writeLines).toEqual([`"${copy.replaceAll('\\', '/').replace(/\/$/, '')}/**" = "write"`]);
  });

  it('派生之前 Codex 找不到了：不派生，照 codex_missing 那句回、ran=false', async () => {
    process.env.IXAEON_CODEX_EXE = 'none';
    const { root, copy, dataDir, spawned, check } = tierHarness();
    const result = await check(
      ['ixaeon:vitest', 'run', 'src/a.test.ts'],
      copy,
      undefined,
      undefined,
      undefined,
      {
        projectRoot: root,
        dataDir,
        checkAuth: async () => ({ ok: true }),
        spawnCommand: async (cmd: string, args: string[]) => {
          spawned.push({ cmd, args, opts: {} });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(result.ran).toBe(false);
    expect(result.output).toBe(CODEX_MISSING);
    expect(spawned).toEqual([]);
  });
});

describe('条件 6：没跑成的原因说人话（逐字）', () => {
  function tierFor(reason: 'unauthorized' | 'codex_missing' | 'unsupported_platform') {
    const root = temp('ixa-v4n-proj-');
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
    const copy = temp('ixa-v4n-copy-');
    const dataDir = temp('ixa-v4n-data-');
    const spawned: string[] = [];
    const check = defaultCheck as unknown as (
      argv: string[],
      cwd: string,
      signal?: AbortSignal,
      runAsNode?: unknown,
      versions?: unknown,
      context?: unknown,
    ) => Promise<IndependentCheck>;
    return check(['ixaeon:vitest', 'run', 'src/a.test.ts'], copy, undefined, undefined, undefined, {
      projectRoot: root,
      dataDir,
      checkAuth: async () => ({ ok: false, reason }),
      spawnCommand: async (cmd: string) => {
        spawned.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }).then((r) => ({ r, spawned }));
  }

  it('三种原因各是契约 3.7 表里那一句、ran=false、没有派生', async () => {
    const a = await tierFor('unauthorized');
    expect(a.r).toEqual({
      argv: ['ixaeon:vitest', 'run', 'src/a.test.ts'],
      exitCode: null,
      output: UNAUTHORIZED,
      ran: false,
    });
    expect(a.spawned).toEqual([]);
    const b = await tierFor('codex_missing');
    expect(b.r.output).toBe(CODEX_MISSING);
    expect(b.r.ran).toBe(false);
    expect(b.spawned).toEqual([]);
    const c = await tierFor('unsupported_platform');
    expect(c.r.output).toBe(UNSUPPORTED);
    expect(c.r.ran).toBe(false);
    expect(c.spawned).toEqual([]);
  });
});
