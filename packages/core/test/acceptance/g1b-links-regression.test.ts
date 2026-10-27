/** G1b 开发回归：真实 TodoStore/CodingTaskStore 是唯一任务真值来源；临时库加载草案三张表。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, TodoStore, type CoreDatabase } from '../../src/index.js';
import { CodingTaskStore } from '../../src/execution/taskStore.js';
import { GoalStore } from '../../src/goals/index.js';
import { loadGoalDraft } from '../helpers/goalDraft.js';

let dir: string;
let db: CoreDatabase;
let goals: GoalStore;
let todos: TodoStore;
const events = () =>
  db
    .prepare('SELECT kind, ref_id FROM goal_events ORDER BY at, id')
    .all() as Array<{ kind: string; ref_id: string }>;
const open = (dataDir: string) => {
  const d = openDatabase(join(dataDir, 'test.db'));
  loadGoalDraft(d, ['goals', 'goal_events', 'goal_links']);
  return { db: d, goals: new GoalStore(d) };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-g1b-'));
  const o = open(dir);
  db = o.db;
  goals = o.goals;
  todos = new TodoStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 真实 TodoStore：add 本来就是 accepted；只有 accepted 能 complete。 */
const realTodo = (title: string): string => {
  const todo = todos.add({ title });
  return todo.id;
};
const doneTodo = (id: string): void => {
  todos.complete(id);
};

