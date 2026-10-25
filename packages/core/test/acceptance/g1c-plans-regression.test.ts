/** G1c 开发回归：临时库加载草案方案三表；历史版本只读、重排不删重建、依赖与推进。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, TodoStore, type CoreDatabase } from '../../src/index.js';
import { GoalStore } from '../../src/goals/index.js';
import { PlanStore } from '../../src/goals/plans.js';
import { loadGoalDraft } from '../helpers/goalDraft.js';

let dir: string;
let db: CoreDatabase;
let goals: GoalStore;
let plans: PlanStore;
const tables = ['goals', 'goal_events', 'goal_plans', 'goal_steps', 'goal_step_deps'];
const open = (dataDir: string) => {
  const d = openDatabase(join(dataDir, 'test.db'));
  loadGoalDraft(d, tables);
  return { db: d, goals: new GoalStore(d), plans: new PlanStore(d) };
};
const seqs = (goalId: string, version: number) => plans.stepsOf(goalId, version).map((s) => s.seq);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1c-'));
  const o = open(dir);
  db = o.db;
  goals = o.goals;
  plans = o.plans;
});
afterEach(() => {
  db.close();
  // Windows 上 WAL/SHM 句柄偶尔晚一步释放，删不掉就让系统临时目录收走，别让清理掩盖断言结果
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
});

const plan = (goalId: string) =>
  plans.addVersion(goalId, {
    reason: '第一版',
    assumptions: ['本地能跑'],
    steps: [
      { title: 'A 起服务' },
      { title: 'B 持久调度' },
      { title: 'C 额度回退' },
      { title: 'D 远程控制' },
    ],
  });

describe('多版本与历史只读', () => {
  it('排第二版：旧版标 superseded 且行不动，同一时刻只有一版 current', () => {
    const goal = goals.create({ title: '有方案的目标', via: 'ui' });
    const v1 = plan(goal.id);
    const before = plans.stepsOf(goal.id, v1.version);
    const v2 = plans.addVersion(goal.id, {
      reason: '假设不成立',
      assumptions: [],
      steps: [{ title: '新一步' }],
    });
    expect(v2.version).toBe(2);
    expect(plans.getPlan(goal.id, 1)).toMatchObject({ status: 'superseded', superseded_by: 2 });
    expect(plans.getPlan(goal.id, 2)).toMatchObject({ status: 'current', superseded_by: null });
    expect(plans.stepsOf(goal.id, 1)).toEqual(before);
    expect(goals.get(goal.id)!.status).toBe('active'); // 重规划不改目标状态
  });

  it('历史版本的步骤/依赖/重排/推进全部拒绝', () => {
    const goal = goals.create({ title: '目标', via: 'ui' });
    const v1 = plan(goal.id);
    plans.addVersion(goal.id, { reason: '第二版', assumptions: [], steps: [{ title: 'x' }] });
    expect(v1.version).toBe(1); // 历史版本就是这一版
    const old = plans.stepsOf(goal.id, 1);
    const snapshot = { steps: plans.stepsOf(goal.id, 1), plans: plans.plansOf(goal.id) };
    for (const attempt of [
      () => plans.setStepStatus(old[0]!.id, 'doing'),
      () => plans.advanceStep(old[0]!.id),
      () => plans.finishStep(old[0]!.id),
      () => plans.bindStep(goal.id, 1, old[0]!.id, { kind: 'todo', refId: 'x' }),
      () => plans.setDeps(goal.id, 1, old[0]!.id, [old[1]!.id]),
      () => plans.reorderSteps(goal.id, 1, old.map((s) => s.id).reverse()),
    ]) {
      expect(attempt).toThrow();
    }
    expect(plans.stepsOf(goal.id, 1)).toEqual(snapshot.steps);
    expect(plans.plansOf(goal.id)).toEqual(snapshot.plans);
  });
});

describe('两阶段重排', () => {
  it('重排只改 seq：ID 集合、依赖、绑定、行数、状态都不变，且用正数临时区', () => {
    const goal = goals.create({ title: '重排', via: 'ui' });
    const v = plan(goal.id);
    const ids = plans.stepsOf(goal.id, v.version).map((s) => s.id);
    const todo = new TodoStore(db).add({ title: '真任务' });
    plans.bindStep(goal.id, v.version, ids[0]!, { kind: 'todo', refId: todo.id });
    plans.setDeps(goal.id, v.version, ids[2]!, [ids[0]!]);
    plans.setStepStatus(ids[1]!, 'doing');
    db.exec(`CREATE TEMP TRIGGER no_step_delete BEFORE DELETE ON goal_steps
      BEGIN SELECT RAISE(ABORT, '不许删除重建步骤'); END;`);
    // 重排过程中任何 seq 都必须为正：用触发器在写临时区时校验
    db.exec(`CREATE TEMP TRIGGER positive_seq BEFORE UPDATE OF seq ON goal_steps
      WHEN NEW.seq <= 0 BEGIN SELECT RAISE(ABORT, 'seq 必须为正'); END;`);

    plans.reorderSteps(goal.id, v.version, [ids[3]!, ids[2]!, ids[1]!, ids[0]!]);
    const after = plans.stepsOf(goal.id, v.version);
    expect(after.map((s) => s.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(after.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(after.map((s) => s.id))).toEqual(new Set(ids));
    expect(after.find((s) => s.id === ids[0]!)!.linked_id).toBe(todo.id);
    expect(plans.depsOf(ids[2]!)).toEqual([ids[0]!]);
    expect(after.find((s) => s.id === ids[1]!)!.status).toBe('doing');
  });

  it('非法重排整体失败：重复/缺失/外来 id 都拒绝，seq 与 id 保持原样', () => {
    const goal = goals.create({ title: '坏重排', via: 'ui' });
    const v = plan(goal.id);
    const ids = plans.stepsOf(goal.id, v.version).map((s) => s.id);
    const before = seqs(goal.id, v.version);
    for (const bad of [
      [ids[0]!, ids[0]!, ids[1]!],
      ids.slice(0, 3),
      [...ids.slice(0, 3), 'not-a-step'],
    ]) {
      expect(() => plans.reorderSteps(goal.id, v.version, bad)).toThrow();
      expect(seqs(goal.id, v.version)).toEqual(before);
      expect(plans.stepsOf(goal.id, v.version).map((s) => s.id)).toEqual(ids);
    }
  });

  it('第二阶段写序号时失败：整笔回滚，seq 回到重排前的正数', () => {
    const goal = goals.create({ title: '中途失败', via: 'ui' });
    const v = plan(goal.id);
    const ids = plans.stepsOf(goal.id, v.version).map((s) => s.id);
    const before = seqs(goal.id, v.version);
    db.exec(`CREATE TEMP TRIGGER fail_final_seq BEFORE UPDATE OF seq ON goal_steps
      WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, '合成第二阶段故障'); END;`);
    expect(() => plans.reorderSteps(goal.id, v.version, [...ids].reverse())).toThrow(
      '合成第二阶段故障',
    );
    expect(seqs(goal.id, v.version)).toEqual(before);
  });
});

describe('依赖与推进', () => {
  it('依赖未完成不能推进；完成后才能推进并写 started_at；成环被拒', () => {
    const goal = goals.create({ title: '推进', via: 'ui' });
    const v = plan(goal.id);
    const ids = plans.stepsOf(goal.id, v.version).map((s) => s.id);
    plans.setDeps(goal.id, v.version, ids[2]!, [ids[0]!]);
    expect(() => plans.advanceStep(ids[2]!)).toThrow();
    plans.advanceStep(ids[0]!);
    expect(
      plans.stepsOf(goal.id, v.version).find((s) => s.id === ids[0]!)!.started_at,
    ).toBeTruthy();
    plans.finishStep(ids[0]!);
    plans.advanceStep(ids[2]!);
    expect(plans.stepsOf(goal.id, v.version).find((s) => s.id === ids[2]!)!.status).toBe('doing');

    plans.setDeps(goal.id, v.version, ids[3]!, [ids[2]!]);
    expect(() => plans.setDeps(goal.id, v.version, ids[2]!, [ids[3]!])).toThrow();
  });

  it('proposed 目标排方案/改步骤/推进之后仍是 proposed（不激活、不启动任务）', () => {
    const candidate = goals.create({ title: '候选', origin: 'agent' });
    const v = plan(candidate.id);
    const ids = plans.stepsOf(candidate.id, v.version).map((s) => s.id);
    plans.advanceStep(ids[0]!);
    plans.finishStep(ids[0]!);
    plans.addVersion(candidate.id, {
      reason: '再排一版',
      assumptions: [],
      steps: [{ title: 'x' }],
    });
    expect(goals.get(candidate.id)).toMatchObject({ status: 'proposed', confirmation: 'pending' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM todos').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get()).toEqual({ n: 0 });
  });
});

describe('持久化', () => {
  it('关连接重开：多版本、步骤、依赖都在', () => {
    const goal = goals.create({ title: '重启', via: 'ui' });
    const v1 = plan(goal.id);
    const ids = plans.stepsOf(goal.id, v1.version).map((s) => s.id);
    plans.setDeps(goal.id, v1.version, ids[1]!, [ids[0]!]);
    plans.addVersion(goal.id, { reason: '第二版', assumptions: [], steps: [{ title: 'n1' }] });
    const before = { plans: plans.plansOf(goal.id), steps: plans.stepsOf(goal.id, 1) };
    db.close();
    const again = open(dir);
    expect(again.plans.plansOf(goal.id)).toEqual(before.plans);
    expect(again.plans.stepsOf(goal.id, 1)).toEqual(before.steps);
    expect(again.plans.depsOf(ids[1]!)).toEqual([ids[0]!]);
  });
});
