/**
 * G1b 验收条件（B 档：只推测试，整合方锁定后再写实现）。
 * 规格草案：docs/委派/G1-GoalEngine-草案.md 第 5 节「G1b」那一段。
 *
 * **这一单只管关联与 weighted 进度**：`goal_links` + 读真实任务状态 + `task_done`/`task_failed` 事件
 * + watch / watch_reason / next_review_at。
 *
 * 硬规矩（用户 2026-10-25 定）：
 * - **不许为了测试给 GoalStore 开「标记完成」这种后门**。任务的真值来源是 TodoStore / CodingTaskStore
 *   自己，所以这里的测试**用真实的 TodoStore 建任务、真的把它完成**。
 * - 子目标与父目标的权重用 `goals.parent_weight`，**不是** `goal_links`、也不是 `refId='goal:xxx'`。
 * - 失败**不机械判 blocked**：只产生 `watch` 信号 + 事件 + 提前复核。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  migrate,
  openDatabase,
  ProjectService,
  ResearchStore,
  TodoStore,
  type CoreDatabase,
} from '../../src/index.js';
import { CodingTaskStore } from '../../src/execution/taskStore.js';
import { GoalStore } from '../../src/goals/index.js';

let dir: string;
let db: CoreDatabase;
let goals: GoalStore;
let todos: TodoStore;
const opened: CoreDatabase[] = [];

const open = (dataDir: string) => {
  const d = openDatabase(join(dataDir, 'ixaeon.db'));
  opened.push(d);
  migrate(d);
  return { db: d, goals: new GoalStore(d), todos: new TodoStore(d) };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1b-'));
  const o = open(dir);
  db = o.db;
  goals = o.goals;
  todos = o.todos;
  projectId = null; // 每个测试是新库
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

/** 用**真实** TodoStore 建一个真任务（proposed → accepted），返回 id。 */
// 整合方改（2026-10-29，第一次对着实现跑才发现）：真实的 TodoStore.add 建出来就是 accepted，原来又调 accept 会抛错；
// 照注释的本意改成 propose → accept。
const realTodo = (title: string): string => {
  const t = todos.propose({ title });
  if (!t) throw new Error('propose 没建出待办');
  todos.accept(t.id);
  return t.id;
};

/** 用真实的 TodoStore 把任务做掉。 */
const reallyDone = (id: string): void => {
  todos.complete(id);
};

// 整合方补（2026-10-29）：「失败」只能来自真实任务自己的 Store。待办没有失败状态（用户 10-29 定：
// 完成、失败以真实 Store 和用户实际接受为准），所以失败都用真实的编码任务、真的置成 failed。
let projectId: string | null = null;
/** 用**真实** CodingTaskStore 建一个编码任务（需要一个合成项目，没有就建一个），返回 id。 */
const realCodingTask = (goal: string): string => {
  if (!projectId) {
    projectId = new ProjectService(db).create({
      name: 'G1b 合成项目',
      rootPath: null,
      description: null,
    }).id;
  }
  return new CodingTaskStore(db).create({
    projectId,
    goal,
    scope: ['README.md'],
    allowedCommands: [],
  }).id;
};
/** 用真实的 CodingTaskStore 让任务失败（原因写在任务自己的 error 上）。 */
const reallyFail = (id: string, error: string): void => {
  new CodingTaskStore(db).setStatus(id, 'failed', { error });
};

// 整合方改（Q3 门禁查出）：.get() 返回 unknown，原来直接取 .n 过不了类型检查
const countEvents = (goalId: string, kind?: string): number => {
  const row = kind
    ? db
        .prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ? AND kind = ?')
        .get(goalId, kind)
    : db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId);
  return (row as { n: number }).n;
};

