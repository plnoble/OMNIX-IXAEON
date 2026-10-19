/**
 * V4 验收（规格 docs/委派/V4-依赖档验证的授权入口.md，条件 1–5 的核心层部分）。
 * 先测试后实现：这些测试在实现写出来之前是红的。
 *
 * 钉住的接缝（名字由实现定，这里按这个名字 import；实现换了名字改这一处 import，条件不变）：
 * - `findLatestCodex(): Promise<{ exe: string; version: string | null } | null>`
 *   （`version` 只有在用 IXAEON_CODEX_EXE 指定、它又问不出版本号时才是 null）
 *   —— 沙箱这边每次查授权之前现找的那个办法（契约 3.1）。`resolveCodexLocator`（执行器，
 *   同步，应用启动时找一次）找到的必须是同一个文件。
 *
 * 子进程一律用替身，本文件不碰真的 Codex，也不让 `requestSandboxAuth` 真的提权：
 * 替身按「exe|参数」回话，没登记的命令回一个失败码（不会挂住）。
 *
 * 条件 1：合成 LOCALAPPDATA 下顶层 0.10.0、两个子目录 0.9.0 和 0.11.0 → 找到说 0.11.0 的
 *   （按数字比，0.11 比 0.9 大）；问不出版本号的不算；顶层没有、只有子目录里有，照样找得到；
 *   一个都没有是没有 Codex。IXAEON_CODEX_EXE 指向一个文件：用它，别的候选一个都不问；
 *   设成 none：没有 Codex。执行器、沙箱检查、发起授权找到的是同一个文件。
 *   （「执行器在应用启动时找一次，之后判断有没有 Codex 不再问版本」在
 *   apps/desktop/test/acceptance/v4-verify-sandbox.test.ts 里，那要真的起一次运行时。）
 * 条件 3：四样（cap_sid 三类、版本配对的 helper、setup 标记、服务 RUNNING）齐了是 ok；
 *   缺任何一样是 unauthorized；codex --version 说不出版本号：指定了的那个是 unauthorized，
 *   没指定、又只有它一个是 codex_missing（整合方锁定前定，见下面那条的注释）；
 *   不是 Windows 是 unsupported_platform。checkSandboxAuth 不往数据目录写任何东西。
 * 条件 4：`findLatestCodex().version` 就是 `codex --version` 里的版本号，而且和授权检查
 *   用的是同一个 Codex；没有 Codex 是 null。
 * 条件 5：三种授权没过，验证输出是契约 3.4 那一句（逐字）、ran 是 false、没有派生任何
 *   子进程去跑测试。（回报里那一行「验证没跑：」接这一句在桌面那份测试里。）
 * 条件 2（不许用 spawnSync）在 v4-sandbox-async.test.ts：那一份把 spawnSync 换成一调就抛错的替身。
 *
 * 版本号用合成的（9.9.9 之类），路径用临时目录。
 *
 * 整合方 2026-10-19 锁定前改了：子进程替身换成共用的 v4-child-double.ts（原来的不认
 * promisify(execFile)，实现换种异步写法就过不了）；「问不出版本号」那一条见它的注释。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import type { IndependentCheck } from '../../src/execution/executor.js';

const child = vi.hoisted(() => ({
  scripts: new Map<string, { code: number; stdout: string; stderr: string }>(),
  sync: [] as string[],
  async: [] as string[],
  key: (exe: unknown, args: unknown) =>
    `${String(exe)}|${(Array.isArray(args) ? args : []).map(String).join('\0')}`,
}));

// 子进程替身（整合方 2026-10-19 统一成一份，见 v4-child-double.js）
vi.mock('node:child_process', async (importOriginal) => {
  const { childProcessDouble } = await import('./v4-child-double.js');
  return childProcessDouble(await importOriginal<typeof ChildProcess>(), child);
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
  child.sync.length = 0;
  child.async.length = 0;
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

/** 合成的 codex.exe：空文件一个；问版本时替身照 version 回话。version=null 表示问不出来。 */
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

/** sc query 那一条（async 与 sync 都登记，实现用哪种都能回话）。 */
function answerService(running: boolean): void {
  const out = running ? 'STATE              : 4  RUNNING\n' : 'STATE              : 1  STOPPED\n';
  for (const exe of ['sc', 'sc.exe']) {
    child.scripts.set(child.key(exe, ['query', 'CodexSandboxService.OpenAI.Codex']), {
      code: running ? 0 : 1,
      stdout: out,
      stderr: '',
    });
  }
}

