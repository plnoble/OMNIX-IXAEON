import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type { AddVersionInput, Plan, PlanStep, StepLink, StepStatus } from './planTypes.js';

function invalid(message: string): never {
  throw new IxaError(ErrorCodes.VALIDATION_FAILED, message);
}
function conflict(message: string): never {
  throw new IxaError(ErrorCodes.CONFLICT, message);
}

/**
 * G1c 内部存储：目标的多版本方案与可操作步骤（草案 3.3 / 3.8）。
 *
 * 硬规矩（用户 2026-10-25 定）：
 * - 旧版本一律保留：新版本把上一版标 superseded，旧的行一个字不删；
 * - 历史版本只读：只有 current 版本可以改步骤/依赖/重排/推进；
 * - Step ID 永久稳定；重排单事务、两阶段**正数**临时序号（表上有 CHECK(seq>0)），
 *   绝不删除重建（依赖、绑定、状态都挂在 Step 上）；
 * - 只改内部方案状态，不启动真实任务、不改 Goal 状态。
 */
export class PlanStore {
  constructor(private readonly db: CoreDatabase) {}

  addVersion(goalId: string, input: AddVersionInput): Plan {
    return this.db.transaction(() => {
      this.requireGoal(goalId);
      const reason = input.reason?.trim();
      if (!reason) invalid('新方案必须写明重规划理由');
      if (input.steps.length === 0) invalid('新方案至少要有一个步骤');
      const now = new Date().toISOString();
      const last = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM goal_plans WHERE goal_id = ?')
        .get(goalId) as { v: number };
      const version = last.v + 1;
      this.db
        .prepare(
          `UPDATE goal_plans SET status = 'superseded', superseded_by = ?
           WHERE goal_id = ? AND status = 'current'`,
        )
        .run(version, goalId);
      this.db
        .prepare(
          `INSERT INTO goal_plans (goal_id, version, created_at, reason, assumptions_json, status, superseded_by)
           VALUES (?, ?, ?, ?, ?, 'current', NULL)`,
        )
        .run(goalId, version, now, reason, JSON.stringify(input.assumptions ?? []));
      const insert = this.db.prepare(
        `INSERT INTO goal_steps (id, goal_id, plan_version, seq, title, detail, status,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      );
      input.steps.forEach((step, index) => {
        const title = step.title?.trim();
        if (!title) invalid(`第 ${index + 1} 步没有标题`);
        insert.run(randomUUID(), goalId, version, index + 1, title, step.detail ?? '', now, now);
      });
      this.event(goalId, 'plan', `排了第 ${version} 版方案：${reason}`);
      return this.getPlan(goalId, version);
    })();
  }

  getPlan(goalId: string, version: number): Plan {
    const plan = this.db
      .prepare('SELECT * FROM goal_plans WHERE goal_id = ? AND version = ?')
      .get(goalId, version) as Plan | undefined;
    if (!plan) throw new IxaError(ErrorCodes.NOT_FOUND, '方案版本不存在');
    return plan;
  }

  plansOf(goalId: string): Plan[] {
    return this.db
      .prepare('SELECT * FROM goal_plans WHERE goal_id = ? ORDER BY version')
      .all(goalId) as Plan[];
  }

  stepsOf(goalId: string, version: number): PlanStep[] {
    return this.db
      .prepare('SELECT * FROM goal_steps WHERE goal_id = ? AND plan_version = ? ORDER BY seq')
      .all(goalId, version) as PlanStep[];
  }

  bindStep(goalId: string, version: number, stepId: string, link: StepLink): void {
    this.db.transaction(() => {
      this.requireCurrentStep(goalId, version, stepId);
      if (!['todo', 'coding_task', 'research_topic'].includes(link.kind))
        invalid('只能关联已有任务种类');
      const table = {
        todo: 'todos',
        coding_task: 'coding_tasks',
        research_topic: 'research_topics',
      }[link.kind];
      if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(link.refId))
        invalid('关联的任务不存在');
      this.db
        .prepare(
          'UPDATE goal_steps SET linked_kind = ?, linked_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(link.kind, link.refId, new Date().toISOString(), stepId);
    })();
  }

  /** 整体替换这一步的依赖；成环或引用别的版本被拒。 */
  setDeps(goalId: string, version: number, stepId: string, dependsOn: string[]): void {
    this.db.transaction(() => {
      this.requireCurrentStep(goalId, version, stepId);
      for (const dep of dependsOn) {
        if (dep === stepId) invalid('步骤不能依赖自己');
        this.requireCurrentStep(goalId, version, dep);
      }
      this.db.prepare('DELETE FROM goal_step_deps WHERE step_id = ?').run(stepId);
      const insert = this.db.prepare(
        'INSERT INTO goal_step_deps (step_id, depends_on_step_id) VALUES (?, ?)',
      );
      for (const dep of dependsOn) insert.run(stepId, dep);
      if (this.hasCycle(goalId, version)) conflict('步骤依赖成环');
    })();
  }

  depsOf(stepId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT depends_on_step_id FROM goal_step_deps WHERE step_id = ? ORDER BY depends_on_step_id',
        )
        .all(stepId) as { depends_on_step_id: string }[]
    ).map((row) => row.depends_on_step_id);
  }

  /**
   * 重排：单事务两阶段。先把本版所有步骤挪到 max(seq)+1 之上的正数临时区，
   * 再回填 1..n —— 全程不删行、不动 id，也不撞 UNIQUE(goal_id, plan_version, seq)。
   */
  reorderSteps(goalId: string, version: number, orderedStepIds: string[]): void {
    this.db.transaction(() => {
      const steps = this.stepsOf(goalId, version);
      this.requireCurrentVersion(goalId, version);
      const actual = steps.map((s) => s.id);
      const unique = new Set(orderedStepIds);
      if (unique.size !== orderedStepIds.length || orderedStepIds.length !== actual.length)
        invalid('重排的步骤列表必须是本版本全部步骤、且不重复');
      if (!orderedStepIds.every((id) => actual.includes(id)))
        invalid('重排列表里有不属于本版本的步骤');
      const shift = Math.max(...steps.map((s) => s.seq)) + steps.length + 1;
      const move = this.db.prepare('UPDATE goal_steps SET seq = ? WHERE id = ?');
      steps.forEach((step, index) => move.run(shift + index, step.id));
      orderedStepIds.forEach((id, index) => move.run(index + 1, id));
    })();
  }

  setStepStatus(stepId: string, status: StepStatus): void {
    this.db.transaction(() => {
      const step = this.requireStep(stepId);
      this.requireCurrentVersion(step.goal_id, step.plan_version);
      this.db
        .prepare('UPDATE goal_steps SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), stepId);
    })();
  }

  /** 推进到 doing：只有 pending、且依赖都已 done/skipped 才行。 */
  advanceStep(stepId: string): void {
    this.db.transaction(() => {
      const step = this.requireStep(stepId);
      this.requireCurrentVersion(step.goal_id, step.plan_version);
      if (step.status !== 'pending') conflict(`步骤现在是 ${step.status}，只有 pending 能推进`);
      const blocked = this.depsOf(stepId).filter((dep) => {
        const row = this.requireStep(dep);
        return row.status !== 'done' && row.status !== 'skipped';
      });
      if (blocked.length > 0) conflict(`依赖还没完成：${blocked.join('、')}`);
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE goal_steps SET status = 'doing', started_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, stepId);
      this.event(step.goal_id, 'step', `步骤开始：${step.title}`);
    })();
  }

  finishStep(stepId: string): void {
    this.db.transaction(() => {
      const step = this.requireStep(stepId);
      this.requireCurrentVersion(step.goal_id, step.plan_version);
      if (step.status !== 'doing') conflict(`步骤现在是 ${step.status}，只有 doing 能收尾`);
      this.db
        .prepare("UPDATE goal_steps SET status = 'done', ended_at = ?, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), stepId);
      this.event(step.goal_id, 'step', `步骤做完：${step.title}`);
    })();
  }

  private hasCycle(goalId: string, version: number): boolean {
    const edges = this.db
      .prepare(
        `SELECT d.step_id AS src, d.depends_on_step_id AS dst FROM goal_step_deps d
         JOIN goal_steps s ON s.id = d.step_id
         WHERE s.goal_id = ? AND s.plan_version = ?`,
      )
      .all(goalId, version) as { src: string; dst: string }[];
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return true;
      seen.add(id);
      const next = edges.filter((e) => e.src === id).map((e) => e.dst);
      return next.some(walk);
    };
    return this.stepsOf(goalId, version).some((step) => {
      seen.clear();
      return walk(step.id);
    });
  }

  private requireGoal(goalId: string): void {
    if (!this.db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
      throw new IxaError(ErrorCodes.NOT_FOUND, `目标不存在: ${goalId}`);
  }

  private requireCurrentVersion(goalId: string, version: number): void {
    const plan = this.getPlan(goalId, version);
    if (plan.status !== 'current') conflict('历史方案只读，不能修改');
  }

  private requireStep(stepId: string): PlanStep {
    const step = this.db.prepare('SELECT * FROM goal_steps WHERE id = ?').get(stepId) as
      PlanStep | undefined;
    if (!step) throw new IxaError(ErrorCodes.NOT_FOUND, '步骤不存在');
    return step;
  }

  private requireCurrentStep(goalId: string, version: number, stepId: string): PlanStep {
    this.requireCurrentVersion(goalId, version);
    const step = this.requireStep(stepId);
    if (step.goal_id !== goalId || step.plan_version !== version) invalid('步骤不属于这个方案版本');
    return step;
  }

  private event(goalId: string, kind: 'plan' | 'step', summary: string): void {
    this.db
      .prepare(
        `INSERT INTO goal_events (id, goal_id, at, kind, decided_by, summary) VALUES (?, ?, ?, ?, 'agent', ?)`,
      )
      .run(randomUUID(), goalId, new Date().toISOString(), kind, summary);
  }
}
