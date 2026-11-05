/**
 * G04 验收（规格 docs/委派/G04-编码任务按运行归属.md）
 *
 * 条件 1：对话 A 等回答时，另一个运行（对话 B、项目 B）建的任务不出现在 A 的回答里，
 *         出现在 B 的回答里。
 * 条件 2：同一项目两轮并发，各自建的任务各归各的。
 * 条件 3：propose_task 建任务时写上这次调用的 runId（origin_run_id）；
 *         A 这一轮自己建的任务照常出现在 A 的回答上并进待办。
 * 条件 4：没有 origin_run_id 的旧任务不出现在任何回答上。
 *
 * 归属的断言点是回答消息 meta.proposedTodos（T2b 的待办卡同一条路径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingOrchestrator,
  CoreToolBroker,
  FakeCodingExecutor,
  ItemService,
  ProjectService,
  SearchService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g04-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('G04 编码任务按运行归属', () => {
  it('条件 3：propose_task 建任务时记下这次调用的 runId', async () => {
    const projects = new ProjectService(db);
    const project = projects.create({ name: '项目A', rootPath: null, description: null });
    const broker = new CoreToolBroker(
      db,
      new ItemService(db),
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      projects,
    );
    const created = (await broker.invoke(
      'propose_task',
      { projectId: project.id, goal: '本轮的任务' },
      { audience: 'model', runId: 'run-A' },
    )) as { id: string };
    const row = db
      .prepare('SELECT origin_run_id FROM coding_tasks WHERE id = ?')
      .get(created.id) as {
      origin_run_id: string | null;
    };
    expect(row.origin_run_id).toBe('run-A');
  });
});
