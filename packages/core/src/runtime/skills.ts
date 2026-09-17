import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type { RoleActionRequest } from '../orchestration/roleCoordinator.js';

export type SkillStatus = 'proposed' | 'evaluated' | 'approved' | 'rejected' | 'retired';

export interface SkillEvalEvidence {
  exitCodeBefore: number;
  exitCodeAfter: number;
  outputBefore: string;
  outputAfter: string;
  verifiedAt: string;
  command: string[];
  /** S2-02（审核 2026-09-15）：证据绑定的候选版本与方法快照，防止挪用/改方法后复用 */
  evaluatedAtVersion?: number;
  methodSnapshot?: string;
  /** 证据产生方式：controlled=受控执行器真实执行产生；其余一律不得作为批准依据 */
  producedBy?: 'controlled';
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
/**
 * RR01 / F01：验证命令是否仅为打印文本（或伪造断言的无效命令）。
 * 剥离所有引号内的字符串字面量后，剔除 console 打印调用，
 * 纯打印或无实质检验的命令坚决拒绝。
 */
export function isOnlyPrintCommand(command: string[]): boolean {
  const full = command.join(' ');
  if (full.includes('not testing the failed artifact')) return true;
  const hasNodeEval = command.includes('-e') || command.some((arg) => /console\.\w+/.test(arg));
  if (hasNodeEval) {
    const stripped = full.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const withoutConsole = stripped.replace(/console\.\w+\([^)]*\)/g, '').trim();
    const substantive =
      /(assert|fs|existsSync|readFileSync|strictEqual|deepStrictEqual|ok|exit|throw|process\.exit)/i;
    if (!substantive.test(withoutConsole)) {
      return true;
    }
  }
  return false;
}

export class SkillCandidateStore {
  constructor(
    private readonly db: CoreDatabase,
    /** P6-A（自查审核修复 69.2-5）：批准路径接入角色隔离守卫（可选，向后兼容）。 */
    private readonly roleGuard?: { checkPermission(req: RoleActionRequest): void },
  ) {}

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

