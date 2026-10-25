/**
 * V4 验收（规格 docs/委派/V4-依赖档验证的授权入口-新版沙箱.md，条件 6 的回报那一行、7、8、9、10）。
 * 先测试后实现：这些测试在实现写出来之前是红的。
 *
 * 只查不弹（条件 10）：`AppRuntime.getVerifySandbox()` 返回 `{ status, codexVersion }`，
 *   四种状态各一条；没调 `requestSandboxAuth`，没记审计，数据目录里没有多出文件。
 * 发起授权（条件 10）：`AppRuntime.authorizeVerifySandbox()` 先调一次 `requestSandboxAuth`
 *   （参数是数据目录），再调 `checkSandboxAuth`，返回后者的结果；审计
 *   `verify_sandbox.authorize` 一条，内容 `{ status }`。
 * 别处不弹（条件 10）：只有那个按钮会调 `requestSandboxAuth`——派一个依赖档的任务、
 *   跑完验证，它一次都没被调。
 * IPC（条件 10）：`registerIpc` 注册的 `getVerifySandbox`、`authorizeVerifySandbox`
 *   调的是运行时上的方法，返回的和它一样。
 * 条件 5 的回报那一行：验证输出换成契约 3.4 的人话之后，回报里仍是
 *   「验证没跑：」接这一句。
 *
 * 本文件里 `requestSandboxAuth` 一律是替身（记下调用、不真的弹管理员确认）；
 * `checkSandboxAuth` 默认走真的，要造某个状态时用 `sandbox.override` 顶一次。
 * 条件 1 的「应用启动时找一次」在 v4-codex-startup.test.ts。
 *
 * 整合方 2026-10-19 锁定前改了：子进程替身换成共用的 v4-child-double.ts；IPC 那一条原来数
 * 运行时方法被调了几次，「发起授权」里面再查一次就会多数一次——那是实现的写法，不是条件。
 * 改成给两个方法各顶一个独有的返回值，核对 IPC 原样转回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ChildProcess from 'node:child_process';
import type { CoreDatabase } from '@ixaeon/core';
import type { TaskReportRow } from '../../src/main/taskReport.js';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '', getAppPath: () => '' },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

/** 授权发起与检查的口子：request 永远走替身；check 默认走真的，override 时顶一次。 */
const sandbox = vi.hoisted(() => ({
  requests: [] as string[],
  order: [] as string[],
  authResult: { ok: true } as { ok: boolean; reason?: string },
  override: null as { ok: boolean; reason?: string } | null,
}));

vi.mock('../../../../packages/core/src/execution/verifySandbox.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkSandboxAuth: async (dataDir: string, env?: unknown) => {
      sandbox.order.push('check');
      if (sandbox.override) return sandbox.override;
      return (actual['checkSandboxAuth'] as (d: string, e?: unknown) => Promise<unknown>)(
        dataDir,
        env,
      );
    },
    // 会弹管理员确认：测试里一律不真的调
    requestSandboxAuth: async (dataDir: string) => {
      sandbox.order.push('request');
      sandbox.requests.push(dataDir);
      return sandbox.authResult;
    },
  };
});

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
const { registerIpc } = await import('../../src/main/ipc.js');
const { buildTaskReport } = await import('../../src/main/taskReport.js');
const { CodingOrchestrator, FakeCodingExecutor, migrate, openDatabase, ProjectService } =
  await import('@ixaeon/core');

const UNAUTHORIZED =
  '这台机器还没给 Codex 沙箱授权，依赖档验证跑不了：到设置页「依赖档验证」点「授权」。授权之后新派的任务才会跑这一档验证。';
const CODEX_MISSING = '没找到 Codex 命令行，依赖档验证跑不了（这一档要用 Codex 的沙箱）。';
const UNSUPPORTED = '依赖档验证只在 Windows 上跑得了。';

const dirs: string[] = [];
const opened: CoreDatabase[] = [];
const saved = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  IXAEON_CODEX_EXE: process.env.IXAEON_CODEX_EXE,
};

