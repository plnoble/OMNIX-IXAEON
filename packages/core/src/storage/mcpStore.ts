import type { CoreDatabase } from '../db/database.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type {
  BriefingEntry,
  GetSourceExcerptOutput,
  PrepareTaskInput,
  PrepareTaskOutput,
  RecordWorkResultInput,
  RecordWorkResultOutput,
  SearchContextInput,
  SearchContextOutput,
  SearchResult,
} from '@ixaeon/contracts';
import { recordAudit } from '../audit.js';
import { assertSourceAuthorized, assertCodingClientMayReadItem } from '../access.js';

/**
 * MCP 工具逻辑（计划 6.x）。
 * 桌面端本地 HTTP 服务调用这里；MCP STDIO 服务器再转发。
 * 简报条目全部带本地引用 ID（item id / work run id / segment id）。
 */
export class McpService {
  constructor(private readonly db: CoreDatabase) {}

  /** project_ref（名称 / ID / 根路径）→ 项目行。 */
  private resolveProject(projectRef: string): { id: string; name: string } {
    const byId = this.db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectRef) as
      { id: string; name: string } | undefined;
    if (byId) return byId;
    const byName = this.db
      .prepare('SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE')
      .get(projectRef) as { id: string; name: string } | undefined;
    if (byName) return byName;
    const byPath = this.db
      .prepare('SELECT id, name FROM projects WHERE root_path = ? COLLATE NOCASE')
      .get(projectRef) as { id: string; name: string } | undefined;
    if (byPath) return byPath;
    throw new IxaError(
      ErrorCodes.NOT_FOUND,
      `未找到项目（可传项目名称、ID 或根路径）: ${projectRef}`,
    );
  }

  /**
   * prepare_task：生成项目简报（字符预算内、全部可追溯）。
   */
  prepareTask(input: PrepareTaskInput): PrepareTaskOutput {
    const project = this.resolveProject(input.project_ref);

    const items = this.db
      .prepare(
        `SELECT id, type, statement, rationale, state, origin, needs_review, updated_at, confirmation
         FROM items
         WHERE project_id = ? AND scope = 'project' AND shelved_at IS NULL AND state != 'superseded'
           AND confirmation != 'rejected'
         ORDER BY CASE type
           WHEN 'project_summary' THEN 0
           WHEN 'decision' THEN 1
           WHEN 'rejected_option' THEN 2
           WHEN 'open_loop' THEN 3
           WHEN 'goal' THEN 4
           WHEN 'constraint' THEN 5
           ELSE 6 END, updated_at DESC`,
      )
      .all(project.id) as Array<{
      id: string;
      type: string;
      statement: string;
      rationale: string | null;
      state: string;
      origin: string;
      needs_review: number;
      updated_at: string;
      confirmation: string | null;
    }>;

    const workRuns = this.db
      .prepare(
        `SELECT id, agent_name, task, outcome, summary, finished_at
         FROM work_runs WHERE project_id = ? ORDER BY finished_at DESC LIMIT 5`,
      )
      .all(project.id) as Array<{
      id: string;
      agent_name: string;
      task: string;
      outcome: string;
      summary: string;
      finished_at: string;
    }>;

    const purpose: BriefingEntry[] = [];
    const status: BriefingEntry[] = [];
    const decisions: BriefingEntry[] = [];
    const rejectedOptions: BriefingEntry[] = [];
    const openLoops: BriefingEntry[] = [];
    const risks: BriefingEntry[] = [];

    for (const item of items) {
      const entry: BriefingEntry = {
        kind: 'note',
        ref: item.id,
        text: item.statement,
        state: item.state as BriefingEntry['state'],
        // M3 来源标注：ai / user（确认或纠正）/ work_result（agent 自报）
        origin:
          item.origin === 'user' || item.origin === 'ai' || item.origin === 'work_result'
            ? item.origin
            : null,
      };
      const isImportantType =
        item.type === 'decision' ||
        item.type === 'rejected_option' ||
        item.type === 'project_summary';
      const pendingConfirm =
        item.origin === 'ai' && item.confirmation !== 'confirmed' && isImportantType;
      const suffix =
        item.state === 'disputed'
          ? '（存在冲突）'
          : item.origin === 'user'
            ? '（用户确认）'
            : item.confirmation === 'confirmed'
              ? '（用户已确认）'
              : pendingConfirm
                ? '（待用户确认）'
                : '';
      entry.text = item.statement + suffix;
      switch (item.type) {
        case 'project_summary':
          entry.kind = 'project_purpose';
          purpose.push(entry);
          break;
        case 'decision':
          entry.kind = 'decision';
          decisions.push(entry);
          // G6：未确认的重要决定同时进入风险组 —— 编码 AI 必须能看到待确认状态
          if (pendingConfirm) risks.push(entry);
          break;
        case 'rejected_option':
          entry.kind = 'rejected_option';
          rejectedOptions.push(entry);
          break;
        case 'open_loop':
          entry.kind = 'open_loop';
          openLoops.push(entry);
          if (item.needs_review) risks.push(entry);
          break;
        case 'goal':
          entry.kind = 'note';
          status.push(entry);
          break;
        case 'constraint':
          entry.kind = 'note';
          status.push(entry);
          break;
        case 'preference':
          entry.kind = 'note';
          status.push(entry);
          break;
      }
    }

    const recentWork: BriefingEntry[] = workRuns.map((w) => ({
      kind: 'recent_work' as const,
      ref: w.id,
      text: `[${w.outcome}] ${w.task} — ${w.summary.slice(0, 200)}（${w.agent_name}）`,
      state: null,
      origin: 'work_result' as const,
    }));

    // 字符预算（C08/A07-A09 重写）：预算 = **最终 JSON.stringify(完整返回值)** 长度。
    // 实现策略：
    // 1. 构造最终输出（含真实 notice/coverage/chars_used 占位）
    // 2. 条目按序装入直到完整序列化超预算（不再单独扣「元数据开销」两次）
    // 3. chars_used 按最终序列化结果统计（含统计字段自身位数，A09）
    // 4. 任务本身使输出超限 → 条目全裁后仍超 → 截断 task 字段并标记（不返回超限成功）
    const budget = input.max_chars;
    const groups: BriefingEntry[][] = [
      purpose,
      decisions,
      openLoops,
      rejectedOptions,
      risks,
      status,
      recentWork,
    ];
    const totalBefore = JSON.stringify(groups.flat()).length;
    let truncated = false;

    const latest = this.db
      .prepare(
        `SELECT MAX(updated_at) AS t FROM items WHERE project_id = ?
         UNION ALL SELECT MAX(finished_at) FROM work_runs WHERE project_id = ?`,
      )
      .all(project.id, project.id) as Array<{ t: string | null }>;
    const latestTime = latest
      .map((r) => r.t)
      .filter(Boolean)
      .sort()
      .pop();

    // M3/G3b 覆盖版本：按「每个来源」检查版本差再聚合
    const coverageRows = this.db
      .prepare(
        `SELECT MAX(content_revision) AS mc,
                SUM(CASE WHEN content_revision > analyzed_revision THEN 1 ELSE 0 END) AS pending
         FROM sources WHERE project_id = ?`,
      )
      .all(project.id) as Array<{ mc: number | null; pending: number | null }>;
    const maxContentRevision = coverageRows[0]?.mc ?? 0;
    const pendingCount = coverageRows[0]?.pending ?? 0;
    const hasUnanalyzedContent = pendingCount > 0;
    const analyzedRow = this.db
      .prepare(
        `SELECT MAX(analyzed_revision) AS ma FROM sources
         WHERE project_id = ? AND content_revision <= analyzed_revision`,
      )
      .get(project.id) as { ma: number | null };
    const maxAnalyzedRevision = analyzedRow.ma ?? 0;

    const buildStalenessNotice = (isTruncated: boolean): string =>
      `本简报生成于 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}。` +
      `最新记忆更新：${latestTime?.slice(0, 19).replace('T', ' ') ?? '无'}。` +
      `此后用户可能已有新决定；执行前如有疑问请用 search_context 复核或直接询问用户。` +
      (isTruncated ? `（简报达到 ${budget} 字符预算被截断，可用 search_context 补充检索）` : '') +
      (hasUnanalyzedContent
        ? `注意：该项目有 ${pendingCount} 个来源的新内容尚未分析（最高内容版本 ${maxContentRevision}），本简报可能落后于最新对话。`
        : '') +
      `（原始简报 ${totalBefore} 字符）`;

    // 完整序列化长度（把 chars_used/truncated 按真实值代入，A09）
    const serializedLength = (usedValue: number, isTruncated: boolean, taskText: string): number =>
      JSON.stringify({
        project_id: project.id,
        project_name: project.name,
        task: taskText,
        purpose: [...purpose],
        status: [...status],
        decisions: [...decisions],
        rejected_options: [...rejectedOptions],
        open_loops: [...openLoops],
        risks: [...risks],
        recent_work: [...recentWork],
        generated_at: new Date().toISOString(),
        char_budget: budget,
        chars_used: usedValue,
        truncated: isTruncated,
        staleness_notice: buildStalenessNotice(isTruncated),
        coverage: { maxContentRevision, maxAnalyzedRevision, hasUnanalyzedContent },
      }).length;

    // 先清空全部组，再按优先序逐条装回，直到完整序列化达预算（A08：不丢可放下的内容）
    const allEntries: Array<{ group: BriefingEntry[]; entry: BriefingEntry }> = [];
    for (const g of [purpose, decisions, openLoops, rejectedOptions, risks, status, recentWork]) {
      for (const e of [...g]) allEntries.push({ group: g, entry: e });
      g.length = 0;
    }
    // 依序装回：任一条目装入后完整序列化超预算 → 跳过并标记截断
    const used = 0;
    let keptCount = 0;
    for (const { group, entry } of allEntries) {
      group.push(entry);
      // RF04：试放按最坏情形核算 —— truncated=true（截断提示更长）与
      // 99999 位数上限的 chars_used，为最终截断说明与统计数字留足空间。
      const probeLen = serializedLength(99999, true, input.task);
      if (probeLen > budget) {
        group.pop();
        truncated = true;
        continue;
      }
      keptCount += 1;
    }
    void used;
    void keptCount;

    // 任务本身使空简报超限 → 截断 task（明确标记），不返回超限成功结果（A07）
    let taskText = input.task;
    let taskTruncated = false;
    for (
      let guard = 0;
      guard < 4000 && serializedLength(99999, truncated, taskText) > budget;
      guard++
    ) {
      // 逐步缩短 task；仍不够则标记截断（保留前缀 + 截断说明）
      if (taskText.length > 64) {
        taskText = taskText.slice(0, Math.floor(taskText.length * 0.9));
        taskTruncated = true;
      } else if (taskText.length > 8) {
        taskText = taskText.slice(0, taskText.length - 8);
        taskTruncated = true;
      } else {
        taskText = '';
        taskTruncated = true;
        break;
      }
    }
    if (taskTruncated) truncated = true;

    // chars_used：按最终序列化结果统计（A09）；迭代收敛统计字段自身位数变化
    let charsUsed = serializedLength(99999, truncated, taskText);
    for (let guard = 0; guard < 8; guard++) {
      const next = serializedLength(charsUsed, truncated, taskText);
      if (next === charsUsed) break;
      charsUsed = next;
    }

    // RF04 最终防线：任何情形下真实完整返回值不得超过预算。超限时按
    // 装填优先级的逆序（recentWork → status → risks → rejected →
    // open_loops → decisions → purpose）逐条移除并复核；全部移除后仍
    // 超限（极端小预算）则按契约明确拒绝，不返回超限的"成功"结果。
    for (let guard = 0; guard < 500; guard++) {
      const finalLen = serializedLength(charsUsed, truncated, taskText);
      if (finalLen <= budget) break;
      const victim =
        recentWork.length > 0
          ? recentWork
          : status.length > 0
            ? status
            : risks.length > 0
              ? risks
              : rejectedOptions.length > 0
                ? rejectedOptions
                : openLoops.length > 0
                  ? openLoops
                  : decisions.length > 0
                    ? decisions
                    : purpose.length > 0
                      ? purpose
                      : null;
      if (!victim) break;
      victim.pop();
      truncated = true;
      // 重算统计（移除条目后长度变化）
      charsUsed = serializedLength(99999, truncated, taskText);
      for (let g2 = 0; g2 < 8; g2++) {
        const next = serializedLength(charsUsed, truncated, taskText);
        if (next === charsUsed) break;
        charsUsed = next;
      }
    }
    const finalCheck = serializedLength(charsUsed, truncated, taskText);
    if (finalCheck > budget) {
      throw new IxaError(
        ErrorCodes.BUDGET_EXCEEDED,
        `max_chars=${budget} 过小：无法容纳最小简报（当前最小 ${finalCheck} 字符）。` +
          `请使用 ≥2000 的预算（契约最小值）。`,
      );
    }

    recordAudit(this.db, 'mcp.prepare_task', {
      projectId: project.id,
      charsUsed,
      truncated,
    });

    return {
      project_id: project.id,
      project_name: project.name,
      task: taskText,
      purpose,
      status,
      decisions,
      rejected_options: rejectedOptions,
      open_loops: openLoops,
      risks,
      recent_work: recentWork,
      generated_at: new Date().toISOString(),
      char_budget: budget,
      chars_used: charsUsed,
      truncated,
      staleness_notice: buildStalenessNotice(truncated),
      coverage: {
        maxContentRevision,
        maxAnalyzedRevision,
        hasUnanalyzedContent,
      },
    };
  }

  /** search_context：条目 + 原文片段混合检索。 */
  searchContext(input: SearchContextInput): SearchContextOutput {
    let projectId: string | null = null;
    if (input.project_ref) {
      projectId = this.resolveProject(input.project_ref).id;
    }
    const results: SearchResult[] = [];

    // 1) 条目匹配（statement LIKE）；项目隔离：指定项目时仅该项目的条目
    const itemRows = this.db
      .prepare(
        `SELECT i.id, i.type, i.statement, i.state, s.title AS source_title, i.project_id,
                p.name AS project_name, i.updated_at
         FROM items i
         LEFT JOIN segments seg ON seg.id IN (
           SELECT segment_id FROM item_evidence WHERE item_id = i.id LIMIT 1
         )
         LEFT JOIN sources s ON s.id = seg.source_id
         LEFT JOIN projects p ON p.id = i.project_id
         WHERE i.statement LIKE ? AND i.shelved_at IS NULL
           -- C06/A10：已拒绝建议不作为当前结论返回（历史原文仍可经
           -- get_source_excerpt 按 segment/item 引用展开，不删除历史）
           AND (i.confirmation IS NULL OR i.confirmation != 'rejected')
            AND (i.scope = 'project'
              OR i.id IN (
                SELECT item_id FROM disclosure_grants
                WHERE audience = 'coding_client'
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > datetime('now'))
              ))
           ${projectId !== null ? 'AND i.project_id = ?' : ''}
           ${input.type ? 'AND i.type = ?' : ''}
         ORDER BY i.updated_at DESC LIMIT ?`,
      )
      .all(
        `%${input.query}%`,
        ...(projectId !== null ? [projectId] : []),
        ...(input.type ? [input.type] : []),
        input.limit,
      ) as Array<{
      id: string;
      type: string;
      statement: string;
      state: string;
      source_title: string | null;
      project_id: string | null;
      project_name: string | null;
      updated_at: string;
    }>;
    for (const row of itemRows) {
      results.push({
        ref: row.id,
        kind: 'item',
        excerpt: row.statement.slice(0, 300),
        source_title: row.source_title ?? '（条目）',
        project_id: row.project_id,
        project_name: row.project_name,
        type: row.type as SearchResult['type'],
        state: row.state as SearchResult['state'],
        time: row.updated_at,
      });
    }

    // 2) 原文片段匹配（FTS rowid 正确连接 + 项目隔离 + 授权过滤）
    const ftsQuery = `"${input.query.replace(/"/g, '""')}"`;
    const segRows = this.db
      .prepare(
        `SELECT sg.id, sg.role, substr(sg.text, 1, 300) AS excerpt, src.title AS source_title,
                src.project_id, src.id AS src_id, p.name AS project_name, sg.occurred_at
         FROM segments_fts f
         JOIN segments sg ON sg.rowid = f.rowid
         JOIN sources src ON src.id = sg.source_id
         LEFT JOIN projects p ON p.id = src.project_id
         WHERE segments_fts MATCH ?
         ${projectId !== null ? 'AND src.project_id = ?' : ''}
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, ...(projectId !== null ? [projectId] : []), input.limit) as Array<{
      id: string;
      role: string;
      excerpt: string;
      source_title: string;
      project_id: string | null;
      src_id: string;
      project_name: string | null;
      occurred_at: string | null;
    }>;
    for (const row of segRows) {
      if (results.length >= input.limit) break;
      // 授权隔离：撤销授权的来源不返回原文（含 item 依据指向的片段）
      try {
        assertSourceAuthorized(this.db, row.src_id);
      } catch {
        continue;
      }
      results.push({
        ref: row.id,
        kind: 'segment',
        excerpt: row.excerpt,
        source_title: row.source_title,
        project_id: row.project_id,
        project_name: row.project_name,
        type: null,
        state: null,
        time: row.occurred_at,
      });
    }

    recordAudit(this.db, 'mcp.search_context', {
      query: input.query.slice(0, 100),
      results: results.length,
    });

    return {
      results: results.slice(0, input.limit),
      total_matches: results.length,
      notice:
        '结果为短片段。需要核对完整原文时，用 get_source_excerpt 展开引用；默认不返回完整对话。',
    };
  }

  /** get_source_excerpt：展开引用（item id 或 segment id；两条路径都过权限检查）。 */
  getSourceExcerpt(ref: string, maxChars: number): GetSourceExcerptOutput {
    // 先按 segment id 查
    const seg = this.db
      .prepare(
        `SELECT s.id, s.role, s.text, s.occurred_at, s.is_active_branch, s.sequence,
                src.title AS source_title, src.id AS source_id
         FROM segments s JOIN sources src ON src.id = s.source_id WHERE s.id = ?`,
      )
      .get(ref) as
      | {
          id: string;
          role: string;
          text: string;
          occurred_at: string | null;
          is_active_branch: number;
          sequence: number;
          source_title: string;
          source_id: string;
        }
      | undefined;

    if (seg) {
      // 权限检查：来源的读取授权必须仍有效（计划 6.3）
      assertSourceAuthorized(this.db, seg.source_id);
      const before = this.db
        .prepare('SELECT text FROM segments WHERE source_id = ? AND sequence = ?')
        .get(seg.source_id, seg.sequence - 1) as { text: string } | undefined;
      const after = this.db
        .prepare('SELECT text FROM segments WHERE source_id = ? AND sequence = ?')
        .get(seg.source_id, seg.sequence + 1) as { text: string } | undefined;
      return {
        ref,
        excerpt: seg.text.slice(0, maxChars),
        before_context: before ? before.text.slice(0, Math.floor(maxChars / 4)) : '',
        after_context: after ? after.text.slice(0, Math.floor(maxChars / 4)) : '',
        source_title: seg.source_title,
        role: seg.role,
        time: seg.occurred_at,
        is_active_branch: seg.is_active_branch === 1,
      };
    }

    // 再按 item id 查（返回第一条依据片段；权限检查与 segment 路径一致 —— 修复 P1-5 旁路）
    const itemEvidence = this.db
      .prepare(
        `SELECT s.id, s.role, s.text, s.occurred_at, s.is_active_branch, s.sequence,
                src.title AS source_title, src.id AS source_id
         FROM item_evidence e
         JOIN segments s ON s.id = e.segment_id
         JOIN sources src ON src.id = s.source_id
         WHERE e.item_id = ? LIMIT 1`,
      )
      .get(ref) as
      | {
          id: string;
          role: string;
          text: string;
          occurred_at: string | null;
          is_active_branch: number;
          sequence: number;
          source_title: string;
          source_id: string;
        }
      | undefined;
    if (itemEvidence) {
      assertSourceAuthorized(this.db, itemEvidence.source_id);
      assertCodingClientMayReadItem(this.db, ref);
      return {
        ref,
        excerpt: itemEvidence.text.slice(0, maxChars),
        before_context: '',
        after_context: '',
        source_title: itemEvidence.source_title,
        role: itemEvidence.role,
        time: itemEvidence.occurred_at,
        is_active_branch: itemEvidence.is_active_branch === 1,
      };
    }

    // RF05：人工条目（origin='user' 且无依据片段）——手工创建的结论与用户
    // 纠正后的结论没有"对话原文"可摘录，不能伪造原文：返回人工记录本身，
    // 并明确标注身份（手工记录 / 用户纠正），纠正场景附纠正前的旧结论。
    const manualItem = this.db
      .prepare(
        `SELECT type, statement, rationale, origin, supersedes_item_id, created_at
         FROM items WHERE id = ?`,
      )
      .get(ref) as
      | {
          type: string;
          statement: string;
          rationale: string | null;
          origin: string;
          supersedes_item_id: string | null;
          created_at: string;
        }
      | undefined;
    if (manualItem && manualItem.origin === 'user') {
      assertCodingClientMayReadItem(this.db, ref);
      const lines: Array<string | null> = [];
      let role: string;
      let title: string;
      if (manualItem.supersedes_item_id) {
        role = 'user_correction';
        title = '用户纠正记录（人工输入，非对话原文摘录）';
        const correction = this.db
          .prepare(`SELECT user_text, created_at FROM corrections WHERE new_item_id = ?`)
          .get(ref) as { user_text: string; created_at: string } | undefined;
        const oldItem = this.db
          .prepare(`SELECT statement, origin FROM items WHERE id = ?`)
          .get(manualItem.supersedes_item_id) as { statement: string; origin: string } | undefined;
        // 旧结论来自某个来源时，暴露它须该来源读取授权仍有效
        // （与上面 item 依据片段路径的权限检查一致）
        if (oldItem) {
          const oldEvidence = this.db
            .prepare(
              `SELECT src.id AS source_id
               FROM item_evidence e
               JOIN segments s ON s.id = e.segment_id
               JOIN sources src ON src.id = s.source_id
               WHERE e.item_id = ? LIMIT 1`,
            )
            .get(manualItem.supersedes_item_id) as { source_id: string } | undefined;
          if (oldEvidence) assertSourceAuthorized(this.db, oldEvidence.source_id);
        }
        lines.push(
          '【用户纠正结论（人工输入，非对话原文摘录）】',
          `纠正后结论：${manualItem.statement}`,
          oldItem
            ? `纠正前${oldItem.origin === 'user' ? '人工' : 'AI 提取'}结论：${oldItem.statement}`
            : null,
          correction ? `纠正时间：${correction.created_at}` : null,
        );
      } else {
        role = 'user_manual';
        title = '用户手工记录（人工创建，非对话原文摘录）';
        lines.push(
          '【用户手工记录（人工创建，非对话原文摘录）】',
          `结论：${manualItem.statement}`,
          manualItem.rationale ? `理由：${manualItem.rationale}` : null,
          `创建时间：${manualItem.created_at}`,
        );
      }
      return {
        ref,
        excerpt: lines
          .filter((l): l is string => l !== null)
          .join('\n')
          .slice(0, maxChars),
        before_context: '',
        after_context: '',
        source_title: title,
        role,
        time: manualItem.created_at,
        is_active_branch: true,
      };
    }

    // C09/A13：工作记录引用（recent_work 的 ref = work_run ID）——
    // 展开为 agent 自报工作摘要（明确标注「用户尚未验收」，不是用户决定）
    const workRun = this.db
      .prepare(
        `SELECT agent_name, task, outcome, summary, changes_json, tests_json,
                open_loops_json, commit_ref, finished_at
         FROM work_runs WHERE id = ?`,
      )
      .get(ref) as
      | {
          agent_name: string;
          task: string;
          outcome: string;
          summary: string;
          changes_json: string;
          tests_json: string;
          open_loops_json: string;
          commit_ref: string | null;
          finished_at: string;
        }
      | undefined;
    if (workRun) {
      const tests = (() => {
        try {
          return JSON.parse(workRun.tests_json) as Array<{
            name: string;
            result: string;
          }>;
        } catch {
          return [];
        }
      })();
      const loops = (() => {
        try {
          return JSON.parse(workRun.open_loops_json) as string[];
        } catch {
          return [];
        }
      })();
      const excerpt = [
        `【编码 agent 自报工作（用户尚未验收，不是用户决定）】`,
        `执行者：${workRun.agent_name}`,
        `任务：${workRun.task}`,
        `结果：${workRun.outcome}`,
        `摘要：${workRun.summary}`,
        tests.length > 0
          ? `测试：${tests.map((t) => `${t.name}=${t.result}`).join('、')}`
          : '测试：未记录',
        loops.length > 0 ? `未完成事项：${loops.join('；')}` : null,
        workRun.commit_ref ? `提交：${workRun.commit_ref}` : null,
        `完成时间：${workRun.finished_at}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
      return {
        ref,
        excerpt: excerpt.slice(0, maxChars),
        before_context: '',
        after_context: '',
        source_title: `工作记录（${workRun.agent_name} 自报）`,
        role: 'work_result',
        time: workRun.finished_at,
        is_active_branch: true,
      };
    }

    throw new IxaError(
      ErrorCodes.INVALID_REFERENCE,
      `引用不存在（既不是片段也不是条目 ID）: ${ref}`,
    );
  }

  /**
   * record_work_result：写回工作记录 + 产生 open_loop 候选
   * （计划 4.8：不得自动改变用户偏好、底线或长期决定——只入 needs_review 收件箱）。
   */
  recordWorkResult(input: RecordWorkResultInput): RecordWorkResultOutput {
    const project = this.resolveProject(input.project_ref);
    const now = new Date().toISOString();

    // M3/G7 幂等：client_ref 与内部记录 ID 分开保存（V13：内部引用长度契约不因
    // 长 client_ref 破坏）。幂等键全局唯一；比较含解析后的项目 ID 与全部
    // 有意义字段（V11：跨项目冒充成功重试 → 冲突；V12：commit_ref 差异 → 冲突）。
    if (input.client_ref) {
      const existing = this.db
        .prepare(
          `SELECT id, project_id, agent_name, task, outcome, summary,
                  changes_json, tests_json, open_loops_json, commit_ref
           FROM work_runs WHERE client_ref = ? LIMIT 1`,
        )
        .get(input.client_ref) as
        | {
            id: string;
            project_id: string;
            agent_name: string;
            task: string;
            outcome: string;
            summary: string;
            changes_json: string;
            tests_json: string;
            open_loops_json: string;
            commit_ref: string | null;
          }
        | undefined;
      if (existing) {
        const same =
          existing.project_id === project.id &&
          existing.agent_name === input.agent_name &&
          existing.task === input.task &&
          existing.outcome === input.outcome &&
          existing.summary === input.summary &&
          (existing.commit_ref ?? undefined) === input.commit_ref &&
          existing.changes_json === JSON.stringify(input.changes) &&
          existing.tests_json === JSON.stringify(input.tests) &&
          existing.open_loops_json === JSON.stringify(input.open_loops);
        if (!same) {
          throw new IxaError(
            ErrorCodes.CONFLICT,
            `client_ref 已被使用且内容不同（已有 work_run ${existing.id}，项目 ${existing.project_id === project.id ? '相同' : '不同'}）；如需提交新结果请更换 client_ref`,
          );
        }
        return { work_run_id: existing.id, deduplicated: true, open_loop_candidates: [] };
      }
    }

    const id = crypto.randomUUID();

    const candidates: Array<{ item_id: string; statement: string; ref: string }> = [];
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary,
             changes_json, tests_json, open_loops_json, commit_ref, finished_at, client_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          project.id,
          input.agent_name,
          input.task,
          input.outcome,
          input.summary,
          JSON.stringify(input.changes),
          JSON.stringify(input.tests),
          JSON.stringify(input.open_loops),
          input.commit_ref ?? null,
          now,
          input.client_ref ?? null,
        );
      // open_loop 候选：work_result 来源 + 待讨论（不自动升级为用户决定）
      for (const loop of input.open_loops) {
        const itemId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO items (id, project_id, scope, type, statement, state, confidence,
               origin, created_at, updated_at, needs_review, needs_reasons)
             VALUES (?, ?, 'project', 'open_loop', ?, 'current', 0.5, 'work_result', ?, ?, 1, 'unconfirmed')`,
          )
          .run(itemId, project.id, loop, now, now);
        candidates.push({ item_id: itemId, statement: loop, ref: itemId });
      }
    });
    tx();

    recordAudit(this.db, 'mcp.record_work_result', {
      projectId: project.id,
      workRunId: id,
      outcome: input.outcome,
      openLoops: input.open_loops.length,
    });

    return { work_run_id: id, deduplicated: false, open_loop_candidates: candidates };
  }
}