describe('条件 1：goal_links 结构与 kind 的边界', () => {
  it('goal_links 在；kind 只能是 todo / coding_task / research_topic', () => {
    const cols = (db.prepare('PRAGMA table_info(goal_links)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const c of ['goal_id', 'kind', 'ref_id', 'weight', 'created_at']) {
      expect(cols, `goal_links 缺列 ${c}`).toContain(c);
    }
    const g = goals.create({ title: '挂任务', via: 'ui' });
    // subgoal 不是合法 kind（子目标只靠 parent_goal_id）
    expect(() => goals.link(g.id, { kind: 'subgoal' as never, refId: 'x', weight: 1 })).toThrow();
    // 用 refId='goal:xxx' 偷渡子目标也不许
    expect(() => goals.link(g.id, { kind: 'todo', refId: 'goal:abc', weight: 1 })).toThrow();
  });
});

describe('条件 2：用真实任务挂到目标（不走任何测试后门）', () => {
  it('真实 TodoStore 建的任务能挂上；任务表结构一点没变', () => {
    const g = goals.create({ title: '要任务', via: 'ui', progressMode: 'weighted' });
    const t1 = realTodo('把服务拆出来');
    goals.link(g.id, { kind: 'todo', refId: t1, weight: 1 });
    const links = db
      .prepare('SELECT kind, ref_id, weight FROM goal_links WHERE goal_id = ?')
      .all(g.id) as Array<{ kind: string; ref_id: string; weight: number }>;
    expect(links).toEqual([{ kind: 'todo', ref_id: t1, weight: 1 }]);

    // 任务表列不变（防止有人为了接线偷偷加列）
    const todoCols = (db.prepare('PRAGMA table_info(todos)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(todoCols).not.toContain('goal_id');
    expect(todoCols).not.toContain('plan_version');
  });

  it('一个任务能挂两个目标，互不影响', () => {
    const a = goals.create({ title: 'A', via: 'ui', progressMode: 'weighted' });
    const b = goals.create({ title: 'B', via: 'ui', progressMode: 'weighted' });
    const t = realTodo('同时服务两个目标');
    goals.link(a.id, { kind: 'todo', refId: t, weight: 1 });
    goals.link(a.id, { kind: 'todo', refId: realTodo('A 的另一个'), weight: 1 });
    goals.link(b.id, { kind: 'todo', refId: t, weight: 1 });

    reallyDone(t);
    goals.recomputeProgress(a.id);
    goals.recomputeProgress(b.id);
    expect(goals.get(a.id)!.progress).toBe(50);
    expect(goals.get(b.id)!.progress).toBe(100);
  });
});

describe('条件 3：weighted 进度（读真实任务状态）', () => {
  it('3 个等权真任务完成 1 个 → 33；完成 2 个 → 67', () => {
    const g = goals.create({ title: '按权重算', via: 'ui', progressMode: 'weighted' });
    const t1 = realTodo('一');
    const t2 = realTodo('二');
    const t3 = realTodo('三');
    for (const t of [t1, t2, t3]) goals.link(g.id, { kind: 'todo', refId: t, weight: 1 });

    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(0);
    reallyDone(t1);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(33);
    reallyDone(t2);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(67);
  });

  it('权重不等：1 + 3，完成权重 1 的 → 25', () => {
    const g = goals.create({ title: '权重不等', via: 'ui', progressMode: 'weighted' });
    const light = realTodo('轻');
    const heavy = realTodo('重');
    goals.link(g.id, { kind: 'todo', refId: light, weight: 1 });
    goals.link(g.id, { kind: 'todo', refId: heavy, weight: 3 });
    reallyDone(light);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(25);
  });

  it('一个任务都没挂：保持原值（不瞎算成 0）', () => {
    const g = goals.create({ title: '空的', via: 'ui', progressMode: 'weighted' });
    goals.setProgress(g.id, 15);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(15);
  });
});

describe('条件 4：子目标按 parent_weight 计一次（不重复计）', () => {
  it('子目标内部任务只算子目标；子目标完成后父按 parent_weight 计一次', () => {
    const parent = goals.create({ title: '父', via: 'ui', progressMode: 'weighted' });
    const child = goals.create({
      title: '子',
      via: 'ui',
      parentGoalId: parent.id,
      parentWeight: 1,
      progressMode: 'weighted', // 整合方改：子目标要按权重算才会到 100（原来是默认的 manual，重算不动它）
    });
    const p1 = realTodo('父的一');
    const p2 = realTodo('父的二');
    const c1 = realTodo('子的唯一');
    goals.link(parent.id, { kind: 'todo', refId: p1, weight: 1 });
    goals.link(parent.id, { kind: 'todo', refId: p2, weight: 1 });
    goals.link(child.id, { kind: 'todo', refId: c1, weight: 1 });

    // 子的任务完成：只动子
    reallyDone(c1);
    goals.recomputeProgress(child.id);
    goals.recomputeProgress(parent.id);
    expect(goals.get(child.id)!.progress).toBe(100);
    expect(goals.get(parent.id)!.progress, '子目标内部的任务不该直接算进父目标').toBe(0);

    // 子目标完成：父按 parent_weight 计一次（父里共 p1、p2、child 三项，权重各 1）
    goals.transition(child.id, 'completed', { decidedBy: 'user' });
    goals.recomputeProgress(parent.id);
    expect(goals.get(parent.id)!.progress).toBe(33);
  });

  it('parent_weight 大的子目标权重更大', () => {
    const parent = goals.create({ title: '父', via: 'ui', progressMode: 'weighted' });
    const c1 = goals.create({ title: '子一', via: 'ui', parentGoalId: parent.id, parentWeight: 1 });
    const c2 = goals.create({ title: '子二', via: 'ui', parentGoalId: parent.id, parentWeight: 3 });
    goals.transition(c1.id, 'completed', { decidedBy: 'user' });
    goals.recomputeProgress(parent.id);
    // 1 / (1 + 3) → 25
    expect(goals.get(parent.id)!.progress).toBe(25);
    goals.transition(c2.id, 'completed', { decidedBy: 'user' });
    goals.recomputeProgress(parent.id);
    expect(goals.get(parent.id)!.progress).toBe(100);
  });
});

describe('条件 5：任务失败只产生信号，不机械判 blocked（用户硬要求）', () => {
  it('2 个任务失败 → 状态仍是 active，但 watch=1、理由写明是哪两个、复核提前、2 条 task_failed 事件', () => {
    const g = goals.create({ title: '会失败的', via: 'ui', progressMode: 'weighted' });
    // 整合方改：失败来自真实编码任务（待办没有失败状态）
    const t1 = realCodingTask('会失败的一');
    const t2 = realCodingTask('会失败的二');
    goals.link(g.id, { kind: 'coding_task', refId: t1, weight: 1 });
    goals.link(g.id, { kind: 'coding_task', refId: t2, weight: 1 });
    const reviewBefore = goals.get(g.id)!.next_review_at;

    reallyFail(t1, '接口 500');
    reallyFail(t2, '接口还是 500');
    goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: t1 });
    goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: t2 });

    const row = goals.get(g.id)!;
    expect(row.status, '失败不该把状态改成 blocked').toBe('active');
    expect(row.blocked_reason).toBeNull();
    expect(row.watch).toBe(1);
    expect(row.watch_reason).toContain(t1);
    expect(row.watch_reason).toContain(t2);
    expect(row.next_review_at).toBeTruthy();
    if (reviewBefore)
      expect(Date.parse(row.next_review_at!)).toBeLessThanOrEqual(Date.parse(reviewBefore));
    expect(countEvents(g.id, 'task_failed')).toBe(2);
  });

  it('一个任务失败就够触发 watch（不是必须两个）', () => {
    const g = goals.create({ title: '一个失败', via: 'ui' });
    const t = realCodingTask('会失败');
    goals.link(g.id, { kind: 'coding_task', refId: t, weight: 1 });
    reallyFail(t, '挂了');
    goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: t });
    expect(goals.get(g.id)!.watch).toBe(1);
    expect(goals.get(g.id)!.status).toBe('active');
  });

  // 整合方补（用户 10-29 定：失败以真实 Store 为准）：任务没真失败，就不许记失败
  it('任务真实状态不是 failed（待办、还在排队的编码任务）→ 记失败被拒，不亮 watch、不留事件', () => {
    const g = goals.create({ title: '没失败的', via: 'ui' });
    const todo = realTodo('待办没有失败状态');
    const queued = realCodingTask('还没跑');
    goals.link(g.id, { kind: 'todo', refId: todo, weight: 1 });
    goals.link(g.id, { kind: 'coding_task', refId: queued, weight: 1 });
    expect(() => goals.noteTaskFailed(g.id, { kind: 'todo', refId: todo })).toThrow();
    expect(() => goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: queued })).toThrow();
    expect(goals.get(g.id)!.watch).toBe(0);
    expect(countEvents(g.id, 'task_failed')).toBe(0);
  });
});

