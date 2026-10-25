/**
 * G1a 验收条件（B 档：只推测试，整合方锁定后再写实现）。
 * 规格草案：docs/委派/G1-GoalEngine-草案.md（待整合方定稿）
 *
 * 覆盖：迁移与表结构、origin × confirmation 正交、状态机与事务、manual/weighted 进度、
 * 子目标不重复计、Plan Step 的稳定 ID 与两阶段重排、非法迁移回滚不残留 goal_event、重启后仍在。
 *
 * 钉死的接缝（实现必须照这个写，不许改名）：
 * - `migrate(db)` 之后有 goals / goal_events / goal_plans / goal_steps / goal_step_deps 五张表；
 * - `new GoalStore(db)`；`goalStore.create(input)` / `.get(id)` / `.confirm(id, how)` /
 *   `.transition(id, to, opts)` / `.setProgress(id, value)` / `.recomputeProgress(id)`；
 * - `planStore.addVersion(goalId, input)` / `.reorderSteps(goalId, version, idsInOrder)` /
 *   `.advanceStep(stepId)` / `.stepsOf(goalId, version)` / `.depsOf(stepId)`；
 * - 所有改状态的入口在同一个事务里；拒绝时抛 `IxaError` 且**不留 goal_event**。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type CoreDatabase } from '../../src/index.js';
import { GoalStore, PlanStore } from '../../src/goals/index.js';

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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1a-'));
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

const countEvents = (goalId: string): number =>
  (
    db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId) as {
      n: number;
    }
  ).n;

const columnsOf = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('条件 1：迁移与表结构', () => {
  it('migrate 之后五张表都在；goals 只有第一版要的列（没有 evidence/blocking 的痕迹）', () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const t of ['goals', 'goal_events', 'goal_plans', 'goal_steps', 'goal_step_deps']) {
      expect(tables, `缺表 ${t}`).toContain(t);
    }
    const cols = columnsOf('goals');
    for (const c of [
      'id',
      'title',
      'description',
      'origin',
      'confirmation',
      'confirmed_by_message_id',
      'status',
      'progress',
      'progress_mode',
      'parent_goal_id',
      'blocked_reason',
      'watch',
      'watch_reason',
      'next_review_at',
    ]) {
      expect(cols, `goals 缺列 ${c}`).toContain(c);
    }
    // 用户定：evidence-based / blocking 连字段都不造
    expect(
      cols.some((c) => /evidence|blocking|milestone/i.test(c)),
      '不该有 evidence/blocking 的列',
    ).toBe(false);
    expect(cols).not.toContain('goal_id'); // goals 自己不需要这个列
  });

  it('不给已有任务表加列：coding_tasks / todos 的列就是它们原来的那些', () => {
    const coding = columnsOf('coding_tasks');
    const todos = columnsOf('todos');
    expect(coding).not.toContain('goal_id');
    expect(coding).not.toContain('subgoal_id');
    expect(todos).not.toContain('goal_id');
    expect(todos).not.toContain('subgoal_id');
    // goal 这个词在 coding_tasks 里本来就是「目标描述文本」，不能被占用成外键
    expect(coding).toContain('goal');
  });
});

describe('条件 2：origin 与 confirmation 正交（用户补充要求钉住）', () => {
  it('UI 明确创建 → origin=user、confirmation=ui、直接 active，一条 created 事件', () => {
    const g = goals.create({ title: '让 IXAEON 可以 24×7 自主开发', via: 'ui' });
    const row = goals.get(g.id)!;
    expect(row.origin).toBe('user');
    expect(row.confirmation).toBe('ui');
    expect(row.status).toBe('active');
    expect(row.confirmed_by_message_id).toBeNull();
    expect(countEvents(g.id)).toBeGreaterThanOrEqual(1);
  });

  it('API 明确创建 → origin=user、confirmation=api、active', () => {
    const g = goals.create({ title: '把待办全部清空', via: 'api' });
    const row = goals.get(g.id)!;
    expect(row.origin).toBe('user');
    expect(row.confirmation).toBe('api');
    expect(row.status).toBe('active');
  });

  it('聊天里表达想法 → origin=agent、confirmation=pending、proposed（哪怕听起来很确定）', () => {
    const g = goals.create({
      title: '让 IXAEON 最终能够在 FAEX1 上 24×7 自己工作',
      origin: 'agent',
      fromConversationId: null,
    });
    const row = goals.get(g.id)!;
    expect(row.origin).toBe('agent');
    expect(row.confirmation).toBe('pending');
    expect(row.status).toBe('proposed');
    expect(row.confirmed_by_message_id).toBeNull();
  });

  it('两个维度确实独立：origin=agent 的也能被 ui 确认；origin=user 的也记 confirmation=chat（如果走聊天确认）', () => {
    const a = goals.create({ title: 'AI 提的目标', origin: 'agent' });
    expect(goals.get(a.id)!.status).toBe('proposed');
    goals.confirm(a.id, { how: 'ui' });
    const afterA = goals.get(a.id)!;
    expect(afterA.origin).toBe('agent'); // 来源不变
    expect(afterA.confirmation).toBe('ui'); // 确认方式变了
    expect(afterA.status).toBe('active');

    const b = goals.create({ title: '聊天里用户拍的板', origin: 'user', via: 'pending' });
    goals.confirm(b.id, { how: 'chat', messageId: 'm-1' });
    const afterB = goals.get(b.id)!;
    expect(afterB.origin).toBe('user');
    expect(afterB.confirmation).toBe('chat');
    expect(afterB.confirmed_by_message_id).toBe('m-1');
  });

  it('数据库层面也拦：手写 SQL 想造 active + pending 会被 CHECK 拒', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO goals (id, title, description, origin, confirmation, status,
             priority, created_at, updated_at, progress, progress_mode, watch)
           VALUES ('x', 't', '', 'agent', 'pending', 'active', 0,
             '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 0, 'manual', 0)`,
        )
        .run(),
    ).toThrow();
  });
});

describe('条件 3：AI 任何路径都改不成 active', () => {
  it('AI 建的目标直接调 transition 到 active → 抛错，状态与事件都没变', () => {
    const g = goals.create({ title: 'AI 提的', origin: 'agent' });
    const before = countEvents(g.id);
    expect(() => goals.transition(g.id, 'active', { decidedBy: 'agent' })).toThrow();
    expect(goals.get(g.id)!.status).toBe('proposed');
    expect(countEvents(g.id)).toBe(before);
  });

  it('进度重算 / 重规划跑完，proposed 还是 proposed', () => {
    const g = goals.create({ title: 'AI 提的', origin: 'agent' });
    goals.recomputeProgress(g.id);
    plans.addVersion(g.id, { reason: '先排一版', assumptions: [], steps: [{ title: '第一步' }] });
    expect(goals.get(g.id)!.status).toBe('proposed');
    expect(goals.get(g.id)!.confirmation).toBe('pending');
  });
});

describe('条件 4：状态机与事务（用户补充：回滚不留残渣）', () => {
  it('proposed → completed 被拒；abandoned → active 被拒；blocked 没有理由被拒', () => {
    const p = goals.create({ title: 'AI 提的', origin: 'agent' });
    expect(() => goals.transition(p.id, 'completed', { decidedBy: 'user' })).toThrow();

    const a = goals.create({ title: '不要了', via: 'ui' });
    goals.transition(a.id, 'abandoned', { decidedBy: 'user' });
    expect(() => goals.transition(a.id, 'active', { decidedBy: 'user' })).toThrow();

    const b = goals.create({ title: '要做', via: 'ui' });
    expect(() => goals.transition(b.id, 'blocked', { decidedBy: 'agent' })).toThrow();
  });

  it('非法迁移抛错之后，goal_events 一行都没多（事务整体回滚）', () => {
    const g = goals.create({ title: '要做', via: 'ui' });
    const before = countEvents(g.id);
    // 连续几次非法迁移：都该被拒
    expect(() => goals.transition(g.id, 'blocked', { decidedBy: 'agent' })).toThrow(); // 没理由
    expect(() => goals.transition(g.id, 'proposed', { decidedBy: 'agent' })).toThrow(); // 回不去
    expect(() => goals.transition(g.id, 'abandoned', { decidedBy: 'system' })).toThrow(); // 系统不能替用户否决
    expect(countEvents(g.id), '被拒的迁移不该留下事件').toBe(before);
    expect(goals.get(g.id)!.status).toBe('active');
  });

  it('blocked 必须带理由、事件必须是 agent 或 user 判的（system 不许）', () => {
    const g = goals.create({ title: '要做', via: 'ui' });
    goals.transition(g.id, 'blocked', {
      decidedBy: 'agent',
      reason: '两个任务都失败在同一个接口上',
    });
    const row = goals.get(g.id)!;
    expect(row.status).toBe('blocked');
    expect(row.blocked_reason).toContain('同一个接口');

    const ev = db
      .prepare(
        "SELECT decided_by, summary FROM goal_events WHERE goal_id = ? AND kind = 'status' ORDER BY at DESC LIMIT 1",
      )
      .get(g.id) as { decided_by: string; summary: string };
    expect(['agent', 'user']).toContain(ev.decided_by);

    expect(() =>
      db
        .prepare(
          `INSERT INTO goals (id, title, description, origin, confirmation, status,
             priority, created_at, updated_at, progress, progress_mode, watch, blocked_reason)
           VALUES ('y', 't', '', 'user', 'ui', 'blocked', 0,
             '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 0, 'manual', 0, NULL)`,
        )
        .run(),
    ).toThrow(); // blocked 但没理由，CHECK 拦住
  });

  it('blocked → active 清空理由并记事件', () => {
    const g = goals.create({ title: '要做', via: 'ui' });
    goals.transition(g.id, 'blocked', { decidedBy: 'user', reason: '等模型额度' });
    const before = countEvents(g.id);
    goals.transition(g.id, 'active', { decidedBy: 'user' });
    const row = goals.get(g.id)!;
    expect(row.status).toBe('active');
    expect(row.blocked_reason).toBeNull();
    expect(countEvents(g.id)).toBeGreaterThan(before);
  });
});

describe('条件 5：progress 两种模式', () => {
  it('manual：给人给的值，完成任务不改它', () => {
    const g = goals.create({ title: '手填进度', via: 'ui', progressMode: 'manual' });
    goals.setProgress(g.id, 42);
    expect(goals.get(g.id)!.progress).toBe(42);
    // 挂一个任务并把它标成完成：manual 下进度不该动
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(42);
  });

  it('weighted：3 个等权任务完成 1 个 → 33；完成 2 个 → 67', () => {
    const g = goals.create({ title: '按权重算', via: 'ui', progressMode: 'weighted' });
    goals.link(g.id, { kind: 'todo', refId: 't1', weight: 1 });
    goals.link(g.id, { kind: 'todo', refId: 't2', weight: 1 });
    goals.link(g.id, { kind: 'todo', refId: 't3', weight: 1 });
    goals.setRefDone(g.id, { kind: 'todo', refId: 't1' }, true);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(33);
    goals.setRefDone(g.id, { kind: 'todo', refId: 't2' }, true);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(67);
  });

  it('weighted 但一个任务都没挂：保持原值，不瞎算成 0', () => {
    const g = goals.create({ title: '空的', via: 'ui', progressMode: 'weighted' });
    goals.setProgress(g.id, 15);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(15);
  });

  it('子目标自己的任务算子目标的；子目标完成后父目标按权重只计一次', () => {
    const parent = goals.create({ title: '父', via: 'ui', progressMode: 'weighted' });
    const child = goals.create({ title: '子', via: 'ui', origin: 'user', parentGoalId: parent.id });
    goals.link(parent.id, { kind: 'todo', refId: 'p1', weight: 1 });
    goals.link(parent.id, { kind: 'todo', refId: 'p2', weight: 1 });
    goals.link(child.id, { kind: 'todo', refId: 'c1', weight: 1 });
    // 子的任务完成 → 只动子
    goals.setRefDone(child.id, { kind: 'todo', refId: 'c1' }, true);
    goals.recomputeProgress(parent.id);
    goals.recomputeProgress(child.id);
    expect(goals.get(parent.id)!.progress).toBe(0);
    expect(goals.get(child.id)!.progress).toBe(100);
    // 子目标完成 → 父按子目标在父里登记的权重计一次
    goals.link(parent.id, { kind: 'todo', refId: `goal:${child.id}`, weight: 1 });
    goals.transition(child.id, 'completed', { decidedBy: 'user' });
    goals.recomputeProgress(parent.id);
    // 父里 3 项完成 1 项 → 33
    expect(goals.get(parent.id)!.progress).toBe(33);
  });
});

describe('条件 6：Plan Step 的稳定 ID 与两阶段重排（用户补充）', () => {
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

  it('重排之后：ID 不变、依赖不变、绑定的任务不变，只有 seq 变', () => {
    const g = goals.create({ title: '有方案的目标', via: 'ui' });
    const v = makePlan(g.id);
    const before = plans.stepsOf(g.id, v.version);
    const ids = before.map((s) => s.id);
    // 给 B、D 挂任务，并让 A 依赖 B
    plans.bindStep(g.id, v.version, ids[0]!, { kind: 'coding_task', refId: 'ct-1' });
    plans.bindStep(g.id, v.version, ids[3]!, { kind: 'todo', refId: 'td-9' });
    plans.setDeps(g.id, v.version, ids[0]!, [ids[1]!]);
    // 反过来排：D C B A
    plans.reorderSteps(g.id, v.version, [ids[3]!, ids[2]!, ids[1]!, ids[0]!]);

    const after = plans.stepsOf(g.id, v.version);
    expect(after.map((s) => s.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(after.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    // 内容、状态、绑定都没被重建掉
    const a2 = after.find((s) => s.id === ids[0]!)!;
    expect(a2.title).toBe('A 起服务');
    expect(a2.linked_kind).toBe('coding_task');
    expect(a2.linked_id).toBe('ct-1');
    expect(plans.depsOf(ids[0]!)).toEqual([ids[1]!]); // 依赖没丢
    // 行数没变（不是删除重建）
    const n = (
      db
        .prepare('SELECT COUNT(*) AS n FROM goal_steps WHERE goal_id = ? AND plan_version = ?')
        .get(g.id, v.version) as { n: number }
    ).n;
    expect(n).toBe(4);
  });

  it('重排在一个事务里：中途失败不留半套 seq（模拟撞唯一约束）', () => {
    const g = goals.create({ title: '重排出错', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    // 传一个不存在/重复的 id 列表 → 该整体失败，seq 保持原样
    expect(() => plans.reorderSteps(g.id, v.version, [ids[0]!, ids[0]!, ids[1]!])).toThrow();
    const after = plans.stepsOf(g.id, v.version);
    expect(after.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(after.map((s) => s.id)).toEqual(ids);
  });

  it('重排不改状态、不改 updated_at 以外的东西（同一次重排里顺序与 id 对得上）', () => {
    const g = goals.create({ title: '重排与状态无关', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    plans.advanceStep(ids[1]!); // B 进 doing
    plans.reorderSteps(g.id, v.version, [ids[1]!, ids[0]!, ids[2]!, ids[3]!]);
    const after = plans.stepsOf(g.id, v.version);
    expect(after[0]!.id).toBe(ids[1]);
    expect(after[0]!.status).toBe('doing'); // 状态跟着行进，没被重置
  });

  it('Step 是权威结构：goal_plans 里没有 steps_json 这种列', () => {
    const cols = columnsOf('goal_plans');
    expect(cols).toContain('version');
    expect(cols).toContain('reason');
    expect(cols).not.toContain('steps_json');
    const stepCols = columnsOf('goal_steps');
    for (const c of ['id', 'seq', 'title', 'status', 'linked_kind', 'linked_id', 'started_at']) {
      expect(stepCols, `goal_steps 缺列 ${c}`).toContain(c);
    }
    expect(columnsOf('goal_step_deps')).toContain('depends_on_step_id');
  });

  it('AdvanceStep 给 Heartbeat 用：依赖已满足的 pending 能推进到 doing 并写 started_at', () => {
    const g = goals.create({ title: '推进步骤', via: 'ui' });
    const v = makePlan(g.id);
    const ids = plans.stepsOf(g.id, v.version).map((s) => s.id);
    plans.setDeps(g.id, v.version, ids[2]!, [ids[0]!]); // C 依赖 A
    // 依赖没完成时不许推进
    expect(() => plans.advanceStep(ids[2]!)).toThrow();
    plans.advanceStep(ids[0]!);
    const a = plans.stepsOf(g.id, v.version).find((s) => s.id === ids[0]!)!;
    expect(a.status).toBe('doing');
    expect(a.started_at).toBeTruthy();
    // A 做完之后 C 才能推
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

describe('条件 7：重启后所有结构仍在', () => {
  it('关连接、重开、重读：目标、子目标、方案、步骤、依赖、事件全在', () => {
    const parent = goals.create({ title: '父目标', via: 'ui', progressMode: 'weighted' });
    const child = goals.create({ title: '子目标', via: 'ui', parentGoalId: parent.id });
    const v = plans.addVersion(parent.id, {
      reason: '第一版',
      assumptions: ['x'],
      steps: [{ title: '一' }, { title: '二' }],
    });
    const ids = plans.stepsOf(parent.id, v.version).map((s) => s.id);
    plans.setDeps(parent.id, v.version, ids[1]!, [ids[0]!]);
    goals.transition(parent.id, 'blocked', { decidedBy: 'agent', reason: '卡在额度上' });
    const eventsBefore = countEvents(parent.id);

    // 关掉、重开
    for (const d of opened.splice(0)) d.close();
    const again = open(dir);

    const p = again.goals.get(parent.id)!;
    expect(p.status).toBe('blocked');
    expect(p.blocked_reason).toContain('额度');
    expect(again.goals.childrenOf(parent.id).map((g) => g.id)).toEqual([child.id]);
    const steps = again.plans.stepsOf(parent.id, v.version);
    expect(steps.map((s) => s.id)).toEqual(ids);
    expect(again.plans.depsOf(ids[1]!)).toEqual([ids[0]!]);
    expect(
      (
        again.db
          .prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?')
          .get(parent.id) as {
          n: number;
        }
      ).n,
    ).toBe(eventsBefore);
  });
});

describe('条件 8：不同目标不串状态', () => {
  it('两个目标各挂一个任务、各自完成：进度互不影响；一个 blocked 不影响另一个', () => {
    const a = goals.create({ title: 'A', via: 'ui', progressMode: 'weighted' });
    const b = goals.create({ title: 'B', via: 'ui', progressMode: 'weighted' });
    goals.link(a.id, { kind: 'todo', refId: 'a1', weight: 1 });
    goals.link(a.id, { kind: 'todo', refId: 'a2', weight: 1 });
    goals.link(b.id, { kind: 'todo', refId: 'b1', weight: 1 });

    goals.setRefDone(a.id, { kind: 'todo', refId: 'a1' }, true);
    goals.recomputeProgress(a.id);
    goals.recomputeProgress(b.id);
    expect(goals.get(a.id)!.progress).toBe(50);
    expect(goals.get(b.id)!.progress).toBe(0);

    goals.transition(a.id, 'blocked', { decidedBy: 'agent', reason: 'A 卡住' });
    expect(goals.get(b.id)!.status).toBe('active');
    expect(goals.get(b.id)!.blocked_reason).toBeNull();
  });
});
