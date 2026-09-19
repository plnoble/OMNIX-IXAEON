/**
 * T3 验收（整合方写死，执行方不改）：待办的 IPC 接到运行时和 TodoStore。
 * 委派单：docs/委派/T3-待办页.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { TodoStore, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import type { Todo, TodoView } from '@ixaeon/contracts';
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
let todos: TodoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t3-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  todos = new TodoStore(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 真实的 registerIpc + 运行时（只挂上待办要用的部分），按通道名调用处理函数。 */
function ipc() {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db, todos });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string, arg?: unknown): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    return (await entry[1]({} as never, arg)) as T;
  };
}

describe('待办 IPC', () => {
  it('自己加一条：直接算要做，列表里看得到', async () => {
    const call = ipc();
    const added = await call<Todo>('addTodo', { title: '周五前交报销单' });
    expect(added).toMatchObject({ status: 'accepted', origin: 'user', title: '周五前交报销单' });
    const list = await call<TodoView[]>('listTodos');
    expect(list.map((t) => [t.id, t.linkedStatus])).toEqual([[added.id, null]]);
  });

  it('拍板、不做、做完，走到存取层', async () => {
    const call = ipc();
    const a = todos.propose({ title: '预约下周体检' })!;
    const b = todos.propose({ title: '把旧笔记本卖掉' })!;
    expect(await call<Todo>('acceptTodo', a.id)).toMatchObject({ status: 'accepted' });
    expect(await call<Todo>('completeTodo', a.id)).toMatchObject({ status: 'done' });
    expect(await call<Todo>('rejectTodo', b.id)).toMatchObject({ status: 'rejected' });
  });

  it('按状态筛', async () => {
    const call = ipc();
    todos.add({ title: '要做的一件' });
    const asked = todos.propose({ title: '等你拍板的一件' })!;
    const list = await call<TodoView[]>('listTodos', { status: ['proposed'] });
    expect(list.map((t) => t.id)).toEqual([asked.id]);
  });

  it('不合规的操作照实报错（做完的不能再拒绝）', async () => {
    const call = ipc();
    const t = todos.add({ title: '已经做完的事' });
    todos.complete(t.id);
    await expect(call('rejectTodo', t.id)).rejects.toThrow(/不能改成/);
  });
});
