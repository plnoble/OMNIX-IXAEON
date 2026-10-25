/**
 * G1c 验收条件（B 档：只推测试，整合方锁定后再写实现）。
 * 规格草案：docs/委派/G1-GoalEngine-草案.md 第 5 节「G1c」那一段。
 *
 * **这一单只管方案与步骤**：`goal_plans` + `goal_steps` + `goal_step_deps` + `PlanStore`。
 * 用 G1a 的 `GoalStore` 造目标（那是 G1a 已锁定/将锁定的东西），不碰 `goal_links`（G1b）、不算 weighted 进度。
 *
 * 重点（用户 2026-10-25 定）：
 * - Step **ID 永久稳定**；重排**单事务 + 两阶段临时序号**；**不许删除重建**；
 * - 重排后测断言：ID 集合、依赖、任务绑定、行数都不变，只有 `seq` 变。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type CoreDatabase } from '../../src/index.js';
import { GoalStore } from '../../src/goals/index.js';
import { PlanStore } from '../../src/goals/plans.js';

let dir: string;
let db: CoreDatabase;
let goals: GoalStore;
let plans: PlanStore;
const opened: CoreDatabase[] = [];

const open = (dataDir: string): { db: CoreDatabase; goals: GoalStore; plans: PlanStore } => {
  const d = openDatabase(join(dataDir, 'ixaeon.db'));
  opened.push(d);
  migrate(d);
  return { db: d, goals: new GoalStore(d), plans: new PlanStore(d) };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1c-'));
  const o = open(dir);
  db = o.db;
  goals = o.goals;
  plans = o.plans;
});

afterEach(() => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const columnsOf = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const stepRows = (goalId: string, version: number): number =>
  (
    db
      .prepare('SELECT COUNT(*) AS n FROM goal_steps WHERE goal_id = ? AND plan_version = ?')
      .get(goalId, version) as { n: number }
  ).n;

const makePlan = (goalId: string) =>
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

describe('条件 1：表结构与「Step 是权威结构」', () => {
  it('三张方案表在；goal_plans 没有 steps_json（Step 独立成表）', () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const t of ['goal_plans', 'goal_steps', 'goal_step_deps']) {
      expect(tables, `缺表 ${t}`).toContain(t);
    }
    const planCols = columnsOf('goal_plans');
    expect(planCols).toContain('version');
    expect(planCols).toContain('reason');
    expect(planCols).toContain('superseded_by');
    expect(planCols).not.toContain('steps_json');

    const stepCols = columnsOf('goal_steps');
    for (const c of [
      'id',
      'goal_id',
      'plan_version',
      'seq',
      'title',
      'status',
      'linked_kind',
      'linked_id',
      'started_at',
      'ended_at',
      'updated_at',
    ]) {
      expect(stepCols, `goal_steps 缺列 ${c}`).toContain(c);
    }
    expect(columnsOf('goal_step_deps')).toContain('depends_on_step_id');
  });

  it('G1c 不建 goal_links（那是 G1b 的表）', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).not.toContain('goal_links');
  });
});

describe('条件 2：多版本（旧版一律保留）', () => {
  it('重规划一次 → 2 行；第 1 版 superseded + superseded_by=2；第 1 版步骤逐行仍在', () => {
    const g = goals.create({ title: '要方案的目标', via: 'ui' });
    const v1 = makePlan(g.id);
    const before = plans.stepsOf(g.id, v1.version);
    const v2 = plans.addVersion(g.id, {
      reason: '第一版假设不成立了',
      assumptions: ['换一条路'],
      steps: [{ title: '新的第一步' }, { title: '新的第二步' }],
    });
    expect(v2.version).toBe(2);

    const rows = db
      .prepare(
        'SELECT version, status, superseded_by FROM goal_plans WHERE goal_id = ? ORDER BY version',
      )
      .all(g.id) as Array<{ version: number; status: string; superseded_by: number | null }>;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]!.status).toBe('superseded');
    expect(rows[0]!.superseded_by).toBe(2);
    expect(rows[1]!.status).toBe('current');
    expect(rows[1]!.superseded_by).toBeNull();

    // 第 1 版的步骤逐行仍在（内容和状态都没被改）
    const still = plans.stepsOf(g.id, v1.version);
    expect(still.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(still.map((s) => s.title)).toEqual(before.map((s) => s.title));
    expect(still.map((s) => s.status)).toEqual(before.map((s) => s.status));
  });

  it('同一时刻只有一版 current', () => {
    const g = goals.create({ title: '要方案的目标', via: 'ui' });
    makePlan(g.id);
    plans.addVersion(g.id, { reason: '第二版', assumptions: [], steps: [{ title: 'x' }] });
    const current = db
      .prepare("SELECT COUNT(*) AS n FROM goal_plans WHERE goal_id = ? AND status = 'current'")
      .get(g.id) as { n: number };
    expect(current.n).toBe(1);
  });

  it('重规划不改目标状态（active 之后还是 active）', () => {
    const g = goals.create({ title: '要方案的目标', via: 'ui' });
    makePlan(g.id);
    plans.addVersion(g.id, { reason: '重规划', assumptions: [], steps: [{ title: 'y' }] });
    expect(goals.get(g.id)!.status).toBe('active');
  });
});

describe('条件 3：Step 可操作（顺序、状态、关联任务）', () => {
  it('4 步各有 seq / status / 可选关联任务；改某步 status 只动这一行', () => {
    const g = goals.create({ title: '步骤', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    expect(plans.stepsOf(g.id, v.version).map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    plans.bindStep(g.id, v.version, ids[0]!, { kind: 'coding_task', refId: 'ct-1' });
    const withBind = plans.stepsOf(g.id, v.version).find((s) => s.id === ids[0]!)!;
    expect(withBind.linked_kind).toBe('coding_task');
    expect(withBind.linked_id).toBe('ct-1');

    const otherUpdated = plans.stepsOf(g.id, v.version).find((s) => s.id === ids[1]!)!.updated_at;
    plans.setStepStatus(ids[0]!, 'doing');
    const after = plans.stepsOf(g.id, v.version);
    expect(after.find((s) => s.id === ids[0]!)!.status).toBe('doing');
    expect(after.find((s) => s.id === ids[1]!)!.updated_at).toBe(otherUpdated);
  });
});

describe('条件 4：两阶段重排（用户补充要求）', () => {
  it('重排后 ID 集合、依赖、任务绑定、行数都不变，只有 seq 变', () => {
    const g = goals.create({ title: '有方案的目标', via: 'ui' });
    const v = makePlan(g.id);
    const before = plans.stepsOf(g.id, v.version);
    const ids = before.map((s) => s.id);
    plans.bindStep(g.id, v.version, ids[0]!, { kind: 'coding_task', refId: 'ct-1' });
    plans.bindStep(g.id, v.version, ids[3]!, { kind: 'todo', refId: 'td-9' });
    plans.setDeps(g.id, v.version, ids[0]!, [ids[1]!]);

    const rowsBefore = stepRows(g.id, v.version);
    plans.reorderSteps(g.id, v.version, [ids[3]!, ids[2]!, ids[1]!, ids[0]!]);
    const after = plans.stepsOf(g.id, v.version);

    expect(after.map((s) => s.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(after.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(after.map((s) => s.id))).toEqual(new Set(ids)); // ID 集合不变
    const a2 = after.find((s) => s.id === ids[0]!)!;
    expect(a2.title).toBe('A 起服务');
    expect(a2.linked_kind).toBe('coding_task'); // 绑定没被重建掉
    expect(a2.linked_id).toBe('ct-1');
    expect(plans.depsOf(ids[0]!)).toEqual([ids[1]!]); // 依赖没丢
    expect(stepRows(g.id, v.version)).toBe(rowsBefore); // 不是删了重建
  });

  it('重排是单事务：传重复 id 时整体失败，seq 与 id 都保持原样', () => {
    const g = goals.create({ title: '重排出错', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    expect(() => plans.reorderSteps(g.id, v.version, [ids[0]!, ids[0]!, ids[1]!])).toThrow();
    const after = plans.stepsOf(g.id, v.version);
    expect(after.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(after.map((s) => s.id)).toEqual(ids);
  });

  it('重排不重置状态（doing 跟着行进）', () => {
    const g = goals.create({ title: '重排与状态无关', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    plans.setStepStatus(ids[1]!, 'doing');
    plans.reorderSteps(g.id, v.version, [ids[1]!, ids[0]!, ids[2]!, ids[3]!]);
    const after = plans.stepsOf(g.id, v.version);
    expect(after[0]!.id).toBe(ids[1]);
    expect(after[0]!.status).toBe('doing');
  });
});

describe('条件 5：依赖与推进（给 Heartbeat 的接口）', () => {
  it('A 依赖 B → B 未完成时 A 不能进 doing；B 完成后才能推', () => {
    const g = goals.create({ title: '推进步骤', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    plans.setDeps(g.id, v.version, ids[2]!, [ids[0]!]); // C 依赖 A
    expect(() => plans.advanceStep(ids[2]!)).toThrow();
    plans.advanceStep(ids[0]!);
    const a = plans.stepsOf(g.id, v.version).find((s) => s.id === ids[0]!)!;
    expect(a.status).toBe('doing');
    expect(a.started_at).toBeTruthy();
    plans.finishStep(ids[0]!);
    plans.advanceStep(ids[2]!);
    expect(plans.stepsOf(g.id, v.version).find((s) => s.id === ids[2]!)!.status).toBe('doing');
  });

  it('依赖成环写入被拒', () => {
    const g = goals.create({ title: '成环', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    plans.setDeps(g.id, v.version, ids[0]!, [ids[1]!]);
    expect(() => plans.setDeps(g.id, v.version, ids[1]!, [ids[0]!])).toThrow();
  });
});

describe('条件 6：proposed 不能被激活（分层不变量 G1c 那一层）', () => {
  it('replan / advanceStep 跑完，proposed 还是 proposed', () => {
    const g = goals.create({ title: 'AI 提的', origin: 'agent' });
    expect(goals.get(g.id)!.status).toBe('proposed');
    const v = makePlan(g.id);
    plans.addVersion(g.id, { reason: '再排一版', assumptions: [], steps: [{ title: 'z' }] });
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    plans.advanceStep(ids[0]!);
    expect(goals.get(g.id)!.status).toBe('proposed');
    expect(goals.get(g.id)!.confirmation).toBe('pending');
  });
});

describe('条件 7：重启后方案与步骤仍在', () => {
  it('关连接、重开：两版方案、步骤、依赖全在', () => {
    const g = goals.create({ title: '重启', via: 'ui' });
    const v1 = makePlan(g.id);
    const ids1 = plans.stepsOf(g.id, v1.version).map((s) => s.id);
    plans.setDeps(g.id, v1.version, ids1[1]!, [ids1[0]!]);
    plans.addVersion(g.id, { reason: '第二版', assumptions: [], steps: [{ title: 'n1' }] });

    for (const d of opened.splice(0)) d.close();
    const again = open(dir);
    const plans2 = again.plans;

    const rows = again.db
      .prepare('SELECT version, status FROM goal_plans WHERE goal_id = ? ORDER BY version')
      .all(g.id) as Array<{ version: number; status: string }>;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(plans2.stepsOf(g.id, 1).map((s) => s.id)).toEqual(ids1);
    expect(plans2.depsOf(ids1[1]!)).toEqual([ids1[0]!]);
  });
});
