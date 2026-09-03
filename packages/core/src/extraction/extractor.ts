import { z } from 'zod';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from './model/provider.js';
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT } from './prompts.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

/** 单次提取的输出 schema（计划 5.3.4：候选项目、决定、否决、待办、目标、约束）。 */
export const extractionOutputSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum([
          'project_summary',
          'decision',
          'rejected_option',
          'open_loop',
          'goal',
          'constraint',
          'preference',
        ]),
        statement: z.string().min(1).max(2000),
        rationale: z.string().max(4000).nullable(),
        confidence: z.number().min(0).max(1),
        /** 资料头部的片段编号，如 "S12" */
        segment_ref: z.string().min(1),
        /** 无法确定时留空 */
        project_hint: z.string().max(200).nullable(),
        excerpt: z.string().min(1).max(1500),
      }),
    )
    .max(200),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/** 提取结果统计。 */
export interface ExtractStats {
  inserted: number;
  skippedBadRef: number;
  disputed: number;
  needsReview: number;
}

/**
 * 提取器：把一个来源的片段交给模型，得到有出处的结构化结论。
 *
 * 流程（计划 5.3）：
 * 1. 以对话轮次/文档标题切块（每块 ≤ 8,000 字符，包含片段编号头）
 * 2. 模型按 JSON Schema 返回候选
 * 3. 确定性代码核验 segment_ref 真实存在（不信任模型）
 * 4. 事务写入 items + item_evidence；无有效依据的整批回滚（计划 4.6）
 * 5. 冲突结论标记 disputed（不去重合并）
 */
export class Extractor {
  constructor(
    private readonly db: CoreDatabase,
    private readonly provider: ModelProvider,
  ) {}

  /** 对一个来源执行提取（幂等：先清掉本来源无纠正的 AI 旧结论）。 */
  async extractSource(sourceId: string): Promise<ExtractStats> {
    const source = this.db
      .prepare('SELECT id, title, project_id FROM sources WHERE id = ?')
      .get(sourceId) as { id: string; title: string; project_id: string | null } | undefined;
    if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, `来源不存在: ${sourceId}`);

    const segments = this.db
      .prepare(
        `SELECT id, sequence, role, external_node_id, is_active_branch, text, occurred_at
         FROM segments WHERE source_id = ? ORDER BY sequence`,
      )
      .all(sourceId) as Array<{
      id: string;
      sequence: number;
      role: string;
      external_node_id: string | null;
      is_active_branch: number;
      text: string;
      occurred_at: string | null;
    }>;

    // 重新提取前删除本来源旧 AI 条目（有纠正的保留历史，计划 4.7 双向追溯）
    this.deleteOldAiItems(sourceId);

    if (segments.length === 0) {
      return { inserted: 0, skippedBadRef: 0, disputed: 0, needsReview: 0 };
    }

    // 默认只用当前活动分支提取理解；原文完整保留（计划 4.4）
    const active = segments.filter((s) => s.is_active_branch !== 0);
    const pool = active.length > 0 ? active : segments;

    const stats: ExtractStats = { inserted: 0, skippedBadRef: 0, disputed: 0, needsReview: 0 };
    const collected: Array<{
      row: z.infer<typeof extractionOutputSchema>['items'][number];
      segmentId: string;
    }> = [];

    for (const block of this.buildBlocks(pool)) {
      const output = await this.provider.chatStructured({
        system: EXTRACT_SYSTEM_PROMPT,
        user: block.userText,
        schema: extractionOutputSchema,
      });
      for (const item of output.items) {
        const segmentId = block.refMap.get(item.segment_ref);
        if (!segmentId) {
          stats.skippedBadRef++;
          continue;
        }
        collected.push({ row: item, segmentId });
      }
    }

    if (collected.length === 0) return stats;

