/**
 * G1a 验收条件（B 档：只推测试，整合方锁定后再写实现）。
 * 规格草案：docs/委派/G1-GoalEngine-草案.md 第 5 节「G1a」那一段。
 *
 * **这一单只管 Goal 核心**：`goals` + `goal_events` + `GoalStore`。
 * 不碰 `goal_links`（G1b）、不碰方案与步骤（G1c）、不算 weighted 进度（G1b）、不碰界面（G1e）。
 *
 * 钉死的接缝（实现必须照这个写，改名就等于改契约）：
 * - `migrate(db)` 之后有 `goals` / `goal_events`；**别的 G1 表一张都不许有**；
 * - `new GoalStore(db)`；`create` / `get` / `childrenOf` / `confirm` / `transition` / `setProgress` / `list`；
 * - 所有改状态的入口在同一个事务里；被拒时抛错且**不留 goal_event**。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type CoreDatabase } from '../../src/index.js';
import { GoalStore } from '../../src/goals/index.js';

let dir: string;
let db: CoreDatabase;
let goals: GoalStore;
const opened: CoreDatabase[] = [];

const open = (dataDir: string): { db: CoreDatabase; goals: GoalStore } => {
  const d = openDatabase(join(dataDir, 'ixaeon.db'));
  opened.push(d);
  migrate(d);
  return { db: d, goals: new GoalStore(d) };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1a-'));
  const o = open(dir);
  db = o.db;
  goals = o.goals;
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

const tablesNow = (): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);

describe('条件 1：迁移只加 goals 和 goal_events', () => {
  it('这两张在；G1b/G1c 的表一张都不许有（防止 G1a 把后面几单的表也建了）', () => {
    const tables = tablesNow();
    expect(tables).toContain('goals');
    expect(tables).toContain('goal_events');
    for (const t of ['goal_links', 'goal_plans', 'goal_steps', 'goal_step_deps']) {
      expect(tables, `${t} 属于别的单，G1a 不该建它`).not.toContain(t);
    }
  });

  it('goals 的列齐，且没有 evidence / blocking / milestone 的痕迹', () => {
    const cols = columnsOf('goals');
    for (const c of [
      'id',
      'title',
      'description',
      'origin',
      'confirmation',
      'confirmed_by_message_id',
      'confirmed_at',
      'status',
      'priority',
      'created_at',
      'updated_at',
      'target_date',
      'next_review_at',
      'confidence',
      'parent_goal_id',
      'parent_weight',
      'progress',
      'progress_mode',
      'blocked_reason',
      'watch',
      'watch_reason',
    ]) {
      expect(cols, `goals 缺列 ${c}`).toContain(c);
    }
    expect(
      cols.some((c) => /evidence|blocking|milestone/i.test(c)),
      '用户定：evidence-based / blocking 连字段都不造',
    ).toBe(false);
  });

  it('已有任务表结构完全不改：coding_tasks / todos 没有 goal 相关的列', () => {
    const coding = columnsOf('coding_tasks');
    const todos = columnsOf('todos');
    for (const cols of [coding, todos]) {
      expect(cols).not.toContain('goal_id');
      expect(cols).not.toContain('subgoal_id');
      expect(cols).not.toContain('plan_version');
    }
    // coding_tasks.goal 本来就是「目标描述文本」，不能被占用成外键
    expect(coding).toContain('goal');
  });
});

describe('条件 2：origin 与 confirmation 正交', () => {
  it('UI 明确创建 → origin=user、confirmation=ui、直接 active，有 created 事件', () => {
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
    });
    const row = goals.get(g.id)!;
    expect(row.origin).toBe('agent');
    expect(row.confirmation).toBe('pending');
    expect(row.status).toBe('proposed');
    expect(row.confirmed_by_message_id).toBeNull();
  });

  it('两个维度独立：agent 提的能被 ui 确认；user 提的也能走 chat 确认', () => {
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

  it('数据库层面也拦：手写 SQL 造 active + pending 被 CHECK 拒', () => {
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

describe('条件 3：proposed 不能被 AI 激活（这一层的不变量）', () => {
  it('直接 transition(proposed → active, decidedBy=agent) 必须拒绝，且不留事件', () => {
    const g = goals.create({ title: 'AI 提的', origin: 'agent' });
    const before = countEvents(g.id);
    expect(() => goals.transition(g.id, 'active', { decidedBy: 'agent' })).toThrow();
    expect(goals.get(g.id)!.status).toBe('proposed');
    expect(goals.get(g.id)!.confirmation).toBe('pending');
    expect(countEvents(g.id), '被拒的迁移不该留下事件').toBe(before);
  });

  it('用户确认之后才能 active（chat 与 ui 两条都行）', () => {
    const g1 = goals.create({ title: 'A', origin: 'agent' });
    goals.confirm(g1.id, { how: 'chat', messageId: 'm-9' });
    expect(goals.get(g1.id)!.status).toBe('active');
    const g2 = goals.create({ title: 'B', origin: 'agent' });
    goals.confirm(g2.id, { how: 'ui' });
    expect(goals.get(g2.id)!.status).toBe('active');
  });
});

describe('条件 4：状态机', () => {
  it('proposed → completed 被拒；abandoned → active 被拒；blocked 没理由被拒', () => {
    const p = goals.create({ title: 'AI 提的', origin: 'agent' });
    expect(() => goals.transition(p.id, 'completed', { decidedBy: 'user' })).toThrow();

    const a = goals.create({ title: '不要了', via: 'ui' });
    goals.transition(a.id, 'abandoned', { decidedBy: 'user' });
    expect(() => goals.transition(a.id, 'active', { decidedBy: 'user' })).toThrow();

    const b = goals.create({ title: '要做', via: 'ui' });
    expect(() => goals.transition(b.id, 'blocked', { decidedBy: 'agent' })).toThrow();
  });

  it('非法迁移事务回滚：连试几次被拒之后 goal_events 一行都没多', () => {
    const g = goals.create({ title: '要做', via: 'ui' });
    const before = countEvents(g.id);
    expect(() => goals.transition(g.id, 'blocked', { decidedBy: 'agent' })).toThrow(); // 没理由
    expect(() => goals.transition(g.id, 'proposed', { decidedBy: 'agent' })).toThrow(); // 回不去
    expect(() => goals.transition(g.id, 'abandoned', { decidedBy: 'system' })).toThrow(); // 系统不能替用户否决
    expect(countEvents(g.id), '被拒的迁移不该留下事件').toBe(before);
    expect(goals.get(g.id)!.status).toBe('active');
  });

  it('blocked 必须带理由，事件 decided_by 只能是 agent / user', () => {
    const g = goals.create({ title: '要做', via: 'ui' });
    goals.transition(g.id, 'blocked', { decidedBy: 'agent', reason: '等模型额度' });
    const row = goals.get(g.id)!;
    expect(row.status).toBe('blocked');
    expect(row.blocked_reason).toContain('额度');
    const ev = db
      .prepare(
        "SELECT decided_by FROM goal_events WHERE goal_id = ? AND kind = 'status' ORDER BY at DESC LIMIT 1",
      )
      .get(g.id) as { decided_by: string };
    expect(['agent', 'user']).toContain(ev.decided_by);
  });

  it('blocked → active 清空理由并记事件；completed 时 progress 置 100', () => {
    const g = goals.create({ title: '要做', via: 'ui' });
    goals.transition(g.id, 'blocked', { decidedBy: 'user', reason: '等模型额度' });
    const before = countEvents(g.id);
    goals.transition(g.id, 'active', { decidedBy: 'user' });
    expect(goals.get(g.id)!.blocked_reason).toBeNull();
    expect(countEvents(g.id)).toBeGreaterThan(before);

    goals.transition(g.id, 'completed', { decidedBy: 'user' });
    expect(goals.get(g.id)!.progress).toBe(100);
  });

  it('数据库层：blocked 但 blocked_reason 为空被 CHECK 拒', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO goals (id, title, description, origin, confirmation, status,
             priority, created_at, updated_at, progress, progress_mode, watch, blocked_reason)
           VALUES ('y', 't', '', 'user', 'ui', 'blocked', 0,
             '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 0, 'manual', 0, NULL)`,
        )
        .run(),
    ).toThrow();
  });
});

describe('条件 5：progress —— G1a 只有 manual，不算 weighted', () => {
  it('manual：setProgress 存进去就是那个值', () => {
    const g = goals.create({ title: '手填进度', via: 'ui', progressMode: 'manual' });
    goals.setProgress(g.id, 42);
    expect(goals.get(g.id)!.progress).toBe(42);
  });

  it('progress_mode=weighted 允许保存，但 G1a 不计算：存进去读出来还是原样', () => {
    const g = goals.create({ title: '以后按权重算', via: 'ui', progressMode: 'weighted' });
    goals.setProgress(g.id, 15);
    const row = goals.get(g.id)!;
    expect(row.progress_mode).toBe('weighted');
    expect(row.progress, 'G1a 不算 weighted，值保持原样').toBe(15);
  });

  it('GoalStore 上没有「按任务算进度」的接口（那是 G1b 的活）', () => {
    const g = goals.create({ title: 'x', via: 'ui' });
    expect((goals as unknown as { recomputeProgress?: unknown }).recomputeProgress).toBeUndefined();
    void g;
  });
});

describe('条件 6：父子关系', () => {
  it('parent_goal_id 建树，childrenOf 取得到；根目标 parent_weight 可为空、子目标默认 1', () => {
    const root = goals.create({ title: '父', via: 'ui' });
    const c1 = goals.create({ title: '子一', via: 'ui', parentGoalId: root.id });
    const c2 = goals.create({ title: '子二', via: 'ui', parentGoalId: root.id, parentWeight: 3 });
    expect(goals.get(root.id)!.parent_goal_id).toBeNull();
    expect(goals.get(c1.id)!.parent_weight).toBe(1);
    expect(goals.get(c2.id)!.parent_weight).toBe(3);
    expect(
      goals
        .childrenOf(root.id)
        .map((g) => g.id)
        .sort(),
    ).toEqual([c1.id, c2.id].sort());
  });

  it('parent_weight 传 0 或负数被拒', () => {
    const root = goals.create({ title: '父', via: 'ui' });
    expect(() =>
      goals.create({ title: '坏子', via: 'ui', parentGoalId: root.id, parentWeight: 0 }),
    ).toThrow();
    expect(() =>
      goals.create({ title: '坏子2', via: 'ui', parentGoalId: root.id, parentWeight: -1 }),
    ).toThrow();
  });
});

describe('条件 7：重启后仍在', () => {
  it('关连接、重开、重读：目标、子目标、状态、事件全在', () => {
    const parent = goals.create({ title: '父目标', via: 'ui' });
    const child = goals.create({ title: '子目标', via: 'ui', parentGoalId: parent.id });
    goals.transition(parent.id, 'blocked', { decidedBy: 'agent', reason: '卡在额度上' });
    const eventsBefore = countEvents(parent.id);

    for (const d of opened.splice(0)) d.close();
    const again = open(dir);

    const p = again.goals.get(parent.id)!;
    expect(p.status).toBe('blocked');
    expect(p.blocked_reason).toContain('额度');
    expect(again.goals.childrenOf(parent.id).map((g) => g.id)).toEqual([child.id]);
    expect(
      (
        again.db
          .prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?')
          .get(parent.id) as { n: number }
      ).n,
    ).toBe(eventsBefore);
  });
});

describe('条件 8：不同 Goal 不串状态', () => {
  it('一个 blocked 不影响另一个；两个目标的状态各算各的', () => {
    const a = goals.create({ title: 'A', via: 'ui' });
    const b = goals.create({ title: 'B', via: 'ui' });
    goals.transition(a.id, 'blocked', { decidedBy: 'agent', reason: 'A 卡住' });
    expect(goals.get(b.id)!.status).toBe('active');
    expect(goals.get(b.id)!.blocked_reason).toBeNull();
    expect(goals.get(a.id)!.status).toBe('blocked');
  });
});

describe('条件 9：列表与筛选', () => {
  it('list 能按状态筛，proposed 与 active 分开拿', () => {
    goals.create({ title: '自己建的', via: 'ui' });
    goals.create({ title: 'AI 提的', origin: 'agent' });
    expect(goals.list({ status: 'active' }).map((g) => g.title)).toEqual(['自己建的']);
    expect(goals.list({ status: 'proposed' }).map((g) => g.title)).toEqual(['AI 提的']);
  });
});