/** 四样齐全的数据目录与 LOCALAPPDATA；返回用的那个 exe。 */
function authorized(version = '9.9.9'): { dataDir: string; exe: string; home: string } {
  const local = temp('ixa-v4-local-');
  process.env.LOCALAPPDATA = local;
  const exe = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), version);
  const dataDir = temp('ixa-v4-data-');
  const home = join(dataDir, 'codex-sandbox-home');
  mkdirSync(join(home, '.sandbox-bin'), { recursive: true });
  mkdirSync(join(home, '.sandbox'), { recursive: true });
  writeFileSync(
    join(home, 'cap_sid'),
    JSON.stringify({ workspace: 'S-1', readonly: 'S-2', workspace_by_cwd: { 'D:/x': 'S-3' } }),
  );
  writeFileSync(join(home, '.sandbox-bin', `codex-command-runner-${version}.exe`), '');
  writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}');
  answerService(true);
  return { dataDir, exe, home };
}

const UNAUTHORIZED =
  '这台机器还没给 Codex 沙箱授权，依赖档验证跑不了：到设置页「依赖档验证」点「授权」。授权之后新派的任务才会跑这一档验证。';
const CODEX_MISSING = '没找到 Codex 命令行，依赖档验证跑不了（这一档要用 Codex 的沙箱）。';
const UNSUPPORTED = '依赖档验证只在 Windows 上跑得了。';

describe('条件 1：找 Codex 只有一套，取最新版', () => {
  it('顶层 0.10.0、子目录 0.9.0 和 0.11.0：找到说 0.11.0 的（按数字比，0.11 比 0.9 大）', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    const top = fakeCodex(bin, '0.10.0');
    fakeCodex(join(bin, 'hash-old'), '0.9.0');
    const newest = fakeCodex(join(bin, 'hash-new'), '0.11.0');

    const found = await findLatestCodex();
    expect(found?.exe).toBe(newest);
    expect(found?.version).toBe('0.11.0');
    expect(resolveCodexLocator()?.exe).toBe(newest);
    expect(resolveCodexLocator()?.exe).not.toBe(top);
  });

  it('问不出版本号的不算；顶层没有、只有子目录里有，照样找得到', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    fakeCodex(join(bin, 'hash-blank'), null);
    const only = fakeCodex(join(bin, 'hash-only'), '9.9.9');

    expect((await findLatestCodex())?.exe).toBe(only);
    expect(resolveCodexLocator()?.exe).toBe(only);
  });

  it('一个候选都没有：没有 Codex', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    mkdirSync(join(local, 'OpenAI', 'Codex', 'bin'), { recursive: true });

    expect(await findLatestCodex()).toBeNull();
    expect(resolveCodexLocator()).toBeNull();
  });

  it('IXAEON_CODEX_EXE 指向一个文件：用它，别的候选一个都不问', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    const pinned = fakeCodex(temp('ixa-v4-pinned-'), '1.0.0');
    fakeCodex(join(local, 'OpenAI', 'Codex', 'bin', 'hash-new'), '9.9.9');
    process.env.IXAEON_CODEX_EXE = pinned;
    const asked = child.async.length + child.sync.length;

    expect((await findLatestCodex())?.exe).toBe(pinned);
    expect(resolveCodexLocator()?.exe).toBe(pinned);
    // 指定了就不再问 bin 下那些候选的版本
    const after = [...child.sync, ...child.async].slice(asked);
    expect(after.some((k) => k.includes('hash-new'))).toBe(false);
  });

  it('IXAEON_CODEX_EXE=none：没有 Codex（沙箱是 codex_missing）', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), '9.9.9');
    process.env.IXAEON_CODEX_EXE = 'none';
    const dataDir = temp('ixa-v4-data-');

    expect(await findLatestCodex()).toBeNull();
    expect(resolveCodexLocator()).toBeNull();
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'codex_missing' });
  });

  it('执行器、沙箱检查、发起授权找到的是同一个文件', async () => {
    const { dataDir, exe } = authorized('0.11.0');
    const local = process.env.LOCALAPPDATA!;
    const top = fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), '0.10.0');
    const asked = child.sync.length + child.async.length;

    // 检查：helper 是按 0.11.0 命名的，只有用了最新版那个才可能 ok
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(resolveCodexLocator()?.exe).toBe(exe);

    // 发起授权：替身不给成功回话，它自己收尾；只核对它用的是哪个 exe
    await requestSandboxAuth(dataDir);
    const after = [...child.sync, ...child.async].slice(asked);
    const sandboxCommands = after.filter((k) => k.includes('sandbox\0windows'));
    expect(sandboxCommands.length).toBeGreaterThan(0);
    expect(sandboxCommands.every((k) => k.startsWith(`${exe}|`))).toBe(true);
    expect(sandboxCommands.some((k) => k.startsWith(`${top}|`))).toBe(false);
  });
});