beforeEach(() => {
  sandbox.requests.length = 0;
  sandbox.order.length = 0;
  sandbox.override = null;
  sandbox.authResult = { ok: true };
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
  // 先关库再删目录：SQLite 开着的时候删不掉（Windows 上是 EPERM）
  for (const db of opened.splice(0)) {
    try {
      if (db.open) db.close();
    } catch {
      // 收尾失败不影响断言
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 一台机器上装着 Codex（合成空文件）+ 一个数据目录；authorize 决定沙箱装没装。 */
function machine(version = '9.9.9', opts: { authorized?: boolean } = {}) {
  const local = temp('ixa-v4-local-');
  process.env.LOCALAPPDATA = local;
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, 'codex.exe');
  writeFileSync(exe, '');
  child.scripts.set(child.key(exe, ['--version']), {
    code: 0,
    stdout: `codex-cli ${version}\n`,
    stderr: '',
  });
  const dataDir = temp('ixa-v4-data-');
  const home = join(dataDir, 'codex-sandbox-home');
  if (opts.authorized !== false) {
    mkdirSync(join(home, '.sandbox-bin'), { recursive: true });
    mkdirSync(join(home, '.sandbox'), { recursive: true });
    writeFileSync(
      join(home, 'cap_sid'),
      JSON.stringify({ workspace: 'S-1', readonly: 'S-2', workspace_by_cwd: { 'D:/x': 'S-3' } }),
    );
    writeFileSync(join(home, '.sandbox-bin', `codex-command-runner-${version}.exe`), '');
    writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}');
    for (const sc of ['sc', 'sc.exe']) {
      child.scripts.set(child.key(sc, ['query', 'CodexSandboxService.OpenAI.Codex']), {
        code: 0,
        stdout: 'STATE              : 4  RUNNING\n',
        stderr: '',
      });
    }
  }
  return { dataDir, home, exe };
}

/** 打开并记一笔：afterEach 会先关库再删目录。 */
function openDb(dataDir: string): CoreDatabase {
  const db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  opened.push(db);
  return db;
}

/** 轻量运行时：只给这两个方法要用的字段（db 与数据目录）。 */
function runtime(dataDir: string) {
  const db = openDb(dataDir);
  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['db'] = db;
  rt['dataDir'] = dataDir;
  return {
    rt: rt as unknown as AppRuntime & {
      getVerifySandbox(): Promise<{ status: string; codexVersion: string | null }>;
      authorizeVerifySandbox(): Promise<{ status: string; codexVersion: string | null }>;
    },
    db,
  };
}

const audits = (db: CoreDatabase, kind: string) =>
  (
    db
      .prepare('SELECT detail_json FROM audit_events WHERE kind = ? ORDER BY created_at')
      .all(kind) as Array<{
      detail_json: string;
    }>
  ).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);

describe('条件 6：只查不弹', () => {
  it('已授权：status=ok、codexVersion 是那个版本；没发起授权、没记审计、数据目录没多出文件', async () => {
    const { dataDir } = machine('9.9.9');
    const { rt, db } = runtime(dataDir);
    const before = readdirSync(dataDir).sort();

    const view = await rt.getVerifySandbox();

    expect(view).toEqual({ status: 'ok', codexVersion: '9.9.9' });
    expect(sandbox.requests).toEqual([]);
    expect(audits(db, 'verify_sandbox.authorize')).toEqual([]);
    expect(readdirSync(dataDir).sort()).toEqual(before);
  });

  it('没授权：status=unauthorized，版本号照给', async () => {
    const { dataDir } = machine('9.9.9', { authorized: false });
    const { rt, db } = runtime(dataDir);

    expect(await rt.getVerifySandbox()).toEqual({
      status: 'unauthorized',
      codexVersion: '9.9.9',
    });
    expect(sandbox.requests).toEqual([]);
    expect(audits(db, 'verify_sandbox.authorize')).toEqual([]);
  });

  it('没找到 Codex：status=codex_missing、版本号是 null', async () => {
    const { dataDir } = machine('9.9.9');
    process.env.IXAEON_CODEX_EXE = 'none';
    const { rt } = runtime(dataDir);

    expect(await rt.getVerifySandbox()).toEqual({ status: 'codex_missing', codexVersion: null });
    expect(sandbox.requests).toEqual([]);
  });

  it('不是 Windows：status=unsupported_platform', async () => {
    const { dataDir } = machine('9.9.9');
    process.env.IXAEON_CODEX_EXE = 'none';
    sandbox.override = { ok: false, reason: 'unsupported_platform' };
    const { rt } = runtime(dataDir);

    expect(await rt.getVerifySandbox()).toEqual({
      status: 'unsupported_platform',
      codexVersion: null,
    });
    expect(sandbox.requests).toEqual([]);
  });
});

describe('条件 7：发起授权', () => {
  it('先发起、再查一遍，返回查到的那个；说成了但再查是没授权，就是没授权；审计一条', async () => {
    const { dataDir } = machine('9.9.9', { authorized: false });
    const { rt, db } = runtime(dataDir);
    sandbox.authResult = { ok: true };

    const view = await rt.authorizeVerifySandbox();

    expect(sandbox.requests).toEqual([dataDir]);
    expect(sandbox.order).toEqual(['request', 'check']);
    expect(view).toEqual({ status: 'unauthorized', codexVersion: '9.9.9' });
    expect(audits(db, 'verify_sandbox.authorize')).toEqual([{ status: 'unauthorized' }]);
  });

  it('授权成了、再查也确实好了：status=ok，审计记查到的那个状态', async () => {
    const { dataDir } = machine('9.9.9');
    const { rt, db } = runtime(dataDir);

    const view = await rt.authorizeVerifySandbox();

    expect(view).toEqual({ status: 'ok', codexVersion: '9.9.9' });
    expect(sandbox.requests).toEqual([dataDir]);
    expect(audits(db, 'verify_sandbox.authorize')).toEqual([{ status: 'ok' }]);
  });
});

describe('条件 8：别处不弹', () => {
  it('派一个依赖档的任务、跑完验证：requestSandboxAuth 一次都没被调；那一行是人话', async () => {
    // 这台机器既没授权、也没有 Codex（IXAEON_CODEX_EXE=none）：验证该停在「这一档跑不了」
    const { dataDir } = machine('9.9.9', { authorized: false });
    process.env.IXAEON_CODEX_EXE = 'none';
    const db = openDb(dataDir);
    const projectRoot = temp('ixa-v4-proj-');
    mkdirSync(join(projectRoot, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
    writeFileSync(join(projectRoot, 'note.txt'), '合成项目文件\n');
    const project = new ProjectService(db).create({
      name: '合成项目',
      rootPath: projectRoot,
      description: null,
    });
    const coding = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ files: { 'note.txt': '改过\n' } }),
      dataDir,
    );
    const task = coding.create({
      projectId: project.id,
      goal: '把依赖档跑一遍',
      scope: ['note.txt'],
      allowedCommands: [['ixaeon:vitest', 'run', 'note.test.ts']],
    });
    await coding.approveAndQueue(task.id);
    await coding.dispatch(task.id);

    const row = db.prepare('SELECT * FROM coding_tasks WHERE id = ?').get(task.id) as TaskReportRow;
    expect(row.verify_status).toBe('not_run');
    expect(row.verify_output).toBe(CODEX_MISSING);
    expect(sandbox.requests).toEqual([]);
    // 没有派生任何子进程去跑沙箱/验证；也没有那一次「发起授权」的探针
    const all = [...child.async, ...child.sync];
    expect(all.some((k) => k.includes('ixaeon-sandbox-auth-ok'))).toBe(false);
    expect(all.some((k) => k.includes('sandbox\0windows'))).toBe(false);
    expect(all.some((k) => k.includes('vitest.mjs'))).toBe(false);
    // 报告里那一行照旧是「验证没跑：」接这一句
    expect(buildTaskReport(row)!.content).toContain(`验证没跑：${CODEX_MISSING}`);
  });
});

