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
import { assertSourceAuthorized } from '../access.js';

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
        `SELECT id, type, statement, rationale, state, origin, needs_review, updated_at
         FROM items
         WHERE project_id = ? AND shelved_at IS NULL AND state != 'superseded'
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
      };
      const suffix =
        item.state === 'disputed' ? '（存在冲突）' : item.origin === 'user' ? '（用户确认）' : '';
      entry.text = item.statement + suffix;
      switch (item.type) {
        case 'project_summary':
          entry.kind = 'project_purpose';
          purpose.push(entry);
          break;
        case 'decision':
          entry.kind = 'decision';
          decisions.push(entry);
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
    }));

    // 字符预算裁剪（优先级：purpose > decisions > open_loops > rejected > risks > status > work）。
    // 预算按序列化后 JSON 字符量核算，任何输出不得超过调用者声明的 max_chars。
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
    let used = 0;
    const totalBefore = JSON.stringify(groups.flat()).length;
    let truncated = false;
    for (const group of groups) {
      const kept: BriefingEntry[] = [];
      for (const entry of group) {
        const cost = JSON.stringify(entry).length;
        if (used + cost > budget) {
          truncated = true;
          continue;
        }
        used += cost;
        kept.push(entry);
      }
      group.length = 0;
      group.push(...kept);
    }

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

    recordAudit(this.db, 'mcp.prepare_task', {
      projectId: project.id,
      charsUsed: used,
      truncated,
    });

    return {
      project_id: project.id,
      project_name: project.name,
      task: input.task,
      purpose,
      status,
      decisions,
      rejected_options: rejectedOptions,
      open_loops: openLoops,
      risks,
      recent_work: recentWork,
      generated_at: new Date().toISOString(),
      char_budget: budget,
      chars_used: used,
      truncated,
      staleness_notice:
        `本简报生成于 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}。` +
        `最新记忆更新：${latestTime?.slice(0, 19).replace('T', ' ') ?? '无'}。` +
        `此后用户可能已有新决定；执行前如有疑问请用 search_context 复核或直接询问用户。` +
        (truncated ? `（简报达到 ${budget} 字符预算被截断，可用 search_context 补充检索）` : '') +
        `（原始简报 ${totalBefore} 字符）`,
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
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const candidates: Array<{ item_id: string; statement: string; ref: string }> = [];
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary,
             changes_json, tests_json, open_loops_json, commit_ref, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      // open_loop 候选：work_result 来源 + 待讨论（不自动升级为用户决定）
      for (const loop of input.open_loops) {
        const itemId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO items (id, project_id, type, statement, state, confidence,
               origin, created_at, updated_at, needs_review)
             VALUES (?, ?, 'open_loop', ?, 'current', 0.5, 'work_result', ?, ?, 1)`,
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

    return { work_run_id: id, open_loop_candidates: candidates };
  }
}