describe('条件 3：检查口径不变', () => {
  it('四样齐了是 ok', async () => {
    const { dataDir } = authorized();
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
  });

  it('缺任何一样是 unauthorized', async () => {
    for (const drop of ['cap', 'helper', 'marker', 'service'] as const) {
      const { dataDir, home } = authorized();
      if (drop === 'cap') rmSync(join(home, 'cap_sid'));
      if (drop === 'helper') rmSync(join(home, '.sandbox-bin'), { recursive: true });
      if (drop === 'marker') rmSync(join(home, '.sandbox', 'setup_marker.json'));
      if (drop === 'service') answerService(false);
      expect(await checkSandboxAuth(dataDir), `缺了 ${drop}`).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    }
  });

  it('cap_sid 缺三类里的任何一类是 unauthorized', async () => {
    for (const missing of ['workspace', 'readonly', 'workspace_by_cwd']) {
      const { dataDir, home } = authorized();
      const cap = {
        workspace: 'S-1',
        readonly: 'S-2',
        workspace_by_cwd: { 'D:/x': 'S-3' },
      } as Record<string, unknown>;
      delete cap[missing];
      writeFileSync(join(home, 'cap_sid'), JSON.stringify(cap));
      expect(await checkSandboxAuth(dataDir), `缺 ${missing}`).toEqual({
        ok: false,
        reason: 'unauthorized',
      });
    }
  });

  // 整合方锁定前改（2026-10-19）：规格条件 3 的「说不出版本号是 unauthorized」和契约 3.1 的
  // 「问不出版本号的不算」原来对不上（只有这一个 Codex 时它就不算了）。定：用 IXAEON_CODEX_EXE
  // 指定了的那个问不出版本号 → unauthorized（它在，只是配不上授权）；没指定时问不出版本号的候选
  // 不算，一个都不剩就是 codex_missing。
  it('codex --version 说不出版本号：没指定、只有它一个是 codex_missing；指定了的是 unauthorized', async () => {
    const { dataDir, exe } = authorized();
    child.scripts.set(child.key(exe, ['--version']), {
      code: 0,
      stdout: 'codex-cli\n',
      stderr: '',
    });
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'codex_missing' });
    process.env.IXAEON_CODEX_EXE = exe;
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('不是 Windows 是 unsupported_platform', async () => {
    const dataDir = temp('ixa-v4-data-');
    expect(await checkSandboxAuth(dataDir, { platform: 'linux' })).toEqual({
      ok: false,
      reason: 'unsupported_platform',
    });
  });

  // 整合方锁定前改（2026-10-19）：原来这一条用的是本机真的 LOCALAPPDATA，替身问不出版本号，
  // 检查在「没找到 Codex」那一步就收尾了，根本走不到会写东西的地方（往数据目录里建目录的
  // 实现照样过）。改成 Codex 在、检查一路走到底的两种情况。
  it('checkSandboxAuth 不往数据目录写任何东西（没授权、授权了都一样）', async () => {
    const listAll = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();
    // 没授权：Codex 在，数据目录是空的
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    fakeCodex(join(local, 'OpenAI', 'Codex', 'bin'), '9.9.9');
    answerService(true);
    const empty = temp('ixa-v4-data-');
    expect(await checkSandboxAuth(empty)).toEqual({ ok: false, reason: 'unauthorized' });
    expect(readdirSync(empty)).toEqual([]);
    // 授权了：四样齐全，查完一个文件不多、一个不少
    const { dataDir } = authorized();
    const before = listAll(dataDir);
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(listAll(dataDir)).toEqual(before);
  });
});

