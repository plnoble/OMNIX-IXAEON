import type { CoreDatabase } from '../db/database.js';
import type { SearchResult } from '@ixaeon/contracts';
import { assertSourceAuthorized } from '../access.js';

export interface SegmentSearchHit {
  segmentId: string;
  sourceId: string;
  sourceTitle: string;
  excerpt: string;
  role: string;
  occurredAt: string | null;
  projectId: string | null;
}

/**
 * SQLite FTS5 全文搜索（trigram，支持中文）。
 * 查询词进入 FTS MATCH 前做引号包裹，防止语法注入。
 *
 * 项目隔离（修复 P1-4）：指定 projectId 时仅返回明确属于该项目的来源片段
 * （project_id 严格相等）；未分配资料只在全局检索（projectId=null）出现。
 * 已撤销授权的来源在任何搜索中都不返回原文。
 */
export class SearchService {
  constructor(private readonly db: CoreDatabase) {}

  private toMatchQuery(query: string): string | null {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      // trigram 最少 3 字符；更短的关键词（如中文双字词「析衍」）用 LIKE 兜底（见下方）
      return null;
    }
    // 按空白拆词，每个词做短语引号包裹（trigram 要求 ≥3 字符）
    const terms = trimmed
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .map((t) => `"${t.replace(/"/g, '""')}"`);
    if (terms.length === 0) return null;
    return terms.join(' OR ');
  }

  /** 片段全文搜索（带来源标题、项目隔离与授权过滤）。 */
  searchSegments(
    query: string,
    opts: { projectId?: string | null; limit?: number } = {},
  ): SegmentSearchHit[] {
    const limit = Math.min(opts.limit ?? 8, 20);
    const match = this.toMatchQuery(query);
    if (match) {
      const sql = `
        SELECT sg.id AS segment_id, sg.source_id, sg.role, sg.occurred_at,
               substr(sg.text, max(1, instr(lower(sg.text), lower(?)) - 40), 240) AS excerpt,
               s.title AS source_title, s.project_id
        FROM segments_fts f
        JOIN segments sg ON sg.rowid = f.rowid
        JOIN sources s ON s.id = sg.source_id
        WHERE segments_fts MATCH ?
          ${opts.projectId ? 'AND s.project_id = ?' : ''}
        ORDER BY rank, sg.sequence
        LIMIT ?
      `;
      const params: unknown[] = [query, match];
      if (opts.projectId) params.push(opts.projectId);
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Array<{
        segment_id: string;
        source_id: string;
        role: string;
        occurred_at: string | null;
        excerpt: string | null;
        source_title: string;
        project_id: string | null;
      }>;
      return rows
        .filter((r) => this.filterAuthorized(r.source_id))
        .map((r) => ({
          segmentId: r.segment_id,
          sourceId: r.source_id,
          sourceTitle: r.source_title,
          excerpt: r.excerpt ?? '',
          role: r.role,
          occurredAt: r.occurred_at,
          projectId: r.project_id,
        }));
    }
    // 短词 LIKE 兜底
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const sql = `
      SELECT sg.id AS segment_id, sg.source_id, sg.role, sg.occurred_at,
             substr(sg.text, 1, 240) AS excerpt,
             s.title AS source_title, s.project_id
      FROM segments sg
      JOIN sources s ON s.id = sg.source_id
      WHERE sg.text LIKE ?
        ${opts.projectId ? 'AND s.project_id = ?' : ''}
      ORDER BY sg.sequence
      LIMIT ?
    `;
    const params: unknown[] = [like];
    if (opts.projectId) params.push(opts.projectId);
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      segment_id: string;
      source_id: string;
      role: string;
      occurred_at: string | null;
      excerpt: string | null;
      source_title: string;
      project_id: string | null;
    }>;
    return rows
      .filter((r) => this.filterAuthorized(r.source_id))
      .map((r) => ({
        segmentId: r.segment_id,
        sourceId: r.source_id,
        sourceTitle: r.source_title,
        excerpt: r.excerpt ?? '',
        role: r.role,
        occurredAt: r.occurred_at,
        projectId: r.project_id,
      }));
  }

  /** 授权过滤：撤销授权的来源不进入任何搜索结果（含 LIKE 兜底路径）。 */
  private filterAuthorized(sourceId: string): boolean {
    try {
      assertSourceAuthorized(this.db, sourceId);
      return true;
    } catch {
      return false;
    }
  }

  /** 结论（items）检索：供 MCP search_context 与问答候选。 */
  searchItems(
    query: string,
    opts: {
      projectId?: string | null;
      type?: string | null;
      states?: Array<'current' | 'disputed' | 'superseded'>;
      limit?: number;
      /** C06/A10：默认排除已拒绝建议（不作为当前结论返回）；显式开启可查历史 */
      includeRejected?: boolean;
    } = {},
  ): SearchResult[] {
    const limit = Math.min(opts.limit ?? 8, 20);
    const states = opts.states ?? ['current', 'disputed'];
    const placeholders = states.map(() => '?').join(',');
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const sql = `
      SELECT i.id, i.type, i.state, i.statement, i.updated_at,
             p.name AS project_name, p.id AS project_id,
             (SELECT s.title FROM item_evidence e JOIN segments sg ON sg.id = e.segment_id
               JOIN sources s ON s.id = sg.source_id WHERE e.item_id = i.id LIMIT 1) AS source_title
      FROM items i
      LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.state IN (${placeholders})
        ${opts.includeRejected === true ? '' : "AND (i.confirmation IS NULL OR i.confirmation != 'rejected')"}
        ${opts.projectId ? 'AND i.project_id = ?' : ''}
        ${opts.type ? 'AND i.type = ?' : ''}
        AND (i.statement LIKE ? OR i.rationale LIKE ?)
      ORDER BY i.updated_at DESC
      LIMIT ?
    `;
    const params: unknown[] = [...states];
    if (opts.projectId) params.push(opts.projectId);
    if (opts.type) params.push(opts.type);
    params.push(like, like, limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      type: string;
      state: string;
      statement: string;
      updated_at: string;
      project_name: string | null;
      project_id: string | null;
      source_title: string | null;
    }>;
    return rows.map((r) => ({
      ref: r.id,
      kind: 'item',
      excerpt: r.statement.slice(0, 400),
      source_title: r.source_title ?? '（用户输入 / 工作记录）',
      project_id: r.project_id,
      project_name: r.project_name,
      type: r.type as SearchResult['type'],
      state: r.state as SearchResult['state'],
      time: r.updated_at,
    }));
  }

  /** 混合检索（items 优先，segments 兜底），供问答上下文组装。 */
  searchAll(
    query: string,
    opts: { projectId?: string | null; limit?: number },
  ): { items: SearchResult[]; segments: SegmentSearchHit[] } {
    return {
      items: this.searchItems(query, { projectId: opts.projectId, limit: opts.limit }),
      segments: this.searchSegments(query, { projectId: opts.projectId, limit: opts.limit }),
    };
  }
}