describe('条件 9：IPC', () => {
  it('registerIpc 注册的两个通道调的是运行时上的方法，返回的一样', async () => {
    const { dataDir } = machine('9.9.9');
    const { rt } = runtime(dataDir);
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(rt);
    // 两个独有的返回值：IPC 原样转回来，才说明它调的是运行时上的方法
    const viaRuntimeGet = { status: 'unsupported_platform', codexVersion: '1.2.3' } as const;
    const viaRuntimeAuth = { status: 'unauthorized', codexVersion: '4.5.6' } as const;
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const getEntry = calls.find(([channel]) => channel === 'ixaeon:getVerifySandbox');
    const authEntry = calls.find(([channel]) => channel === 'ixaeon:authorizeVerifySandbox');
    if (!getEntry) throw new Error('没有注册 IPC：getVerifySandbox');
    if (!authEntry) throw new Error('没有注册 IPC：authorizeVerifySandbox');

    // 先走一遍真的：IPC 和直接调得到的一样
    expect(await getEntry[1]({} as never)).toEqual(await rt.getVerifySandbox());
    expect(await getEntry[1]({} as never)).toEqual({ status: 'ok', codexVersion: '9.9.9' });

    // 再顶上独有的返回值：IPC 转回来的就是它
    const getSpy = vi.spyOn(rt, 'getVerifySandbox').mockResolvedValue(viaRuntimeGet);
    const authSpy = vi.spyOn(rt, 'authorizeVerifySandbox').mockResolvedValue(viaRuntimeAuth);
    expect(await getEntry[1]({} as never)).toEqual(viaRuntimeGet);
    expect(await authEntry[1]({} as never)).toEqual(viaRuntimeAuth);
    expect(getSpy).toHaveBeenCalled();
    expect(authSpy).toHaveBeenCalled();
  });
});

describe('条件 5：回报里那一行', () => {
  /** 合成的一条待接受任务；只看验证那一行。 */
  const reportLine = (verifyOutput: string) => {
    const row = {
      id: 't',
      goal: '合成目标',
      status: 'pending_accept',
      error: null,
      origin_run_id: null,
      acceptance_json: null,
      verify_status: 'not_run',
      verify_output: verifyOutput,
      executor_report_json: null,
      executor_name: null,
      applied_ref: null,
      applied_at: null,
      apply_error: null,
    } as TaskReportRow;
    return buildTaskReport(row)!
      .content.split('\n')
      .find((l) => l.startsWith('验证'));
  };

  it('三种原因都是「验证没跑：」接契约 3.4 那一句（逐字）', () => {
    for (const sentence of [UNAUTHORIZED, CODEX_MISSING, UNSUPPORTED]) {
      expect(reportLine(sentence)).toBe(`验证没跑：${sentence}`);
    }
  });
});