describe('条件 4：版本号和授权检查用同一个 Codex', () => {
  it('返回 codex --version 里的版本号（含预发布后缀）；没有 Codex 是 null', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    fakeCodex(bin, '0.10.0');
    const newest = fakeCodex(join(bin, 'hash-new'), '0.11.0-alpha.5');

    const found = await findLatestCodex();
    expect(found?.exe).toBe(newest);
    expect(found?.version).toBe('0.11.0-alpha.5');

    // 检查配对的 helper 用的就是这个版本号
    const { dataDir, home } = authorized('0.11.0-alpha.5');
    child.scripts.set(child.key(newest, ['--version']), {
      code: 0,
      stdout: 'codex-cli 0.11.0-alpha.5\n',
      stderr: '',
    });
    expect(await checkSandboxAuth(dataDir)).toEqual({ ok: true });
    expect(readdirSync(join(home, '.sandbox-bin'))).toEqual([
      'codex-command-runner-0.11.0-alpha.5.exe',
    ]);

    process.env.IXAEON_CODEX_EXE = 'none';
    expect(await findLatestCodex()).toBeNull();
  });
});

describe('条件 5：没跑成的原因说人话', () => {
  /** 一个装了 vitest 的合成项目 + 一份副本；验证命令是依赖档伪命令。 */
  function tier() {
    const root = temp('ixa-v4-proj-');
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
    const copy = temp('ixa-v4-copy-');
    const dataDir = temp('ixa-v4-data-');
    const spawned: string[] = [];
    const check = defaultCheck as unknown as (
      argv: string[],
      cwd: string,
      signal?: AbortSignal,
      runAsNode?: unknown,
      versions?: unknown,
      context?: unknown,
    ) => Promise<IndependentCheck>;
    const verify = (reason: string) =>
      check(['ixaeon:vitest', 'run', 'src/a.test.ts'], copy, undefined, undefined, undefined, {
        projectRoot: root,
        dataDir,
        checkAuth: async () => ({ ok: false, reason }),
        spawnCommand: async (cmd: string) => {
          spawned.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
    return { verify, spawned };
  }

  it('unauthorized：契约 3.4 那一句（逐字）、ran 是 false、没有派生', async () => {
    const { verify, spawned } = tier();
    const result = await verify('unauthorized');
    expect(result.ran).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toBe(UNAUTHORIZED);
    expect(spawned).toEqual([]);
  });

  it('codex_missing：契约 3.4 那一句（逐字）', async () => {
    const { verify, spawned } = tier();
    const result = await verify('codex_missing');
    expect(result.ran).toBe(false);
    expect(result.output).toBe(CODEX_MISSING);
    expect(spawned).toEqual([]);
  });

  it('unsupported_platform：契约 3.4 那一句（逐字）', async () => {
    const { verify, spawned } = tier();
    const result = await verify('unsupported_platform');
    expect(result.ran).toBe(false);
    expect(result.output).toBe(UNSUPPORTED);
    expect(spawned).toEqual([]);
  });

  // 整合方锁定前补（2026-10-19）：契约 3.1 说依赖档验证派生时用的 codex.exe 也要用新的找法，
  // 原来没有测试照到这一步（派生还用旧的找法——取顶层那个——照样全绿）。
  it('条件 1（依赖档派生）：授权过了，真去跑测试时用的也是最新版的 Codex', async () => {
    const local = temp('ixa-v4-local-');
    process.env.LOCALAPPDATA = local;
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    fakeCodex(bin, '0.10.0');
    const newest = fakeCodex(join(bin, 'hash-new'), '0.11.0');
    const root = temp('ixa-v4-proj-');
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
    const copy = temp('ixa-v4-copy-');
    const dataDir = temp('ixa-v4-data-');
    const spawned: string[] = [];
    const check = defaultCheck as unknown as (
      argv: string[],
      cwd: string,
      signal?: AbortSignal,
      runAsNode?: unknown,
      versions?: unknown,
      context?: unknown,
    ) => Promise<IndependentCheck>;
    await check(['ixaeon:vitest', 'run', 'src/a.test.ts'], copy, undefined, undefined, undefined, {
      projectRoot: root,
      dataDir,
      checkAuth: async () => ({ ok: true }),
      spawnCommand: async (cmd: string) => {
        spawned.push(cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(spawned).toEqual([newest]);
  });
});
