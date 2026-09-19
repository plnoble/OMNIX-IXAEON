/**
 * T2b 整合方事后复审补的（2026-09-19）：拍板前先看待办的状态。
 * 原实现先批准 / 取消底下的编码任务、再改待办；待办已经不是那个状态时（连点两下、别处改过），
 * 待办改不成，编码任务却已经被批准或取消了。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '@ixaeon/contracts';
import { TodoStore, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t2b-f-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runtime() {
  const todos = new TodoStore(db);
  const coding = { approveAndQueue: vi.fn(async () => undefined), cancel: vi.fn() };
  const rt = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(rt, { db, todos, coding });
  return { rt, todos, coding };
}

it('要做：待办已经不是等你拍板的，不去批准编码任务，直接报状态冲突', async () => {
  const { rt, todos, coding } = runtime();
  const t = todos.propose({
    title: '把验收测试补上',
    linked: { kind: 'coding_task', id: 'task-1' },
  })!;
  todos.accept(t.id);
  await expect(rt.acceptTodo(t.id)).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  expect(coding.approveAndQueue).not.toHaveBeenCalled();
});

it('不做：已经不做的待办，不再去取消编码任务', async () => {
  const { rt, todos, coding } = runtime();
  const t = todos.propose({
    title: '写交付说明',
    linked: { kind: 'coding_task', id: 'task-2' },
  })!;
  todos.reject(t.id);
  await expect(rt.rejectTodo(t.id)).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });
  expect(coding.cancel).not.toHaveBeenCalled();
});

it('对照：等你拍板的编码任务待办，「要做」先批准任务再改待办', async () => {
  const { rt, todos, coding } = runtime();
  const t = todos.propose({
    title: '补上重试',
    linked: { kind: 'coding_task', id: 'task-3' },
  })!;
  const done = await rt.acceptTodo(t.id);
  expect(coding.approveAndQueue).toHaveBeenCalledWith('task-3');
  expect(done.status).toBe('accepted');
});