describe('条件 6：blocked 必须经判断，system 不许直接写', () => {
  it('复核给出结论后写 blocked 成功（decided_by=agent）；system 直接写抛错', () => {
    const g = goals.create({ title: '要判断的', via: 'ui' });
    const t = realCodingTask('失败的任务');
    goals.link(g.id, { kind: 'coding_task', refId: t, weight: 1 });
    reallyFail(t, '外部接口 500');
    goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: t });
    expect(goals.get(g.id)!.status).toBe('active');

    // 判断：由 agent 在复核时写 blocked
    goals.transition(g.id, 'blocked', {
      decidedBy: 'agent',
      reason: '外部接口连续 500，等对方修',
    });
    expect(goals.get(g.id)!.status).toBe('blocked');
    expect(goals.get(g.id)!.blocked_reason).toContain('500');

    const g2 = goals.create({ title: '另一个', via: 'ui' });
    expect(() =>
      goals.transition(g2.id, 'blocked', { decidedBy: 'system', reason: '自动判的' }),
    ).toThrow();
    expect(goals.get(g2.id)!.status).toBe('active');
  });

  it('解除 blocked 之后 watch 也清掉', () => {
    const g = goals.create({ title: '要解除', via: 'ui' });
    goals.transition(g.id, 'blocked', { decidedBy: 'agent', reason: '等接口' });
    goals.transition(g.id, 'active', { decidedBy: 'user' });
    const row = goals.get(g.id)!;
    expect(row.blocked_reason).toBeNull();
    expect(row.watch, '解除阻塞之后疑点也该清').toBe(0);
  });
});

