/**
 * D2 验收测试（规格 docs/委派/D2-验证按档位进沙箱.md，v2 写法：先测试后实现）。
 * 本文件对应整合方 2026-09-30 补的验收条件 11（规格「改正与补充」第 3、4 条）：
 * 依赖档在生产路径上真的接上了，而不只是替身能过。
 *
 * - 编排层验证依赖档命令时，把项目根目录与数据目录交给验证（runCheck 第 4 个参数）；
 * - 什么都不替换（默认 runCheck、默认检查、默认派生），在从没授权过的新数据目录上跑
 *   依赖档任务：verify_status = not_run，原因是 unauthorized（装了 Codex）或
 *   codex_missing（没装）；任务停在待接受，不算失败；副本里没留下链接。
 *   这条同时守住「无人值守不弹窗」：检查没过就不许派生沙箱。
 * - checkSandboxAuth(dataDir, env?)：非 Windows → unsupported_platform；找不到 Codex →
 *   codex_missing；Codex 在、专用 HOME 没授权过 → unauthorized；检查不往数据目录写任何东西。
 * - requestSandboxAuth(dataDir) 存在（会弹 UAC，测试里不调用）。
 *
 * 真的授权过的「检查通过」没法在测试里造，留给真机检查。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
  type CoreDatabase,
  type IndependentCheck,
} from '../../src/index.js';
import { checkSandboxAuth, requestSandboxAuth } from '../../src/execution/verifySandbox.js';

const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const canon = (p: string) => realpathSync.native(p).replaceAll('\\', '/').toLowerCase();

function project() {
  const root = tempDir('ixa-d2-proj-');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'add.ts'),
    'export const add = (a: number, b: number) => a + b;\n',
  );
  writeFileSync(join(root, 'src', 'add.test.ts'), "import { it } from 'vitest';\n");
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), '// 替身\n');
  const dataDir = tempDir('ixa-d2-data-');
  db = openDatabase(join(dataDir, 'ixaeon.db'));
  migrate(db);
  const p = new ProjectService(db).create({ name: '合成项目', rootPath: root, description: null });
  new PermissionService(db).grantFolder(root);
  return { root, dataDir, projectId: p.id };
}

async function runDependencyTask(
  coding: CodingOrchestrator,
  projectId: string,
): Promise<{
  id: string;
  status: string;
  verify_status: string | null;
  verify_output: string | null;
  workspace_path: string | null;
}> {
  const task = coding.create({
    projectId,
    goal: '把加法写对',
    scope: ['src/add.ts'],
    allowedCommands: [['ixaeon:vitest', 'run', 'src/add.test.ts']],
  });
  await coding.approveAndQueue(task.id);
  await coding.dispatch(task.id);
  return db!
    .prepare(
      'SELECT id, status, verify_status, verify_output, workspace_path FROM coding_tasks WHERE id = ?',
    )
    .get(task.id) as {
    id: string;
    status: string;
    verify_status: string | null;
    verify_output: string | null;
    workspace_path: string | null;
  };
}

const executor = () =>
  new FakeCodingExecutor({
    claimedSuccess: true,
    files: { 'src/add.ts': 'export const add = (a: number, b: number) => a + b; // 改过\n' },
  });

describe('D2 条件 11（整合方补）：编排层把项目根目录与数据目录交给验证', () => {
  it('runCheck 第 4 个参数带着 projectRoot、dataDir', async () => {
    const { root, dataDir, projectId } = project();
    const seen: Array<{ projectRoot?: string; dataDir?: string } | undefined> = [];
    const runCheck = async (
      argv: string[],
      _cwd: string,
      _signal?: AbortSignal,
      context?: { projectRoot?: string; dataDir?: string },
    ): Promise<IndependentCheck> => {
      seen.push(context);
      return { argv, exitCode: 0, output: 'ok', ran: true };
    };
    const coding = new CodingOrchestrator(
      db!,
      executor(),
      dataDir,
      runCheck as unknown as ConstructorParameters<typeof CodingOrchestrator>[3],
    );
    const t = await runDependencyTask(coding, projectId);
    expect(t.verify_status).toBe('passed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.projectRoot, '应带项目根目录').toBeDefined();
    expect(canon(seen[0]!.projectRoot!)).toBe(canon(root));
    expect(seen[0]?.dataDir, '应带数据目录').toBeDefined();
    expect(canon(seen[0]!.dataDir!)).toBe(canon(dataDir));
  });
});

describe('D2 条件 11（整合方补）：什么都不替换的生产路径', () => {
  it('新数据目录从没授权过：not_run（unauthorized 或 codex_missing），停在待接受，副本里没留链接', async () => {
    const { dataDir, projectId } = project();
    const coding = new CodingOrchestrator(db!, executor(), dataDir);
    const t = await runDependencyTask(coding, projectId);
    expect(t.status).toBe('pending_accept');
    expect(t.verify_status).toBe('not_run');
    const expected =
      process.platform === 'win32' ? /unauthorized|codex_missing/ : /unsupported_platform/;
    expect(t.verify_output ?? '').toMatch(expected);
    expect(existsSync(join(t.workspace_path!, 'node_modules'))).toBe(false);
  });
});

describe('D2 条件 11（整合方补）：checkSandboxAuth 被动检查', () => {
  it('不是 Windows → unsupported_platform', async () => {
    const dataDir = tempDir('ixa-d2-auth-');
    expect(await checkSandboxAuth(dataDir, { platform: 'linux' })).toEqual({
      ok: false,
      reason: 'unsupported_platform',
    });
  });

  it('找不到 Codex → codex_missing', async () => {
    const dataDir = tempDir('ixa-d2-auth-');
    expect(await checkSandboxAuth(dataDir, { platform: 'win32', codexExe: null })).toEqual({
      ok: false,
      reason: 'codex_missing',
    });
    expect(
      await checkSandboxAuth(dataDir, {
        platform: 'win32',
        codexExe: join(dataDir, 'no-codex.exe'),
      }),
    ).toEqual({ ok: false, reason: 'codex_missing' });
  });

  it('Codex 在、专用 HOME 从没授权过 → unauthorized；检查不往数据目录写任何东西', async () => {
    const dataDir = tempDir('ixa-d2-auth-');
    // 用一个确实存在的可执行文件顶替 Codex：检查只该读文件与状态，不该靠它做任何事
    const r = await checkSandboxAuth(dataDir, { platform: 'win32', codexExe: process.execPath });
    expect(r).toEqual({ ok: false, reason: 'unauthorized' });
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('发起授权的函数存在（会弹 UAC，测试里不调用）', () => {
    expect(typeof requestSandboxAuth).toBe('function');
  });
});
