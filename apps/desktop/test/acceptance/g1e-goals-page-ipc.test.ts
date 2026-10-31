/**
 * G1e 验收（规格 docs/委派/G1-GoalEngine-草案.md 第 5 节，用户 2026-10-30 定只读）：
 * 30/31. 列表数据来自真实 goals 表：状态、进度、复核时间、blocked_reason、watch。
 * 34. 只读：goals 通道只有 listGoals；打开、浏览前后 goals 相关六张表逐行不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { GoalStore, PlanStore, TodoStore, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';
import type { GoalSummaryView } from '@ixaeon/contracts';
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1e-'));
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

function seed(): { parentId: string } {
  const goals = new GoalStore(db);
  const plans = new PlanStore(db);
  const todos = new TodoStore(db);

  const parent = goals.create({
    title: '合成目标：把周报自动化',
    description: '每周五自动生成周报',
    via: 'ui',
  });
  const child = goals.create({ title: '合成子目标', via: 'ui', parentGoalId: parent.id });
  goals.transition(child.id, 'completed', { decidedBy: 'user' });

  const blocked = goals.create({ title: '合成目标：换服务器', via: 'ui' });
  goals.transition(blocked.id, 'blocked', { decidedBy: 'user', reason: '预算还没批' });

  goals.create({ title: '合成候选目标', origin: 'agent', via: 'pending' });
  const abandoned = goals.create({
    title: '合成目标：不要了',
    via: 'ui',
    parentGoalId: parent.id,
  });
  goals.transition(abandoned.id, 'abandoned', { decidedBy: 'user' });

  const todo = todos.add({ title: '合成待办：找模板' });
  goals.link(parent.id, { kind: 'todo', refId: todo.id });

  plans.addVersion(parent.id, {
    reason: '第一版太粗',
    assumptions: [],
    steps: [{ title: '旧步骤' }],
  });
  plans.addVersion(parent.id, {
    reason: '拆细一点',
    assumptions: [],
    steps: [{ title: '收集资料' }, { title: '写初稿' }, { title: '收尾' }],
  });
  const steps = plans.stepsOf(parent.id, 2);
  plans.setStepStatus(steps[0]!.id, 'done');
  plans.setDeps(parent.id, 2, steps[1]!.id, [steps[0]!.id]);
  plans.setDeps(parent.id, 2, steps[2]!.id, [steps[1]!.id]);

  db.prepare('UPDATE goals SET watch = 1, watch_reason = ?, next_review_at = ? WHERE id = ?').run(
    '编码任务失败：生成脚本没跑通',
    '2026-09-01T00:00:00.000Z',
    parent.id,
  );
  return { parentId: parent.id };
}

describe('Goals 只读 IPC', () => {
  it('30/31. 列表带出 active 的进度、复核时间、blocked_reason、watch', async () => {
    const { parentId } = seed();
    const call = ipc();
    const rows = await call<GoalSummaryView[]>('listGoals');
    const parent = rows.find((g) => g.id === parentId)!;

    expect(parent).toMatchObject({
      title: '合成目标：把周报自动化',
      status: 'active',
      progress: 0,
      progressMode: 'manual',
      watch: true,
      watchReason: '编码任务失败：生成脚本没跑通',
    });
    expect(parent.nextReviewAt).toBe('2026-09-01T00:00:00.000Z');
    expect(parent.children.map((c) => [c.title, c.status])).toEqual([['合成子目标', 'completed']]);
    expect(parent.nextStep).toMatchObject({ seq: 2, title: '写初稿' });

    expect(rows.find((g) => g.title === '合成目标：换服务器')?.blockedReason).toBe('预算还没批');
    expect(rows.find((g) => g.title === '合成候选目标')?.status).toBe('proposed');
    expect(rows.map((g) => g.title)).not.toContain('合成目标：不要了');
  });

  it('30. 下一步跳过依赖没满足的靠前步骤，取第一个可做的 pending', async () => {
    const goals = new GoalStore(db);
    const plans = new PlanStore(db);
    const goal = goals.create({ title: '合成目标：依赖顺序', via: 'ui' });
    plans.addVersion(goal.id, {
      reason: '验证下一步选择',
      assumptions: [],
      steps: [{ title: '被依赖卡住' }, { title: '可以先做' }],
    });
    const [first, ready] = plans.stepsOf(goal.id, 1);
    plans.setDeps(goal.id, 1, first!.id, [ready!.id]);

    const call = ipc();
    const rows = await call<GoalSummaryView[]>('listGoals');
    expect(rows.find((g) => g.id === goal.id)!.nextStep).toEqual({
      id: ready!.id,
      seq: 2,
      title: '可以先做',
    });
  });

  it('34. goals 通道只有读接口（没有确认 / 改步骤 / 重规划等写通道），浏览前后六张表逐行不变', async () => {
    seed();
    const call = ipc();
    const channels = vi
      .mocked(ipcMain.handle)
      .mock.calls.map(([ch]) => ch)
      .filter((ch) => ch.toLowerCase().includes('goal'));
    // 只允许读：列表 / 详情（详情在 G1eb 加，仍属只读）；出现任何写通道就失败
    for (const ch of channels) {
      expect(['ixaeon:listGoals', 'ixaeon:getGoalDetail']).toContain(ch);
    }
    expect(channels).toContain('ixaeon:listGoals');
    for (const verb of ['confirm', 'reject', 'create', 'update', 'set', 'link', 'unlink', 'replan']) {
      expect(channels.some((ch) => ch.toLowerCase().includes(verb))).toBe(false);
    }

    const before = snapshot();
    await call('listGoals');
    await call('listGoals');
    expect(snapshot()).toEqual(before);
  });
});