describe('条件 7：proposed 不能被自动流程激活（分层不变量 G1b 那一层）', () => {
  it('自动跟踪与进度重算跑完，proposed 仍是 proposed', () => {
    const g = goals.create({ title: 'AI 提的', origin: 'agent', progressMode: 'weighted' });
    expect(goals.get(g.id)!.status).toBe('proposed');
    const t = realTodo('挂上去的任务');
    goals.link(g.id, { kind: 'todo', refId: t, weight: 1 });
    reallyDone(t);
    goals.recomputeProgress(g.id);
    // 整合方改：原来对做完的待办「假装失败」，换成一个真失败的编码任务
    const failed = realCodingTask('真失败的');
    goals.link(g.id, { kind: 'coding_task', refId: failed, weight: 1 });
    reallyFail(failed, '真的失败了');
    goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: failed });
    goals.recomputeProgress(g.id);
    const row = goals.get(g.id)!;
    expect(row.status).toBe('proposed');
    expect(row.confirmation).toBe('pending');
  });
});

describe('条件 8：重启后关联与进度仍在', () => {
  it('关连接、重开：goal_links、progress、watch 全在', () => {
    const g = goals.create({ title: '重启', via: 'ui', progressMode: 'weighted' });
    const t1 = realTodo('一');
    const t2 = realCodingTask('二'); // 整合方改：失败的那个用真实编码任务
    goals.link(g.id, { kind: 'todo', refId: t1, weight: 1 });
    goals.link(g.id, { kind: 'coding_task', refId: t2, weight: 1 });
    reallyDone(t1);
    reallyFail(t2, '挂了');
    goals.recomputeProgress(g.id);
    goals.noteTaskFailed(g.id, { kind: 'coding_task', refId: t2 });
    const before = goals.get(g.id)!;

    for (const d of opened.splice(0)) d.close();
    const again = open(dir);
    const after = again.goals.get(g.id)!;
    expect(after.progress).toBe(before.progress);
    expect(after.progress).toBe(50);
    expect(after.watch).toBe(1);
    expect(
      (
        again.db.prepare('SELECT COUNT(*) AS n FROM goal_links WHERE goal_id = ?').get(g.id) as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });
});

describe('整合方补（用户 2026-10-29 定的口径）', () => {
  it('研究话题能挂到目标上，但不进 weighted 进度的分子分母，挂着也不让重算出错', () => {
    const g = goals.create({ title: '挂研究话题', via: 'ui', progressMode: 'weighted' });
    const done = realTodo('做完的');
    const open = realTodo('没做完的');
    const topic = new ResearchStore(db).createTopic({
      question: '要不要给 IXAEON 加 NAS 节点',
      publicDescription: 'g1b synthetic topic',
      sources: [],
    });
    goals.link(g.id, { kind: 'todo', refId: done, weight: 1 });
    goals.link(g.id, { kind: 'todo', refId: open, weight: 1 });
    goals.link(g.id, { kind: 'research_topic', refId: topic.id, weight: 5 });
    reallyDone(done);
    expect(() => goals.recomputeProgress(g.id)).not.toThrow();
    // 只算两个待办：1 / 2 → 50（研究话题权重 5 若被算进分母就会变成 14）
    expect(goals.get(g.id)!.progress).toBe(50);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM goal_links WHERE goal_id = ? AND kind = 'research_topic'",
          )
          .get(g.id) as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('只挂了研究话题的目标：分母为 0，进度保持原值、不出错', () => {
    const g = goals.create({ title: '只有研究', via: 'ui', progressMode: 'weighted' });
    goals.setProgress(g.id, 20);
    const topic = new ResearchStore(db).createTopic({
      question: '值不值得持续看',
      publicDescription: 'g1b synthetic topic 2',
      sources: [],
    });
    goals.link(g.id, { kind: 'research_topic', refId: topic.id, weight: 1 });
    expect(() => goals.recomputeProgress(g.id)).not.toThrow();
    expect(goals.get(g.id)!.progress).toBe(20);
  });

  it('编码任务以用户实际接受为准：验证通过、待接受不算完成；接受了（completed）才算', () => {
    const g = goals.create({ title: '编码任务', via: 'ui', progressMode: 'weighted' });
    const t = realCodingTask('合成编码任务');
    goals.link(g.id, { kind: 'coding_task', refId: t, weight: 1 });
    const tasks = new CodingTaskStore(db);
    tasks.setStatus(t, 'pending_accept', { verifyStatus: 'passed' });
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress, '等用户接受的不算完成').toBe(0);
    tasks.setStatus(t, 'completed', { acceptedAt: new Date().toISOString() });
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(100);
    expect(countEvents(g.id, 'task_done')).toBe(1);
  });
});

describe('整合方补：G1b 的迁移只加 goal_links', () => {
  it('goal-links 这一号迁移相对 goals-core 只多了 goal_links 一张表；kind 的 CHECK 拦非法值', () => {
    const idOf = (name: string): number => {
      const row = db.prepare('SELECT id FROM schema_migrations WHERE name = ?').get(name) as
        { id: number } | undefined;
      if (!row) throw new Error(`迁移里没有 ${name}`);
      return row.id;
    };
    const tablesUpTo = (upTo: number): string[] => {
      const d = openDatabase(join(dir, `upto-${upTo}.db`));
      opened.push(d);
      migrate(d, upTo);
      return (
        d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((t) => t.name);
    };
    const before = new Set(tablesUpTo(idOf('goals-core')));
    const added = tablesUpTo(idOf('goal-links')).filter((t) => !before.has(t));
    expect(added).toEqual(['goal_links']);
    const g = goals.create({ title: '直接写库', via: 'ui' });
    expect(() =>
      db
        .prepare(
          "INSERT INTO goal_links (goal_id, kind, ref_id, weight, created_at) VALUES (?, 'subgoal', 'x', 1, '2026-10-29T00:00:00Z')",
        )
        .run(g.id),
    ).toThrow();
  });
});

describe('整合方补（变异检查漏的）：manual 进度不被重算', () => {
  it('manual 的目标挂着做完的任务，重算之后进度还是人填的值（只记事件）', () => {
    const g = goals.create({ title: '手填', via: 'ui', progressMode: 'manual' });
    goals.setProgress(g.id, 10);
    const t = realTodo('做完的');
    goals.link(g.id, { kind: 'todo', refId: t, weight: 1 });
    reallyDone(t);
    goals.recomputeProgress(g.id);
    expect(goals.get(g.id)!.progress).toBe(10);
    expect(countEvents(g.id, 'task_done')).toBe(1);
  });
});
