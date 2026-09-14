import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';

export type SkillStatus = 'proposed' | 'evaluated' | 'approved' | 'rejected' | 'retired';

export interface SkillEvalEvidence {
  exitCodeBefore: number;
  exitCodeAfter: number;
  outputBefore: string;
  outputAfter: string;
  verifiedAt: string;
  command: string[];
}

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
  version: number;
  eval_evidence_json: string | null;
  approved_version: number | null;
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

  updateMethod(id: string, method: string): SkillCandidate {
    const trimmed = method.trim();
    if (!trimmed) throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'Skill 方法不能为空');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE skill_candidates
         SET method = ?, version = version + 1, status = 'proposed', updated_at = ?
         WHERE id = ?`,
      )
      .run(trimmed, now, id);
    return this.get(id);
  }

  evaluateWithEvidence(
    id: string,
    input: {
      method?: string;
      evidence: SkillEvalEvidence;
      benefit: string;
    },
  ): SkillCandidate {
    const { evidence, benefit } = input;
    if (evidence.exitCodeBefore === 0) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '基线（before）必须是失败案例，不能在原本成功的案例上伪造改进',
      );
    }
    if (evidence.exitCodeAfter !== 0) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `改进后（after）检查必须成功通过，当前 exitCode 为 ${evidence.exitCodeAfter}`,
      );
    }
    const now = new Date().toISOString();
    const evidenceJson = JSON.stringify(evidence);
    const evalBefore = `[退出码: ${evidence.exitCodeBefore}]\n${evidence.outputBefore.slice(0, 1000)}`;
    const evalAfter = `[退出码: ${evidence.exitCodeAfter}]\n${evidence.outputAfter.slice(0, 1000)}`;

    this.db
      .prepare(
        `UPDATE skill_candidates
         SET status = 'evaluated',
             method = COALESCE(?, method),
             eval_before = ?,
             eval_after = ?,
             benefit = ?,
             eval_evidence_json = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(input.method ?? null, evalBefore, evalAfter, benefit, evidenceJson, now, id);
    return this.get(id);
  }

  evaluate(
    id: string,
    input: { evalBefore: string; evalAfter: string; benefit: string | null },
  ): SkillCandidate {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE skill_candidates
         SET status = 'evaluated', eval_before = ?, eval_after = ?, benefit = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('proposed', 'evaluated')`,
      )
      .run(input.evalBefore, input.evalAfter, input.benefit, now, id);
    return this.get(id);
  }

  approve(id: string, options?: { version?: number }): SkillCandidate {
    const row = this.get(id);
    if (row.status !== 'evaluated') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '没有对照评测结果，不能批准 Skill（不能把提案直接当能力升级）',
      );
    }
    if (options?.version !== undefined && options.version !== row.version) {
      throw new IxaError(
        ErrorCodes.CONFLICT,
        `批准版本不匹配：请求批准版本为 v${options.version}，当前候选已演进到 v${row.version}`,
      );
    }
    // S01（审核 2026-09-13）：空的前后对照不构成证据——
    // 只写一句 benefit='improved' 不能算「经过验证的方法成长」。
    if (!row.eval_before?.trim() || !row.eval_after?.trim()) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '缺少前后对照证据（evalBefore/evalAfter 为空），无证据不能批准 Skill',
      );
    }
    if (!row.benefit || /无收益|无改进|相同|没有差异/.test(row.benefit)) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '无收益的候选保持未采用');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE skill_candidates
         SET status = 'approved', approved_version = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(row.version, now, id);
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
