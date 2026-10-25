import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { TodoStore } from '../storage/todoStore.js';
import { CodingTaskStore } from '../execution/taskStore.js';
import { ResearchStore } from '../research/researchStore.js';
import type { Goal } from './types.js';

export type GoalTaskRef = { kind: 'todo' | 'coding_task' | 'research_topic'; refId: string };
type TaskState = { done: boolean; failed: boolean; version: string; reason: string | null };

function state(db: CoreDatabase, ref: GoalTaskRef): TaskState {
  if (ref.kind === 'todo') {
    const task = new TodoStore(db).get(ref.refId);
    return { done: task.status === 'done', failed: false, version: task.updated_at, reason: null };
  }
  if (ref.kind === 'coding_task') {
    const task = new CodingTaskStore(db).get(ref.refId);
    return {
      done: task.status === 'completed',
      failed: task.status === 'failed',
      version: task.updated_at,
      reason: task.error,
    };
  }
  if (ref.kind === 'research_topic') {
    new ResearchStore(db).getTopic(ref.refId);
    throw new IxaError(
      ErrorCodes.CONFLICT,
      '研究主题没有完成态；需明确 weighted 完成口径后才能计算',
    );
  }
  throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'goal_links 只允许已有任务种类');
}

function requireGoal(db: CoreDatabase, id: string): Goal {
  const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(id) as Goal | undefined;
  if (!goal) throw new IxaError(ErrorCodes.NOT_FOUND, '目标不存在');
  return goal;
}

export function linkTask(
  db: CoreDatabase,
  goalId: string,
  ref: GoalTaskRef & { weight?: number },
): void {
  db.transaction(() => {
    requireGoal(db, goalId);
    if (
      !['todo', 'coding_task', 'research_topic'].includes(ref.kind) ||
      ref.refId.startsWith('goal:')
    ) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '子目标只能由 parent_goal_id 表达');
    }
    const weight = ref.weight ?? 1;
    if (!Number.isSafeInteger(weight) || weight <= 0)
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '任务权重须为正整数');
    if (ref.kind === 'research_topic') new ResearchStore(db).getTopic(ref.refId);
    else state(db, ref);
    db.prepare(
      `INSERT INTO goal_links (goal_id, kind, ref_id, weight, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(goal_id, kind, ref_id) DO UPDATE SET weight=excluded.weight`,
    ).run(goalId, ref.kind, ref.refId, weight, new Date().toISOString());
  })();
}

export function unlinkTask(db: CoreDatabase, goalId: string, ref: GoalTaskRef): void {
  db.transaction(() => {
    requireGoal(db, goalId);
    db.prepare('DELETE FROM goal_links WHERE goal_id=? AND kind=? AND ref_id=?').run(
      goalId,
      ref.kind,
      ref.refId,
    );
  })();
}

/** 相同任务的同一次状态观察只记一次事件；从不把调用方声称的 done/failed 当真值。 */
function observe(db: CoreDatabase, goalId: string, ref: GoalTaskRef, task: TaskState): void {
  const kind = task.failed ? 'task_failed' : task.done ? 'task_done' : null;
  if (!kind) return;
  const detail = JSON.stringify({ taskUpdatedAt: task.version, reason: task.reason });
  if (
    db
      .prepare(
        `SELECT 1 FROM goal_events WHERE goal_id=? AND kind=? AND ref_kind=? AND ref_id=? AND detail_json=?`,
      )
      .get(goalId, kind, ref.kind, ref.refId, detail)
  )
    return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO goal_events (id, goal_id, at, kind, decided_by, ref_kind, ref_id, summary, detail_json)
    VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    goalId,
    now,
    kind,
    ref.kind,
    ref.refId,
    `${ref.kind}:${ref.refId} ${kind}`,
    detail,
  );
  if (task.failed) {
    const current = db
      .prepare('SELECT watch_reason, next_review_at FROM goals WHERE id=?')
      .get(goalId) as { watch_reason: string | null; next_review_at: string | null };
    const reason = [current.watch_reason, `${ref.kind}:${ref.refId}：${task.reason ?? '任务失败'}`]
      .filter(Boolean)
      .join('\n');
    db.prepare(
      `UPDATE goals SET watch=1, watch_reason=?, next_review_at=?, updated_at=? WHERE id=?`,
    ).run(
      reason,
      current.next_review_at && current.next_review_at < now ? current.next_review_at : now,
      now,
      goalId,
    );
  }
}

export function noteTaskFailure(db: CoreDatabase, goalId: string, ref: GoalTaskRef): void {
  db.transaction(() => {
    requireGoal(db, goalId);
    if (
      !db
        .prepare('SELECT 1 FROM goal_links WHERE goal_id=? AND kind=? AND ref_id=?')
        .get(goalId, ref.kind, ref.refId)
    ) {
      throw new IxaError(ErrorCodes.NOT_FOUND, '任务没有关联到此目标');
    }
    const task = state(db, ref);
    if (!task.failed)
      throw new IxaError(ErrorCodes.CONFLICT, '真实任务状态不是 failed，不记录失败');
    observe(db, goalId, ref, task);
  })();
}

/** 按需读取真实 Store；不启动任务、不改变 Goal 状态，不把研究一轮成功猜成主题完成。 */
export function recompute(db: CoreDatabase, goalId: string): Goal {
  return db.transaction(() => {
    const goal = requireGoal(db, goalId);
    const links = db
      .prepare('SELECT kind, ref_id AS refId, weight FROM goal_links WHERE goal_id=?')
      .all(goalId) as (GoalTaskRef & { weight: number })[];
    // 先校验所有来源，研究口径未定时整体拒绝，不留下半套事件/进度。
    const observations = links.map((ref) => ({ ref, task: state(db, ref) }));
    for (const { ref, task } of observations) observe(db, goalId, ref, task);
    if (goal.progress_mode === 'manual') return requireGoal(db, goalId);
    const children = db
      .prepare('SELECT status, parent_weight FROM goals WHERE parent_goal_id=?')
      .all(goalId) as { status: string; parent_weight: number | null }[];
    let total = 0;
    let done = 0;
    for (const { ref, task } of observations) {
      total += ref.weight;
      if (task.done) done += ref.weight;
    }
    for (const child of children) {
      if (child.parent_weight == null)
        throw new IxaError(ErrorCodes.CONFLICT, '子目标缺少 parent_weight');
      total += child.parent_weight;
      if (child.status === 'completed') done += child.parent_weight;
    }
    if (!total) return requireGoal(db, goalId);
    const progress = Math.round((100 * done) / total);
    if (progress !== goal.progress) {
      const now = new Date().toISOString();
      db.prepare('UPDATE goals SET progress=?, updated_at=? WHERE id=?').run(progress, now, goalId);
      db.prepare(
        `INSERT INTO goal_events (id, goal_id, at, kind, decided_by, summary, detail_json)
        VALUES (?, ?, ?, 'progress', 'system', ?, ?)`,
      ).run(
        randomUUID(),
        goalId,
        now,
        `进度 ${progress}%`,
        JSON.stringify({ total, done, progress }),
      );
    }
    return requireGoal(db, goalId);
  })();
}
