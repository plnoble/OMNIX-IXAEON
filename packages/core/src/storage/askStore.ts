import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import { ASK_SYSTEM_PROMPT } from '../extraction/prompts.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { assertSourceAuthorized } from '../access.js';

/** 问答用的检索片段（引用编号 + 内容）。 */
interface CitedSegment {
  ref: string;
  /** C07：条目身份（去重键）；原文片段检索条目为 null */
  itemId: string | null;
  segmentId: string;
  sourceTitle: string;
  role: string;
  occurredAt: string | null;
  text: string;
  isUserCorrection: boolean;
}

export interface AskCoverage {
  generatedAt: string;
  includedProjects: string[];
  omittedProjects: string[];
  unanalyzedSources: number;
  unassignedItems: number;
  budgetLimited: boolean;
}

export interface AskResult {
  answer: string;
  citations: Array<{
    ref: string;
    segmentId: string;
    sourceTitle: string;
    role: string;
    excerpt: string;
    isUserCorrection: boolean;
  }>;
  notice: string | null;
  usedChars: number;
  modelName: string;
  coverage?: AskCoverage;
}

const MAX_CONTEXT_CHARS = 12_000;

/**
 * 问答（计划 5.6；修复 P1-4）：
 * 1. 项目内当前条目（含用户纠正）+ 全文检索候选片段
 * 2. 用户纠正优先于旧 AI 推断
 * 3. 冲突声明（disputed 条目附 notice）
 * 4. 引用编号可核验（citations 带 segment_id）
 * 5. 资料不足时明确回答而不是编造
 *
 * 项目隔离与授权：指定项目时 FTS 只匹配明确属于该项目的来源片段
 * （project_id 严格相等，未分配资料不混入）；已撤销授权的来源不进入上下文。
 */
export class AskService {
  constructor(
    private readonly db: CoreDatabase,
    private readonly provider: ModelProvider,
  ) {}

  async ask(projectId: string | null, question: string): Promise<AskResult> {
    if (question.trim().length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '问题不能为空');
    }

    const coverage = this.coverage(projectId);
    let budgetHit = false;
    // 1) 当前条目：个人视角从全部获准候选按问题筛选，不取「最近 60 条」冒充完整理解
    const items = this.db
      .prepare(
        `SELECT i.id, i.type, i.statement, i.state, i.origin, i.updated_at,
                i.extracted_from_source_id, i.confirmation, i.project_id, i.scope,
                i.rationale
         FROM items i
         LEFT JOIN sources src_i ON src_i.id = i.extracted_from_source_id
         WHERE i.state IN ('current', 'disputed') AND i.shelved_at IS NULL
           AND i.confirmation != 'rejected'
           AND (src_i.archived_at IS NULL
                OR i.origin = 'user'
                OR (i.origin = 'ai' AND i.type = 'project_summary'
                    AND i.rationale LIKE '归档经验摘要%'))
           ${projectId !== null ? 'AND i.project_id = ?' : ''}
         ORDER BY CASE WHEN i.origin = 'user' THEN 0
                       WHEN i.confirmation = 'confirmed' THEN 1
                       ELSE 2 END, i.updated_at DESC`,
      )
      .all(...(projectId !== null ? [projectId] : [])) as Array<{
      id: string;
      type: string;
      statement: string;
      state: string;
      origin: string;
      updated_at: string;
      extracted_from_source_id: string | null;
      confirmation: string;
      project_id: string | null;
      scope: string;
      rationale: string | null;
    }>;
    const ranked = rankItemsForQuestion(items, question).slice(0, 80);

    const cited: CitedSegment[] = [];
    // C07/A12：去重键分两层 —— 「条目身份」（item.id）与「原文依据身份」
    // （segmentId）。一段原文支持多条不同结论时全部保留（各自有独立陈述）；
    // 仅当同一条目重复出现时才跳过。摘录级重复由条目各自的 text 承载，不再
    // 因为共享 segment 就丢掉后面的结论。
    const seenItemIds = new Set<string>();
    const pushCited = (c: CitedSegment) => {
      if (c.itemId !== null) {
        if (seenItemIds.has(c.itemId)) return;
        seenItemIds.add(c.itemId);
      }
      cited.push(c);
    };