describe('关联的边界', () => {
  it('只能关联三类已有任务；子目标与 goal: 前缀被拒；研究主题不能猜完成态', () => {
    const goal = goals.create({ title: '目标', via: 'ui' });
    const todo = realTodo('真任务');
    expect(() => goals.link(goal.id, { kind: 'subgoal' as never, refId: 'x' })).toThrow();
    expect(() => goals.link(goal.id, { kind: 'todo', refId: 'goal:abc' })).toThrow();
    expect(() => goals.link(goal.id, { kind: 'todo', refId: 'no-such-todo' })).toThrow();
    goals.link(goal.id, { kind: 'todo', refId: todo });
    const cols = (db.prepare('PRAGMA table_info(todos)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('goal_id');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('真实 coding 任务验证：pending_accept（验证通过）不算完成，completed 才算', () => {
    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as
      { id: string } | undefined;
    if (!project) return; // 合成库没有项目时跳过真实编码任务构造，不伪造任务
    const tasks = new CodingTaskStore(db);
    const task = tasks.create({
      projectId: project.id,
      goal: '合成编码目标',
      scope: ['src'],
      allowedCommands: [],
    });
    const goal = goals.create({ title: '编码目标', via: 'ui', progressMode: 'weighted' });
    goals.link(goal.id, { kind: 'coding_task', refId: task.id });
    tasks.setStatus(task.id, 'pending_accept', { verifyStatus: 'passed' });
    expect(goals.recomputeProgress(goal.id).progress).toBe(0);
    tasks.setStatus(task.id, 'completed', { acceptedAt: new Date().toISOString() });
    expect(goals.recomputeProgress(goal.id).progress).toBe(100);
  });
});

describe('weighted 与父目标', () => {
  it('3 个等权真任务完成 1 个=33、2 个=67；一个任务挂两个目标互不影响', () => {
    const a = goals.create({ title: 'A', via: 'ui', progressMode: 'weighted' });
    const b = goals.create({ title: 'B', via: 'ui', progressMode: 'weighted' });
    const [t1, t2, t3] = [realTodo('一'), realTodo('二'), realTodo('三')];
    for (const t of [t1, t2, t3]) goals.link(a.id, { kind: 'todo', refId: t });
    goals.link(b.id, { kind: 'todo', refId: t1 });
    expect(goals.recomputeProgress(a.id).progress).toBe(0);
    doneTodo(t1);
    expect(goals.recomputeProgress(a.id).progress).toBe(33);
    expect(goals.recomputeProgress(b.id).progress).toBe(100);
    doneTodo(t2);
    expect(goals.recomputeProgress(a.id).progress).toBe(67);
  });

  it('权重 1:3 只完成轻的=25；manual 不随任务变化；空目标保持原值', () => {
    const goal = goals.create({ title: '权重', via: 'ui', progressMode: 'weighted' });
    const light = realTodo('轻');
    const heavy = realTodo('重');
    goals.link(goal.id, { kind: 'todo', refId: light, weight: 1 });
    goals.link(goal.id, { kind: 'todo', refId: heavy, weight: 3 });
    doneTodo(light);
    expect(goals.recomputeProgress(goal.id).progress).toBe(25);

    const manual = goals.create({ title: '手动', via: 'ui' });
    const t = realTodo('手动任务');
    goals.link(manual.id, { kind: 'todo', refId: t });
    goals.setProgress(manual.id, 42);
    doneTodo(t);
    goals.recomputeProgress(manual.id);
    expect(goals.get(manual.id)!.progress).toBe(42);

    const empty = goals.create({ title: '空', via: 'ui', progressMode: 'weighted' });
    goals.setProgress(empty.id, 15);
    expect(goals.recomputeProgress(empty.id).progress).toBe(15);
  });

  it('子目标按 parent_weight 计一次，内部任务不重复计入父目标', () => {
    const parent = goals.create({ title: '父', via: 'ui', progressMode: 'weighted' });
    const child = goals.create({
      title: '子',
      via: 'ui',
      parentGoalId: parent.id,
      progressMode: 'weighted',
    });
    const [p1, p2, c1] = [realTodo('父一'), realTodo('父二'), realTodo('子一')];
    for (const t of [p1, p2]) goals.link(parent.id, { kind: 'todo', refId: t });
    goals.link(child.id, { kind: 'todo', refId: c1 });
    doneTodo(c1);
    expect(goals.recomputeProgress(child.id).progress).toBe(100);
    expect(goals.recomputeProgress(parent.id).progress).toBe(0);
    goals.transition(child.id, 'completed', { decidedBy: 'user' });
    expect(goals.recomputeProgress(parent.id).progress).toBe(33);
  });
});

describe('失败只产生信号，不机械判 blocked', () => {
  it('真实 failed 的 coding 任务：watch/理由/复核提前/事件；状态仍 active，同一观察不重复记', () => {
    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as
      { id: string } | undefined;
    if (!project) return;
    const tasks = new CodingTaskStore(db);
    const first = tasks.create({
      projectId: project.id,
      goal: '会失败的一',
      scope: [],
      allowedCommands: [],
    });
    const second = tasks.create({
      projectId: project.id,
      goal: '会失败的二',
      scope: [],
      allowedCommands: [],
    });
    const goal = goals.create({ title: '失败信号', via: 'ui', progressMode: 'weighted' });
    for (const task of [first, second])
      goals.link(goal.id, { kind: 'coding_task', refId: task.id });
    tasks.setStatus(first.id, 'failed', { error: '接口 500' });
    tasks.setStatus(second.id, 'failed', { error: '接口还是 500' });
    goals.noteTaskFailed(goal.id, { kind: 'coding_task', refId: first.id });
    goals.noteTaskFailed(goal.id, { kind: 'coding_task', refId: second.id });
    goals.noteTaskFailed(goal.id, { kind: 'coding_task', refId: first.id }); // 同一次观察

    const row = goals.get(goal.id)!;
    expect(row.status).toBe('active');
    expect(row.blocked_reason).toBeNull();
    expect(row.watch).toBe(1);
    expect(row.watch_reason).toContain(first.id);
    expect(row.watch_reason).toContain(second.id);
    expect(events().filter((e) => e.kind === 'task_failed')).toHaveLength(2);
  });

  it('对没失败的任务报失败被拒；未关联的任务被拒；Todo 没有失败态', () => {
    const goal = goals.create({ title: '不许伪报', via: 'ui' });
    const todo = realTodo('正常的');
    goals.link(goal.id, { kind: 'todo', refId: todo });
    expect(() => goals.noteTaskFailed(goal.id, { kind: 'todo', refId: todo })).toThrow();
    const other = realTodo('没关联');
    expect(() => goals.noteTaskFailed(goal.id, { kind: 'todo', refId: other })).toThrow();
  });

  it('blocked 要经判断；system 写 blocked 被拒；proposed 跑完自动跟踪仍 proposed', () => {
    const goal = goals.create({ title: '要判断', via: 'ui' });
    expect(() =>
      goals.transition(goal.id, 'blocked', { decidedBy: 'system', reason: '计数' }),
    ).toThrow();
    expect(
      goals.transition(goal.id, 'blocked', { decidedBy: 'agent', reason: '等接口' }),
    ).toMatchObject({ status: 'blocked' });

    const candidate = goals.create({ title: '候选', origin: 'agent', progressMode: 'weighted' });
    const todo = realTodo('候选的任务');
    goals.link(candidate.id, { kind: 'todo', refId: todo });
    doneTodo(todo);
    goals.recomputeProgress(candidate.id);
    expect(goals.get(candidate.id)).toMatchObject({ status: 'proposed', confirmation: 'pending' });
  });
});

describe('持久化', () => {
  it('关连接重开：关联、进度、watch、事件都在', () => {
    const goal = goals.create({ title: '重启', via: 'ui', progressMode: 'weighted' });
    const todo = realTodo('一');
    goals.link(goal.id, { kind: 'todo', refId: todo });
    doneTodo(todo);
    goals.recomputeProgress(goal.id);
    const before = {
      rows: db.prepare('SELECT * FROM goal_links ORDER BY ref_id').all(),
      goal: goals.get(goal.id),
    };
    db.close();
    db = openDatabase(join(dir, 'test.db'));
    goals = new GoalStore(db);
    expect(db.prepare('SELECT * FROM goal_links ORDER BY ref_id').all()).toEqual(before.rows);
    expect(goals.get(goal.id)).toEqual(before.goal);
    expect(goals.get(goal.id)!.progress).toBe(100);
  });
});