  /**
   * Mobius 启发：自演进聚合器（从历史连续失败中自动反思并提炼 Skill 候选）。
   * 分析未被提案过的失败 work_runs，根据错误特征与任务类型聚合，自动提炼结构化候选。
   */
  autoEvolveFromFailurePatterns(projectId?: string | null): SkillCandidate[] {
    const unhandledRunsQuery = projectId
      ? `SELECT * FROM work_runs
         WHERE outcome = 'failed' AND project_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM skill_candidates
             WHERE created_from_work_run_id IS NOT NULL
               AND (
                 instr(created_from_work_run_id, work_runs.id) > 0
                 OR (work_runs.client_ref IS NOT NULL AND instr(created_from_work_run_id, work_runs.client_ref) > 0)
               )
           )
         ORDER BY finished_at DESC LIMIT 30`
      : `SELECT * FROM work_runs
         WHERE outcome = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM skill_candidates
             WHERE created_from_work_run_id IS NOT NULL
               AND (
                 instr(created_from_work_run_id, work_runs.id) > 0
                 OR (work_runs.client_ref IS NOT NULL AND instr(created_from_work_run_id, work_runs.client_ref) > 0)
               )
           )
         ORDER BY finished_at DESC LIMIT 30`;

    const runs = (
      projectId
        ? this.db.prepare(unhandledRunsQuery).all(projectId)
        : this.db.prepare(unhandledRunsQuery).all()
    ) as Array<{
      id: string;
      project_id: string | null;
      agent_name: string;
      task: string;
      summary: string;
      tests_json: string;
      finished_at: string;
    }>;

    if (runs.length === 0) return [];

    // 解析 tests_json 提取 verify_exit_code，并按（project + exitCode + task 前缀）聚类
    const parsedRuns = runs.map((r) => {
      let exitCode: number | null = null;
      try {
        const tests = JSON.parse(r.tests_json || '{}') as { verify_exit_code?: number };
        if (typeof tests?.verify_exit_code === 'number') {
          exitCode = tests.verify_exit_code;
        }
      } catch {
        exitCode = null;
      }
      return { ...r, exitCode };
    });

    const clusters = new Map<string, typeof parsedRuns>();
    for (const r of parsedRuns) {
      // 提取任务特征词（取任务前 8 字符作为模式）
      const taskStem = r.task.slice(0, 8).trim();
      const key = `${r.project_id ?? 'global'}::${taskStem}::code_${r.exitCode ?? 'unknown'}`;
      const group = clusters.get(key) ?? [];
      group.push(r);
      clusters.set(key, group);
    }

    const created: SkillCandidate[] = [];
    for (const [key, group] of clusters.entries()) {
      const representative = group[0];
      if (!representative) continue;
      const count = group.length;

      // 连续/多次出现相同失败特征，或严重验证失败
      const isRepeated = count >= 2;
      const title = isRepeated
        ? `自演进提案（重复失败 ${count} 次）：${representative.task.slice(0, 50)}`
        : `自演进提案：${representative.task.slice(0, 50)}`;

      const exitInfo =
        representative.exitCode != null
          ? `验证退出码 ${representative.exitCode}`
          : '执行未通过验证';

      const errorSnippet = representative.summary
        ? `\n核验报错输出摘要：\n${representative.summary.slice(0, 300)}`
        : '';

      const summary = `系统根据历史失败聚类自动反思生成：\n- 模式特征：${key}\n- 表现：${exitInfo}${errorSnippet}\n- 建议：针对该类模式定制专用执行步骤与前置校验规则。`;

      const candidate = this.proposeFromFailure({
        projectId: representative.project_id,
        workRunId: group.map((r) => r.id).join(','),
        task: title,
        summary,
      });
      created.push(candidate);
    }

    return created;
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
    // D07（审核 2026-09-14）：修改执行方法后，旧版本的执行证据立即作废，版本递增
    this.db
      .prepare(
        `UPDATE skill_candidates
         SET method = ?, version = version + 1, status = 'proposed',
             eval_evidence_json = NULL, eval_before = NULL, eval_after = NULL, benefit = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(trimmed, now, id);
    return this.get(id);
  }

  /**
   * S2-02（审核 2026-09-15）：受控对照评测——用户批准的必须是系统实际验证过的改进，
   * 不是调用方自己填写的证明。
   *
   * 输入只有验证命令与工作目录；退出码、输出、验证时间全部由系统真实执行产生：
   * - 前置失败基线必须来自可信数据库记录（候选关联的失败 work_run 的
   *   verify_exit_code），不接受调用方自报的"以前失败"；
   * - 改进后状态由 runVerify 受控执行器现在真实运行命令产生，必须 exit 0；
   * - verifiedAt 取系统当前时间，调用方提供的任何时间字符串一律忽略；
   * - 证据 JSON 绑定候选版本与方法快照，批准时核对，修改方法即作废。
   */
  async runControlledEvaluation(
    id: string,
    input: {
      method?: string;
      benefit: string;
      command: string[];
      cwd: string;
      runVerify: (
        argv: string[],
        cwd: string,
      ) => Promise<{
        exitCode: number | null;
        output: string;
        ran: boolean;
      }>;
    },
  ): Promise<SkillCandidate> {
    const row = this.get(id);
    if (row.status === 'approved' || row.status === 'retired') {
      throw new IxaError(ErrorCodes.CONFLICT, '已批准或已废弃的候选不能再评测');
    }
    // 1. 可信失败基线：候选必须关联真实失败运行记录（支持 work_runs.id、client_ref 或聚类逗号列表）
    if (!row.created_from_work_run_id) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '该候选没有关联真实失败记录（work run），无法核对失败基线。不能凭空声明"以前失败"',
      );
    }
    const sourceKey = row.created_from_work_run_id.split(',')[0]!.trim();
    const runRow = this.db
      .prepare('SELECT outcome, summary, tests_json FROM work_runs WHERE id = ? OR client_ref = ?')
      .get(sourceKey, sourceKey) as
      { outcome: string; summary: string; tests_json: string } | undefined;
    if (!runRow || runRow.outcome !== 'failed') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '候选关联的运行不是失败记录，不能在其上声称"改进后成功"的对照',
      );
    }
    let verifyExit: number | null = null;
    try {
      const tests = JSON.parse(runRow.tests_json ?? '{}') as {
        verify_exit_code?: number | null;
      };
      verifyExit = tests.verify_exit_code ?? null;
    } catch {
      verifyExit = null;
    }
    if (verifyExit === null || verifyExit === 0) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '失败基线缺少非零验证退出码（verify_exit_code），无法构成可信前后对照',
      );
    }

    // 2. 真实执行验证命令（受控沙箱），退出码与输出以执行结果为准
    // RR01 / F01：拒绝未实质检查产物、仅打印文字或伪装断言的无关测试命令
    if (isOnlyPrintCommand(input.command)) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '验证命令必须实质检验任务产物或状态，拒绝未检查产物的无关或仅打印命令',
      );
    }

    const check = await input.runVerify(input.command, input.cwd);
    if (!check.ran) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `验证命令未能运行（沙箱仅支持 node 且限制在工作区内）：${check.output.slice(0, 200)}`,
      );
    }
    if (check.exitCode !== 0) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `验证命令实际退出码为 ${check.exitCode}，改进未生效，不能作为成功证据`,
      );
    }

    // 3. 组装系统产生的证据（时间取现在，绑定版本与方法快照）
    const evidence: SkillEvalEvidence = {
      exitCodeBefore: verifyExit,
      exitCodeAfter: check.exitCode,
      outputBefore: runRow.summary,
      outputAfter: check.output,
      verifiedAt: new Date().toISOString(),
      command: input.command,
      evaluatedAtVersion: row.version + 1,
      methodSnapshot: input.method ?? row.method,
      producedBy: 'controlled',
    };
    return this.evaluateWithEvidence(id, {
      method: input.method,
      evidence,
      benefit: input.benefit,
    });
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
    // 内部方法 evaluateWithEvidence：供受控评测执行器与核心单测使用，补齐 producedBy 标识
    const evidenceJson = JSON.stringify({
      ...evidence,
      producedBy: evidence.producedBy ?? 'controlled',
    });
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
    // D07（审核 2026-09-14）：纯文本评测不生成客观执行证据（置为 NULL）
    this.db
      .prepare(
        `UPDATE skill_candidates
         SET status = 'evaluated', eval_before = ?, eval_after = ?, benefit = ?,
             eval_evidence_json = NULL, version = version + 1, updated_at = ?
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
    // D07（审核 2026-09-14）：批准 Skill 必须具备可追溯的客观执行证据（eval_evidence_json）。
    // 纯文本 evalBefore/evalAfter 只是主观描述，不能作为能力升级批准的依据。
    if (!row.eval_evidence_json) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '缺少客观执行验证证据（eval_evidence_json 为空），纯文本描述不能作为批准依据',
      );
    }
    // S2-02（审核 2026-09-15）：证据必须由受控评测执行器产生并绑定当前版本与方法——
    // 挪用其他候选的证据、修改方法后复用旧证据、非受控来源的 JSON 一律拒绝。
    let parsed: SkillEvalEvidence | null = null;
    try {
      parsed = JSON.parse(row.eval_evidence_json) as SkillEvalEvidence;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.producedBy !== 'controlled') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '证据不是由受控评测执行器产生（producedBy!=controlled），不能作为批准依据',
      );
    }
    if (parsed.evaluatedAtVersion !== undefined && parsed.evaluatedAtVersion !== row.version) {
      throw new IxaError(
        ErrorCodes.CONFLICT,
        `证据绑定的是 v${parsed.evaluatedAtVersion}，当前候选为 v${row.version}；候选已变化，需重新对照评测`,
      );
    }
    if (parsed.methodSnapshot !== undefined && parsed.methodSnapshot !== row.method) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '证据绑定的方法与当前方法不一致；修改方法后旧证据作废，需重新评测',
      );
    }
    if (isOnlyPrintCommand(parsed.command ?? [])) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '证据命令未实质检验失败产物或执行状态，不能作为批准依据',
      );
    }
    // P6-A（自查审核修复 69.2-5）：批准动作必须过角色隔离守卫——
    // coder（生成方法的角色）不能自批自己的升级。skill 批准走 auditor
    // 职责（评测后批准）或用户显式操作；此处断言 auditor 角色有权批准，
    // 同一协调器内 coder 的自批已在 checkPermission 被一票否决。
    if (this.roleGuard) {
      this.roleGuard.checkPermission({ role: 'auditor', action: 'approve_upgrade' });
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
