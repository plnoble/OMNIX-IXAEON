/**
 * G1e-b 验收（规格 docs/委派/G1-GoalEngine-草案.md 第 5 节，用户 2026-10-30 定只读）：
 * 33. 主进程详情通道带出方案及历史、步骤、关联任务、事件（含 decided_by）。
 * 34. 只读：详情通道也只有读；打开详情前后六张表逐行不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { GoalStore, PlanStore, TodoStore, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import type { GoalDetailView } from '@ixaeon/contracts';
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1eb-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ipc() {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string, arg?: unknown): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    return (await entry[1]({} as never, arg)) as T;
  };
}

const GOAL_TABLES = ['goals', 'goal_events', 'goal_plans', 'goal_steps', 'goal_step_deps', 'goal_links'];
const snapshot = (): unknown[] =>
  GOAL_TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());

function seed(): { goalId: string; childId: string; todoId: string; stepIds: string[] } {
  const goals = new GoalStore(db);
  const plans = new PlanStore(db);
  const todos = new TodoStore(db);

  const goal = goals.create({
    title: '合成目标：把周报自动化',
    description: '每周五自动生成周报',
    via: 'ui',
  });
  const child = goals.create({ title: '合成子目标', via: 'ui', parentGoalId: goal.id });
  goals.transition(child.id, 'completed', { decidedBy: 'user' });
  const abandonedChild = goals.create({
    title: '合成子目标：不要了',
    via: 'ui',
    parentGoalId: goal.id,
  });
  goals.transition(abandonedChild.id, 'abandoned', { decidedBy: 'user' });
  const todo = todos.add({ title: '合成待办：找模板' });
  goals.link(goal.id, { kind: 'todo', refId: todo.id });

  plans.addVersion(goal.id, { reason: '第一版太粗', steps: [{ title: '旧步骤' }] });
  plans.addVersion(goal.id, {
    reason: '拆细一点',
    steps: [{ title: '收集资料' }, { title: '写初稿' }, { title: '收尾' }],
  });
  const steps = plans.stepsOf(goal.id, 2);
  plans.setStepStatus(steps[0]!.id, 'done');
  plans.setDeps(goal.id, 2, steps[1]!.id, [steps[0]!.id]);
  plans.setDeps(goal.id, 2, steps[2]!.id, [steps[1]!.id]);
  plans.bindStep(goal.id, 2, steps[1]!.id, { kind: 'todo', refId: todo.id });

  return {
    goalId: goal.id,
    childId: child.id,
    todoId: todo.id,
    stepIds: steps.map((s) => s.id),
  };
}

describe('Goals 详情只读 IPC', () => {
  it('33. 详情带出方案及历史、步骤、关联任务、事件（含 decided_by）', async () => {
    const { goalId, childId, todoId, stepIds } = seed();
    const call = ipc();
    const detail = await call<GoalDetailView>('getGoalDetail', goalId);

    expect(detail).toMatchObject({
      title: '合成目标：把周报自动化',
      description: '每周五自动生成周报',
      status: 'active',
    });
    expect(detail.children.map((c) => [c.title, c.status])).toEqual([['合成子目标', 'completed']]);

    // 子目标能真点进去：对子目标调详情不能报「目标不存在」；已放弃的子目标不列进 children
    const childDetail = await call<GoalDetailView>('getGoalDetail', childId);
    expect(childDetail.title).toBe('合成子目标');
    expect(childDetail.status).toBe('completed');
    expect(detail.plans.map((p) => [p.version, p.status])).toEqual([
      [1, 'superseded'],
      [2, 'current'],
    ]);
    expect(detail.plans[0]!.steps.map((s) => s.title)).toEqual(['旧步骤']);
    const current = detail.plans.find((p) => p.status === 'current')!;
    expect(current.reason).toBe('拆细一点');
    expect(current.steps.map((s) => [s.seq, s.title, s.status])).toEqual([
      [1, '收集资料', 'done'],
      [2, '写初稿', 'pending'],
      [3, '收尾', 'pending'],
    ]);
    expect(current.steps[1]!.id).toBe(stepIds[1]);
    expect(current.steps[1]!.deps).toEqual([stepIds[0]]);
    expect(current.steps[1]!.linkedTitle).toBe('合成待办：找模板');
    expect(detail.links).toEqual([
      { kind: 'todo', refId: todoId, title: '合成待办：找模板', status: 'accepted' },
    ]);
    expect(detail.events.map((e) => e.decidedBy)).toContain('user');
    expect(detail.events.map((e) => e.decidedBy)).toContain('agent');
    expect(detail.events.length).toBeGreaterThan(0);
    for (const event of detail.events) {
      expect(['user', 'agent', 'system']).toContain(event.decidedBy);
      expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.summary.length).toBeGreaterThan(0);
    }
    expect(detail.events.some((e) => e.kind === 'created' && e.decidedBy === 'user')).toBe(true);
    // 同一毫秒内的事件按插入顺序（rowid），不能按随机 id 排：时间线第一是建立、最后是第 2 版方案
    expect(detail.events[0]!.kind).toBe('created');
    expect(detail.events.at(-1)!.kind).toBe('plan');
  });

  it('34. goals 通道只有两个读接口；打开详情前后六张表逐行不变', async () => {
    const { goalId } = seed();
    const call = ipc();
    const channels = vi
      .mocked(ipcMain.handle)
      .mock.calls.map(([ch]) => ch)
      .filter((ch) => ch.toLowerCase().includes('goal'));
    expect(channels).toEqual(['ixaeon:listGoals', 'ixaeon:getGoalDetail']);

    const before = snapshot();
    await call('listGoals');
    await call('getGoalDetail', goalId);
    expect(snapshot()).toEqual(before);

    await expect(call('getGoalDetail', 'nope')).rejects.toThrow(/目标不存在/);
    expect(snapshot()).toEqual(before);
  });
});