    // 每个条目附第一条依据片段（可核验出处；来源授权撤销后只保留条目陈述，不带原文）
    const evidenceStmt = this.db.prepare(
      `SELECT e.segment_id, e.excerpt, s.role, s.text, s.occurred_at, s.source_id, src.title
       FROM item_evidence e
       JOIN segments s ON s.id = e.segment_id
       JOIN sources src ON src.id = s.source_id
       WHERE e.item_id = ? LIMIT 1`,
    );
    let refCounter = 0;
    for (const item of ranked) {
      refCounter += 1;
      const ref = `R${refCounter}`;
      const ev = evidenceStmt.get(item.id) as
        | {
            segment_id: string;
            excerpt: string;
            role: string;
            text: string;
            occurred_at: string | null;
            source_id: string;
            title: string;
          }
        | undefined;
      const evAllowed =
        ev !== undefined &&
        this.sourceReadable(ev.source_id) &&
        this.evidenceInProject(ev.source_id, projectId);
      pushCited({
        ref,
        itemId: item.id,
        segmentId: evAllowed && ev ? ev.segment_id : `item:${item.id}`,
        sourceTitle: item.origin === 'user' ? '用户纠正' : evAllowed && ev ? ev.title : '条目',
        role: item.origin === 'user' ? 'user' : evAllowed && ev ? ev.role : 'item',
        occurredAt: item.updated_at,
        text: formatItemForAsk(item, evAllowed && ev ? ev.excerpt : null),
        isUserCorrection: item.origin === 'user',
      });
      if (usedChars(cited) > MAX_CONTEXT_CHARS) {
        budgetHit = true;
        break;
      }
    }

    // 2) 关键词检索补充原文片段（FTS rowid 正确连接 + 项目隔离 + 授权过滤）
    const keywords = extractKeywords(question);
    if (keywords.length > 0) {
      const segs = this.db
        .prepare(
          `SELECT sg.id, sg.role, sg.text, sg.occurred_at, src.title, src.project_id, src.id AS source_id,
                  src.archived_at, src.archive_summary
           FROM segments_fts f
           JOIN segments sg ON sg.rowid = f.rowid
           JOIN sources src ON src.id = sg.source_id
           WHERE segments_fts MATCH ?
           ORDER BY rank LIMIT 24`,
        )
        .all(keywords.join(' OR ')) as Array<{
        id: string;
        role: string;
        text: string;
        occurred_at: string | null;
        title: string;
        project_id: string | null;
        source_id: string;
        archived_at: string | null;
        archive_summary: string | null;
      }>;
      for (const seg of segs) {
        // 项目隔离：指定项目时只允许明确属于该项目的片段（未分配不混入）
        if (projectId !== null && seg.project_id !== projectId) continue;
        // 授权隔离：撤销授权的来源不进入问答上下文
        if (!this.sourceReadable(seg.source_id)) continue;
        refCounter += 1;
        const ref = `R${refCounter}`;
        pushCited({
          ref,
          itemId: null, // 原文片段检索：非条目，不作条目去重
          segmentId: seg.id,
          sourceTitle: seg.title,
          role: seg.role,
          occurredAt: seg.occurred_at,
          text: seg.archived_at
            ? `[过往工作档案${seg.archive_summary ? ` · 经验：${seg.archive_summary}` : ''}] ${seg.text.slice(0, 1000)}`
            : seg.text.slice(0, 1200),
          isUserCorrection: false,
        });
        if (usedChars(cited) > MAX_CONTEXT_CHARS) {
          budgetHit = true;
          break;
        }
      }
    }

    if (cited.length === 0) {
      return {
        answer:
          projectId === null
            ? '资料不足：还没有可用的个人或跨项目记忆。请先导入资料、标为个人，或等待提取完成。'
            : '资料不足：当前项目还没有可用的记忆。请先导入资料或等待提取完成。',
        citations: [],
        notice: '资料不足',
        usedChars: 0,
        modelName: this.provider.modelName,
        coverage,
      };
    }

    // 3) 组装上下文（12,000 字符预算）
    const context = cited
      .map((c) => `[${c.ref}]（${c.sourceTitle} / ${c.role}）\n${c.text}`)
      .join('\n\n');

    const disputedItems = ranked.filter((i) => i.state === 'disputed');
    const coverageNotes: string[] = [];
    if (disputedItems.length > 0) {
      coverageNotes.push(`有 ${disputedItems.length} 条结论存在来源冲突，回答中应已分别标注。`);
    }
    if (coverage.unanalyzedSources > 0) {
      coverageNotes.push(`${coverage.unanalyzedSources} 个来源有新内容尚未分析。`);
    }
    if (coverage.unassignedItems > 0 && projectId === null) {
      coverageNotes.push(`${coverage.unassignedItems} 条记忆仍未整理范围。`);
    }
    coverage.budgetLimited = budgetHit;
    if (coverage.budgetLimited) {
      coverageNotes.push('检索预算不足，部分候选未纳入本次回答，未静默截掉冲突项。');
    }
    const notice = coverageNotes.length > 0 ? coverageNotes.join(' ') : null;
    const coverageBlock =
      notice === null
        ? '覆盖说明：本次检索未发现未分析来源、未整理范围或预算截断。资料仍不是用户的全部记忆。'
        : `覆盖说明：${notice}`;

    const answer = await this.provider.chatText({
      system: ASK_SYSTEM_PROMPT,
      user: `问题：${question.trim()}\n\n${coverageBlock}\n\n资料（每条头部为引用编号）：\n\n${context}`,
    });

