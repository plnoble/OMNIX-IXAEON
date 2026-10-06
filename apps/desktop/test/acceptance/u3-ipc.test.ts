/**
 * U3 验收（规格 docs/委派/U3-任务页看改动.md 条件 11）：IPC 接上。
 * - registerIpc 注册了 getCodingTaskChanges；
 * - 调它得到的和 readTaskChanges 一样；
 * - 不存在的任务照 store.get 报错；
 * - 预加载和接口类型由类型检查把关（缺一个都编译不过）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  migrate,
  openDatabase,
  readTaskChanges,
  type CoreDatabase,
  type CodingTask,
} from '@ixaeon/core';
import type { TaskChanges } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-u3-ipc-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 项目 + 授权 + 一张带副本和报告的已完成任务。 */
function seedTask(): CodingTask {
  const root = join(dir, 'project');
  const workspace = join(dir, 'ws');
  mkdirSync(root, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(root, 'note.txt'), '第一行\n第二行\n');
  writeFileSync(join(workspace, 'note.txt'), '第一行\n改过的第二行\n新加的第三行\n');
  const proj = new ProjectService(db).create({
    name: 'U3 项目',
    rootPath: root,
    description: null,
  });
  new PermissionService(db).grantFolder(root);
  db.prepare(
    `INSERT INTO coding_tasks (
       id, project_id, goal, scope_json, workspace_path, snapshot_ref, context_digest,
       allowed_commands_json, timeout_ms, status, version, approval_id, dispatch_key,
       generation, executor_name, executor_report_json, verify_status, verify_exit_code,
       verify_output, tests_modified, accepted_at, error, created_at, updated_at, origin_run_id,
       acceptance_json
     ) VALUES ('u3-ipc-1', ?, '合成任务', '["note.txt"]', ?, 'copy', 'u3', '[]', 900000,
               'pending_accept', 1, NULL, NULL, 1, 'scripted', ?, 'passed', 0,
               'out', 0, NULL, NULL, datetime('now'), datetime('now'), NULL, NULL)`,
  ).run(
    proj.id,
    workspace,
    JSON.stringify({
      claimedSuccess: true,
      summary: 'done',
      changedPaths: ['note.txt'],
      testsModified: false,
      raw: '',
    }),
  );
  return db.prepare('SELECT * FROM coding_tasks WHERE id = ?').get('u3-ipc-1') as unknown as CodingTask;
}

/** 真实的 registerIpc + 运行时（挂上 coding），按通道名调用处理函数。 */
function ipc() {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const coding = new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data'));
  Object.assign(runtime, { db, coding });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string, arg: unknown): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    return (await entry[1]({} as never, arg)) as T;
  };
}

describe('U3 IPC（条件 11）', () => {
  it('注册了 getCodingTaskChanges，调它得到的和 readTaskChanges 一样', async () => {
    const call = ipc();
    const task = seedTask();
    const direct = readTaskChanges(db, task);
    expect(direct.total).toBeGreaterThan(0);
    const viaIpc = await call<TaskChanges>('getCodingTaskChanges', task.id);
    expect(viaIpc).toEqual(direct);
    const f = viaIpc.files[0]!;
    expect(f.path).toBe('note.txt');
    expect(f.kind).toBe('modified');
  });

  it('不存在的任务照 store.get 报错', async () => {
    const call = ipc();
    await expect(call<TaskChanges>('getCodingTaskChanges', '没有这个任务')).rejects.toThrow(
      /编码任务不存在/,
    );
  });
});