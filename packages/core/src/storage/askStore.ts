import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import { ASK_SYSTEM_PROMPT } from '../extraction/prompts.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { assertSourceAuthorized } from '../access.js';

/** 问答用的检索片段（引用编号 + 内容）。 */
interface CitedSegment {
  ref: string;
  segmentId: string;
  sourceTitle: string;
  role: string;
  occurredAt: string | null;
  text: string;
  isUserCorrection: boolean;
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

    // 1) 当前条目（用户纠正优先排前）作为候选资料
    const items = this.db
      .prepare(
        `SELECT i.id, i.type, i.statement, i.state, i.origin, i.updated_at,
                i.extracted_from_source_id
         FROM items i
         WHERE i.state IN ('current', 'disputed') AND i.shelved_at IS NULL
           ${projectId !== null ? 'AND i.project_id = ?' : ''}
         ORDER BY CASE WHEN i.origin = 'user' THEN 0 ELSE 1 END, i.updated_at DESC
         LIMIT 60`,
      )
      .all(...(projectId !== null ? [projectId] : [])) as Array<{
      id: string;
      type: string;
      statement: string;
      state: string;
      origin: string;
      updated_at: string;
      extracted_from_source_id: string | null;
    }>;

    const cited: CitedSegment[] = [];
    const pushCited = (c: CitedSegment) => {
      if (cited.find((x) => x.segmentId === c.segmentId)) return;
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
    for (const item of items) {
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
        segmentId: evAllowed && ev ? ev.segment_id : `item:${item.id}`,
        sourceTitle: item.origin === 'user' ? '用户纠正' : evAllowed && ev ? ev.title : '条目',
        role: item.origin === 'user' ? 'user' : evAllowed && ev ? ev.role : 'item',
        occurredAt: item.updated_at,
        text:
          item.origin === 'user'
            ? `[用户纠正 · ${item.type}] ${item.statement}`
            : `[${item.type}${item.state === 'disputed' ? ' · 存在冲突' : ''}] ${item.statement}${evAllowed && ev ? `\n依据摘录：${ev.excerpt}` : ''}`,
        isUserCorrection: item.origin === 'user',
      });
      if (usedChars(cited) > MAX_CONTEXT_CHARS) break;
    }

    // 2) 关键词检索补充原文片段（FTS rowid 正确连接 + 项目隔离 + 授权过滤）
    const keywords = extractKeywords(question);
    if (keywords.length > 0) {
      const segs = this.db
        .prepare(
          `SELECT sg.id, sg.role, sg.text, sg.occurred_at, src.title, src.project_id, src.id AS source_id
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
          segmentId: seg.id,
          sourceTitle: seg.title,
          role: seg.role,
          occurredAt: seg.occurred_at,
          text: seg.text.slice(0, 1200),
          isUserCorrection: false,
        });
        if (usedChars(cited) > MAX_CONTEXT_CHARS) break;
      }
    }

    if (cited.length === 0) {
      return {
        answer: '资料不足：当前项目还没有可用的记忆。请先导入资料或等待提取完成。',
        citations: [],
        notice: '资料不足',
        usedChars: 0,
        modelName: this.provider.modelName,
      };
    }

    // 3) 组装上下文（12,000 字符预算）
    const context = cited
      .map((c) => `[${c.ref}]（${c.sourceTitle} / ${c.role}）\n${c.text}`)
      .join('\n\n');

    const answer = await this.provider.chatText({
      system: ASK_SYSTEM_PROMPT,
      user: `问题：${question.trim()}\n\n资料（每条头部为引用编号）：\n\n${context}`,
    });

    // 冲突提示
    const disputedItems = items.filter((i) => i.state === 'disputed');
    const notice =
      disputedItems.length > 0
        ? `注意：有 ${disputedItems.length} 条结论存在来源冲突，回答中应已分别标注。`
        : null;

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

/** 简单分词：中文按 2 字滑窗，ASCII 按词。FTS trigram 需要 ≥2 字。 */
function extractKeywords(question: string): string[] {
  const keywords: string[] = [];
  const ascii = question.match(/[A-Za-z0-9_]{2,}/g) ?? [];
  keywords.push(...ascii.map((w) => `"${w}"`));
  const cjk = question.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];
  keywords.push(...cjk.map((w) => `"${w}"`));
  return keywords.slice(0, 6);
}
