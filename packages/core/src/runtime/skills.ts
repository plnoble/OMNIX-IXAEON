import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';

export type SkillStatus = 'proposed' | 'evaluated' | 'approved' | 'rejected' | 'retired';

export interface SkillCandidate {
  id: string;
  project_id: string | null;
  title: string;
  problem: string;
  method: string;
  eval_case: string;
  status: SkillStatus;
  eval_before: string | null;
  eval_after: string | null;
  benefit: string | null;
  created_from_work_run_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 经验到 Skill 候选。一次失败自动提案，不等于能力升级。
 * 批准需要对照评测结果；无收益保持未采用。
 */
export class SkillCandidateStore {
  constructor(private readonly db: CoreDatabase) {}

  proposeFromFailure(input: {
    projectId: string | null;
    workRunId?: string | null;
    task: string;
    summary: string;
  }): SkillCandidate {
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = `候选：${input.task.slice(0, 80)}`;
    this.db
      .prepare(
        `INSERT INTO skill_candidates (
           id, project_id, title, problem, method, eval_case, status,
           eval_before, eval_after, benefit, created_from_work_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        title,
        input.summary.slice(0, 2000) || '任务失败，原因见工作记录',
        '尚未对照评测，不能当已学会的方法。下次同类任务先核验产物与范围。',
        `复现：${input.task.slice(0, 500)}`,
        input.workRunId ?? null,
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): SkillCandidate {
    const row = this.db.prepare('SELECT * FROM skill_candidates WHERE id = ?').get(id) as
      SkillCandidate | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `Skill 候选不存在: ${id}`);
    return row;
  }

  list(projectId?: string | null): SkillCandidate[] {
    if (projectId) {
      return this.db
        .prepare(
          'SELECT * FROM skill_candidates WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
        )
        .all(projectId) as SkillCandidate[];
    }
    return this.db
      .prepare('SELECT * FROM skill_candidates ORDER BY created_at DESC LIMIT 50')
      .all() as SkillCandidate[];
  }

  approvedForProject(projectId: string): SkillCandidate[] {
    return this.db
      .prepare(
        `SELECT * FROM skill_candidates
         WHERE project_id = ? AND status = 'approved'
         ORDER BY updated_at DESC LIMIT 8`,
      )
      .all(projectId) as SkillCandidate[];
  }

  evaluate(
    id: string,
    input: { evalBefore: string; evalAfter: string; benefit: string | null },
  ): SkillCandidate {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE skill_candidates
         SET status = 'evaluated', eval_before = ?, eval_after = ?, benefit = ?, updated_at = ?
         WHERE id = ? AND status IN ('proposed', 'evaluated')`,
      )
      .run(input.evalBefore, input.evalAfter, input.benefit, now, id);
    return this.get(id);
  }

  approve(id: string): SkillCandidate {
    const row = this.get(id);
    if (row.status !== 'evaluated') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '没有对照评测结果，不能批准 Skill（不能把提案直接当能力升级）',
      );
    }
    if (!row.benefit || /无收益|无改进|相同|没有差异/.test(row.benefit)) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '无收益的候选保持未采用');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE skill_candidates SET status = 'approved', updated_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }

  reject(id: string): SkillCandidate {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE skill_candidates SET status = 'rejected', updated_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }

  retire(id: string): SkillCandidate {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE skill_candidates SET status = 'retired', updated_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }
}
