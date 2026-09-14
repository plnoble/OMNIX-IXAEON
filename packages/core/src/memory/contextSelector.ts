import type { CoreDatabase } from '../db/database.js';
import { modelMayReadItem } from '../access.js';
import { isEphemeralStatement, questionLooksEventSpecific } from './ephemeral.js';

/**
 * A07（审核 2026-09-13）：生产与评测共用的上下文选材服务。
 * 解决「评测用一套选材逻辑、生产用另一套」的分裂问题。
 *
 * 职责：
 * 1. 按受众过滤（model 视角下严格执行 modelMayReadItem / modelMayReadSegment）
 * 2. 状态机过滤（仅 current / disputed，排除 shelved / rejected）
 * 3. 关联系数排序（问句分词匹配、意图加权、用户纠正优先）
 * 4. 一次性事件过滤（ephemeral statement 过滤）
 * 5. 预算截断（按相关度取前 N 条，不无界堆叠）
 */

export interface SelectedMemoryItem {
  id: string;
  statement: string;
  type: string;
  origin: string;
  confirmation: string;
  score: number;
}

export interface ContextSelectionResult {
  items: SelectedMemoryItem[];
  /** 格式化为随 prompt / dispatchedGoal 派发的文本段（用于注入引擎）。 */
  promptBlock: string;
  totalCandidates: number;
  selectedCount: number;
}

/** 提取问句关键词（中文 2 字滑窗，ASCII 按词）。 */
function extractKeywords(question: string): string[] {
  const keywords: string[] = [];
  const ascii = question.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  keywords.push(...ascii.map((w) => `"${w}"`));
  const cjk = question.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  keywords.push(...cjk.map((w) => `"${w}"`));
  return keywords.slice(0, 6);
}

function questionTokens(question: string): string[] {
  const keys = extractKeywords(question).map((k) => k.replace(/"/g, '').toLowerCase());
  const extra: string[] = [];
  const cjk = question.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i <= run.length - 2; i++) extra.push(run.slice(i, i + 2));
  }
  return [...new Set([...keys, ...extra])].filter((k) => k.length > 1);
}

/**
 * 生产与评测共用的选材服务核心类。
 */
export class ContextSelector {
  constructor(private readonly db: CoreDatabase) {}

  /**
   * 按受众过滤加载当前有效候选条目（与评测语料加载完全同源）。
   */
  loadVisibleCandidates(
    projectId: string | null,
    audience: 'model' | 'coding_client' | 'user' = 'model',
  ): Array<{
    id: string;
    statement: string;
    type: string;
    state: string;
    origin: string;
    confirmation: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.type, i.statement, i.state, i.origin, i.updated_at,
                i.extracted_from_source_id, i.confirmation, i.project_id, i.scope, i.rationale
         FROM items i
         LEFT JOIN sources src_i ON src_i.id = i.extracted_from_source_id
         WHERE i.state IN ('current', 'disputed') AND i.shelved_at IS NULL
           AND i.confirmation != 'rejected'
           AND (src_i.archived_at IS NULL OR i.origin = 'user'
                OR (i.origin = 'ai' AND i.type = 'project_summary'
                    AND i.rationale LIKE '归档经验摘要%'))
           ${projectId !== null ? 'AND i.project_id = ?' : ''}
         ORDER BY CASE WHEN i.origin = 'user' THEN 0 ELSE 1 END, i.updated_at DESC`,
      )
      .all(...(projectId !== null ? [projectId] : [])) as Array<{
      id: string;
      statement: string;
      type: string;
      state: string;
      origin: string;
      confirmation: string;
    }>;

    if (audience === 'model') {
      return rows.filter((r) => modelMayReadItem(this.db, r.id));
    }
    return rows;
  }

  /**
   * 针对特定问题进行语义相关度选择与排序。
   */
  selectForQuestion(
    question: string,
    projectId: string | null,
    opts: {
      audience?: 'model' | 'coding_client' | 'user';
      maxItems?: number;
    } = {},
  ): ContextSelectionResult {
    const audience = opts.audience ?? 'model';
    const maxItems = opts.maxItems ?? 24;
    const candidates = this.loadVisibleCandidates(projectId, audience);

    const q = question.toLowerCase();
    const keys = questionTokens(question);
    const scored = candidates.map((item) => {
      const st = item.statement.toLowerCase();
      let s = 0;
      if (keys.some((k) => st.includes(k))) s += 8;
      if (item.origin === 'user') s += 4;
      if (item.type === 'goal' || item.type === 'constraint' || item.type === 'preference') s += 2;
      if (/目标|想做|计划/.test(q) && item.type === 'goal') s += 3;
      if (/约束|不要|禁止/.test(q) && item.type === 'constraint') s += 3;
      if (q.includes('冲突') && item.type === 'constraint') s += 3;
      return { item, score: s };
    });

    scored.sort((a, b) => b.score - a.score);

    const eventQ = questionLooksEventSpecific(question);
    let selected = scored
      .filter((x) => x.score >= 8)
      .filter((x) => eventQ || !isEphemeralStatement(x.item.statement))
      .map((x) => ({
        id: x.item.id,
        statement: x.item.statement,
        type: x.item.type,
        state: x.item.state,
        origin: x.item.origin,
        confirmation: x.item.confirmation,
        score: x.score,
      }));

    if (selected.length === 0 && /目标|想做|理解我|目前|计划/.test(q)) {
      selected = scored
        .filter(
          (x) =>
            x.item.type === 'goal' &&
            (x.item.origin === 'user' || x.item.confirmation === 'confirmed'),
        )
        .filter((x) => eventQ || !isEphemeralStatement(x.item.statement))
        .slice(0, 12)
        .map((x) => ({
          id: x.item.id,
          statement: x.item.statement,
          type: x.item.type,
          state: x.item.state,
          origin: x.item.origin,
          confirmation: x.item.confirmation,
          score: x.score,
        }));
    }

    if (selected.length === 0 && projectId !== null) {
      // D05（审核 2026-09-14）：项目兜底同样必须过滤临时/一次性要求，允许零记忆。
      selected = scored
        .filter((x) => x.score >= 4 || x.item.type === 'goal')
        .filter((x) => eventQ || !isEphemeralStatement(x.item.statement))
        .slice(0, maxItems)
        .map((x) => ({
          id: x.item.id,
          statement: x.item.statement,
          type: x.item.type,
          state: x.item.state,
          origin: x.item.origin,
          confirmation: x.item.confirmation,
          score: x.score,
        }));
    } else {
      selected = selected.slice(0, maxItems);
    }

    const promptLines = selected.map((item) => {
      const originTag = item.origin === 'user' ? '用户指定' : '系统推断';
      const stateTag = item.state === 'disputed' ? ' · disputed/争议未定' : '';
      return `- [${item.type} · ${originTag}${stateTag}] ${item.statement}`;
    });

    const promptBlock =
      promptLines.length > 0 ? `\n\n（IXAEON 记忆上下文：\n${promptLines.join('\n')}\n）` : '';

    return {
      items: selected,
      promptBlock,
      totalCandidates: candidates.length,
      selectedCount: selected.length,
    };
  }
}