    // 4) 提取回答中实际使用的引用（[R3] 形式）
    const usedRefs = new Set<string>();
    for (const m of answer.matchAll(/\[R(\d+)\]/g)) usedRefs.add(`R${m[1]}`);
    const citations = cited
      .filter((c) => usedRefs.size === 0 || usedRefs.has(c.ref))
      .map((c) => ({
        ref: c.ref,
        segmentId: c.segmentId,
        sourceTitle: c.sourceTitle,
        role: c.role,
        excerpt: c.text.slice(0, 300),
        isUserCorrection: c.isUserCorrection,
      }));

    return {
      answer,
      citations,
      notice,
      usedChars: context.length,
      modelName: this.provider.modelName,
      coverage,
    };
  }

  private coverage(projectId: string | null): AskCoverage {
    const projects = this.db.prepare('SELECT id, name FROM projects').all() as Array<{
      id: string;
      name: string;
    }>;
    const unanalyzed = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM sources WHERE archived_at IS NULL AND COALESCE(content_revision, 0) > COALESCE(analyzed_revision, 0)',
        )
        .get() as { n: number }
    ).n;
    const unassigned = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM items i
           LEFT JOIN sources s ON s.id = i.extracted_from_source_id
           WHERE i.scope = 'unassigned' AND i.state IN ('current', 'disputed')
             AND i.confirmation != 'rejected' AND i.shelved_at IS NULL
             AND s.archived_at IS NULL
             AND NOT (i.origin = 'ai' AND i.type = 'project_summary' AND i.rationale LIKE '归档经验摘要%')`,
        )
        .get() as { n: number }
    ).n;
    const included =
      projectId === null
        ? projects.map((p) => p.name)
        : projects.filter((p) => p.id === projectId).map((p) => p.name);
    return {
      generatedAt: new Date().toISOString(),
      includedProjects: included,
      omittedProjects: [],
      unanalyzedSources: unanalyzed,
      unassignedItems: unassigned,
      budgetLimited: false,
    };
  }

  /** 来源授权是否仍有效（撤销后其原文不进入问答上下文）。 */
  private sourceReadable(sourceId: string): boolean {
    try {
      assertSourceAuthorized(this.db, sourceId);
      return true;
    } catch {
      return false;
    }
  }

  /** 条目依据片段是否在问答项目范围内（全局问答放行）。 */
  private evidenceInProject(sourceId: string, projectId: string | null): boolean {
    if (projectId === null) return true;
    const row = this.db.prepare('SELECT project_id FROM sources WHERE id = ?').get(sourceId) as
      { project_id: string | null } | undefined;
    return row?.project_id === projectId;
  }
}

function usedChars(cited: CitedSegment[]): number {
  return cited.reduce((n, c) => n + c.text.length + 60, 0);
}

function isArchiveExperience(item: {
  origin: string;
  type: string;
  rationale: string | null;
}): boolean {
  return (
    item.origin === 'ai' &&
    item.type === 'project_summary' &&
    (item.rationale ?? '').startsWith('归档经验摘要')
  );
}

function formatItemForAsk(
  item: {
    type: string;
    statement: string;
    state: string;
    origin: string;
    confirmation: string;
    rationale: string | null;
  },
  excerpt: string | null,
): string {
  if (item.origin === 'user') return `[用户纠正 · ${item.type}] ${item.statement}`;
  if (isArchiveExperience(item)) return `[过往工作档案 · 经验摘要] ${item.statement}`;
  return `[${item.type}${item.state === 'disputed' ? ' · 存在冲突' : ''}${confirmationLabel(item.confirmation)}] ${item.statement}${excerpt ? `\n依据摘录：${excerpt}` : ''}`;
}

/** C06/A11：把确认状态告诉模型 —— 待确认与已确认的语境必须可区分。 */
function confirmationLabel(confirmation: string): string {
  if (confirmation === 'confirmed') return ' · 用户已确认';
  if (confirmation === 'rejected') return ' · 用户已拒绝';
  return ' · 待用户确认';
}

/** 简单分词：中文按 2 字滑窗，ASCII 按词。FTS trigram 需要 ≥2 字。 */
function extractKeywords(question: string): string[] {
  const keywords: string[] = [];
  const ascii = question.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  keywords.push(...ascii.map((w) => `"${w}"`));
  const cjk = question.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  keywords.push(...cjk.map((w) => `"${w}"`));
  return keywords.slice(0, 6);
}

function rankItemsForQuestion<T extends { statement: string; type: string; origin: string }>(
  items: T[],
  question: string,
): T[] {
  const q = question.toLowerCase();
  const keys = extractKeywords(question).map((k) => k.replace(/"/g, ''));
  const score = (item: T): number => {
    let s = 0;
    const st = item.statement.toLowerCase();
    if (keys.some((k) => k.length > 0 && st.includes(k.toLowerCase()))) s += 8;
    if (item.origin === 'user') s += 4;
    if (item.type === 'goal' || item.type === 'constraint' || item.type === 'preference') s += 2;
    if (q.includes('冲突') && item.type === 'constraint') s += 3;
    if (q.includes('目标') && item.type === 'goal') s += 3;
    return s;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}