    const now = new Date().toISOString();
    const insertItem = this.db.prepare(
      `INSERT INTO items (id, project_id, type, statement, rationale, state, confidence,
         origin, observed_at, created_at, updated_at, extracted_from_source_id,
         prompt_version, model_name, needs_review)
       VALUES (?, ?, ?, ?, ?, 'current', ?, 'ai', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvidence = this.db.prepare(
      `INSERT INTO item_evidence (item_id, segment_id, excerpt, relevance)
       VALUES (?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const { row, segmentId } of collected) {
        const itemId = crypto.randomUUID();
        // 项目归属：来源绑定项目 → 直接归属；否则尝试 project_hint 匹配名
        let projectId = source.project_id;
        let needsReview = 0;
        if (!projectId && row.project_hint) {
          const m = this.db
            .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE')
            .get(row.project_hint) as { id: string } | undefined;
          if (m) projectId = m.id;
        }
        if (!projectId) needsReview = 1; // 待讨论（计划 5.1.8）
        insertItem.run(
          itemId,
          projectId,
          row.type,
          row.statement,
          row.rationale,
          row.confidence,
          now,
          now,
          now,
          sourceId,
          EXTRACT_PROMPT_VERSION,
          this.provider.modelName,
          needsReview,
        );
        insertEvidence.run(itemId, segmentId, row.excerpt, row.confidence);
        stats.inserted++;
        if (needsReview) stats.needsReview++;
      }
      // 冲突检测：同项目同类型、statement 高度相似的当前结论 → 双方 disputed
      stats.disputed = this.markDisputed();
    })();

    return stats;
  }

  /** 按轮次/标题切块，块内保留片段编号 → 段 ID 映射。 */
  private buildBlocks(
    segments: Array<{ id: string; sequence: number; role: string; text: string }>,
    maxChars = 8000,
  ): Array<{ userText: string; refMap: Map<string, string> }> {
    const blocks: Array<{ userText: string; refMap: Map<string, string> }> = [];
    let currentLines: string[] = [];
    const currentMap = new Map<string, string>();

    const flush = () => {
      if (currentLines.length > 0) {
        blocks.push({ userText: currentLines.join('\n'), refMap: new Map(currentMap) });
        currentLines = [];
        currentMap.clear();
      }
    };

    for (const seg of segments) {
      // 片段编号 1-based（人类可读：S1 = 第一段）
      const ref = `S${seg.sequence + 1}`;
      const piece = `[${ref}]（${seg.role}）\n${seg.text}`;
      if (currentLines.length > 0 && currentLines.join('\n').length + piece.length > maxChars) {
        flush();
      }
      currentMap.set(ref, seg.id);
      currentLines.push(piece);
    }
    flush();
    return blocks;
  }

  /** 删除本来源的旧 AI 条目（被纠正过的保留：superseded 状态本身就是历史）。 */
  private deleteOldAiItems(sourceId: string): void {
    this.db
      .prepare(
        `DELETE FROM items
         WHERE extracted_from_source_id = ? AND origin = 'ai' AND state = 'current'`,
      )
      .run(sourceId);
  }

  /** 相似结论标记 disputed：同项目同类型、Jaccard 字符 bigram ≥ 0.6。 */
  private markDisputed(): number {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, type, statement FROM items
         WHERE state = 'current' AND origin = 'ai' AND shelved_at IS NULL`,
      )
      .all() as Array<{ id: string; project_id: string | null; type: string; statement: string }>;
    const mark = this.db.prepare(`UPDATE items SET state = 'disputed' WHERE id = ?`);
    let disputed = 0;
    const seen: Array<{ id: string; project_id: string | null; type: string; set: Set<string> }> =
      [];
    for (const row of rows) {
      const set = bigrams(row.statement);
      const clash = seen.find(
        (s) => s.project_id === row.project_id && s.type === row.type && jaccard(s.set, set) >= 0.6,
      );
      if (clash) {
        mark.run(row.id);
        mark.run(clash.id);
        disputed += 2;
      } else {
        seen.push({ id: row.id, project_id: row.project_id, type: row.type, set });
      }
    }
    return disputed;
  }
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
