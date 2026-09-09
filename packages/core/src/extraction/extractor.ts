import { z } from 'zod';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from './model/provider.js';
import { EXTRACT_PROMPT_VERSION, EXTRACT_SYSTEM_PROMPT } from './prompts.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { assertSourceAuthorized } from '../access.js';
import { addNeedsReason } from '../storage/needsReview.js';

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
  /** 与用户已确认/已不采纳结论相似而跳过的新条目数（M2 改口优先） */
  skippedPreserved: number;
  disputed: number;
  needsReview: number;
}

/** 发送给模型的每块字符上限（含编号、角色、提示包装后的完整 user 文本）。 */
export const MAX_BLOCK_CHARS = 8000;

/**
 * 提取器：把一个来源的片段交给模型，得到有出处的结构化结论。
 *
 * 流程（计划 5.3；修复 P1-10）：
 * 1. 以对话轮次/文档标题切块，超长单段继续按安全字符边界拆分（不突破上限）
 * 2. 所有模型块全部成功（结构、引用、长度校验通过）后，才在单个短事务中
 *    原子替换旧 current AI 理解；任一块失败 → 旧理解保持不变
 * 3. 确定性代码核验 segment_ref 真实存在（不信任模型）
 * 4. 无有效依据的结论不入当前理解（整批回滚语义）
 * 5. 冲突结论标记 disputed（不去重合并）
 * 6. 授权撤销的来源拒绝重新提取（读取边界一致）
 */
export class Extractor {
  constructor(
    private readonly db: CoreDatabase,
    private readonly provider: ModelProvider,
  ) {}

  /** 对一个来源执行提取（原子替换：模型全部成功前不删旧理解）。 */
  async extractSource(
    sourceId: string,
    opts: { shouldContinue?: () => boolean } = {},
  ): Promise<ExtractStats> {
    // 修复 F4 要求 3：接入取消信号 —— shouldContinue 在每个模型块之前与
    // 结果提交之前复查（开关/暂停/授权等由调用方注入）；返回 false 时以
    // 「已取消」中止：不再发新块，也不会把取消的结果当作最新理解提交。
    const ensureContinuing = (): void => {
      if (opts.shouldContinue && !opts.shouldContinue()) {
        const err = new IxaError(
          ErrorCodes.JOB_CANCELLED,
          '提取已取消（自动分析开关、采集开关或对话状态在执行期间发生变化）',
        ) as IxaError & { jobCancelled: boolean };
        err.jobCancelled = true;
        throw err;
      }
    };
    ensureContinuing();
    const source = this.db
      .prepare('SELECT id, title, project_id FROM sources WHERE id = ?')
      .get(sourceId) as { id: string; title: string; project_id: string | null } | undefined;
    if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, `来源不存在: ${sourceId}`);
    // 重新提取也是一次原文读取：授权撤销后拒绝
    assertSourceAuthorized(this.db, sourceId);

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

    if (segments.length === 0) {
      // 没有片段：视为成功空提取（保留旧行为），但清空旧理解需谨慎——
      // 无片段说明数据异常，保守起见不删除旧理解，直接返回
      return { inserted: 0, skippedBadRef: 0, skippedPreserved: 0, disputed: 0, needsReview: 0 };
    }

    // 默认只用当前活动分支提取理解；原文完整保留（计划 4.4）
    const active = segments.filter((s) => s.is_active_branch !== 0);
    const pool = active.length > 0 ? active : segments;

    // M2/G4/RF01/RF02 人工改口保护集：
    // 1) RF02 —— 从当前来源相关条目出发，沿 corrections 递归遍历整条纠正链
    //    （第一次纠正的用户结果没有 extracted_from_source_id，再次纠正后
    //    超出一层查询范围；用递归 CTE + 去重防循环覆盖任意深度）；
    // 2) RF01 —— 括号语义修正：范围条件（来源或纠正链）与人工条件分别加括号。
    //    旧写法 `来源 OR (链 AND 人工)` 把普通 AI 条目也纳入保护集，
    //    导致重提时旧结论被跳过重建、旧行又被删除 → 有效结论丢失。
    const manualStatements = this.loadManualProtectionScope(sourceId);
    const protectedSets = manualStatements.map((p) => bigrams(p.statement));
    // G4：字符相似度只能作为「候选关联」信号，不能证明语义相同 ——
    // 只差一个「不」的相反意见也高度相似。高度相似的新结论不直接丢弃，
    // 而是标记 needs_review 进入待讨论，与人工决定形成可见冲突由用户裁决。
    const similarProtected = (statement: string): boolean => {
      const set = bigrams(statement);
      return protectedSets.some((p) => p.size > 0 && jaccard(p, set) >= 0.6);
    };
    const exactProtected = (statement: string): boolean =>
      manualStatements.some((p) => p.statement === statement);

    const stats: ExtractStats = {
      inserted: 0,
      skippedBadRef: 0,
      skippedPreserved: 0,
      disputed: 0,
      needsReview: 0,
    };
    const collected: Array<{
      row: z.infer<typeof extractionOutputSchema>['items'][number];
      segmentId: string;
      conflictsWithProtected: boolean;
    }> = [];
    const textById = new Map(pool.map((s) => [s.id, s.text]));

    // 1) 全部模型调用（跨网络，不持锁）。任一失败直接抛出 —— 旧 current 理解保持不变。
    // 修复 R3b：每次模型请求前重新检查授权 —— 撤销后立即停止发送尚未发送的块
    //（已经发出的网络请求无法收回，但撤销之后不再发送任何新内容）。
    for (const block of this.buildBlocks(pool)) {
      ensureContinuing();
      assertSourceAuthorized(this.db, sourceId);
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
        // 修复 R5：摘录必须真实来自所引用的片段 —— 空白规范化后做子串校验，
        // 引用编号真实但摘录是模型自编（或来自其他片段）的，一律视为无效依据。
        const segText = textById.get(segmentId) ?? '';
        if (!isExcerptGroundedInSegment(item.excerpt, segText)) {
          stats.skippedBadRef++;
          continue;
        }
        if (exactProtected(item.statement)) {
          // 与人工决定逐字相同 → 不复活/不重复（G4：完全相同才跳过）
          stats.skippedPreserved++;
          continue;
        }
        // 高度相似但不完全相同：可能是有真实依据的相反意见（V07）——
        // 保留入库但标记待讨论，与人工决定形成可见冲突，不替用户选边。
        const conflictsWithProtected = similarProtected(item.statement);
        collected.push({ row: item, segmentId, conflictsWithProtected });
      }
    }

    // 2) 替换前置校验（修复 R4）：引用校验是整次替换的前置条件 ——
    // 存在无效引用（含虚构摘录）时明确失败并保留旧状态，绝不「跳过后继续替换」。
    // 与「合法分析结果为空」（模型未给出任何结论，保持旧理解、返回 0 inserted）区分。
    if (stats.skippedBadRef > 0) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `模型返回 ${stats.skippedBadRef} 条无效引用/依据，本次提取已取消，现有理解保持不变`,
      );
    }
    if (collected.length === 0) {
      // 合法分析结果为空：模型确认没有可提取结论 —— 旧理解保持不变
      return stats;
    }

    // 修复 R3b：提交新理解前最后一次授权检查（提取过程中被撤销则放弃提交）
    assertSourceAuthorized(this.db, sourceId);
    // 修复 F4 要求 3：结果提交前复查取消条件（开关/暂停在提取期间变化则放弃提交）
    ensureContinuing();
    // 修复 G5/V09：提交前重验来源归属 —— 以当前归属提交，不写回旧项目
    const projectIdAtCommit = (
      this.db.prepare('SELECT project_id AS p FROM sources WHERE id = ?').get(sourceId) as {
        p: string | null;
      }
    )?.p;

    // C05/A05/RF02：提交前用最新人工状态重新协调候选 —— 复用同一保护查询
    // （loadManualProtectionScope，含递归纠正链），覆盖模型等待期间的
    // 多次纠正、确认和不采纳。
    const recheckManual = this.loadManualProtectionScope(sourceId);
    const recheckSets = recheckManual.map((p) => bigrams(p.statement));
    const stillSafe = collected.filter(({ row }) => {
      if (recheckManual.some((p) => p.statement === row.statement)) {
        // 提交前与最新人工决定逐字相同 → 不复活（A05）
        stats.skippedPreserved++;
        return false;
      }
      return true;
    });
    // 与最新人工保护相似 → 全部标记待讨论（提交时点判定）
    for (const c of stillSafe) {
      const set = bigrams(c.row.statement);
      c.conflictsWithProtected =
        c.conflictsWithProtected || recheckSets.some((p) => p.size > 0 && jaccard(p, set) >= 0.6);
    }
    if (stillSafe.length === 0) {
      // 提交前全部被最新人工操作覆盖 → 本次不写入（旧理解即用户决定）
      return stats;
    }

    // 2) 单个短事务：删除旧 current AI 条目 + 写入新结论 + 冲突标记（原子替换）
    const now = new Date().toISOString();
    const insertItem = this.db.prepare(
      `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
         origin, observed_at, created_at, updated_at, extracted_from_source_id,
         prompt_version, model_name, needs_review, suggested_project_id)
       VALUES (?, ?, ?, ?, ?, ?, 'current', ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvidence = this.db.prepare(
      `INSERT INTO item_evidence (item_id, segment_id, excerpt, relevance)
       VALUES (?, ?, ?, ?)`,
    );
    const deleteOld = this.db.prepare(
      `DELETE FROM items
       WHERE extracted_from_source_id = ? AND origin = 'ai' AND state = 'current'
         AND confirmation = 'none'
         -- G5 后续：人工单独分配过项目的条目（manual_project=1）不被重提删除
         -- —— 用户对它做过归属决定，等价于人工操作，保护语义与确认/不采纳一致
         AND manual_project = 0`,
    );

    this.db.transaction(() => {
      deleteOld.run(sourceId);
      // C03/A01：人工单独归属过项目（manual_project=1）的条目被 deleteOld 排除而
      // 保留；新候选若与这些「已搬走的结论」逐字相同，不得在来源项目里再建一份
      // 副本 —— 用户已把它移走，重提不能把内容重新混入原项目背景。
      const movedStatements = new Set(
        (
          this.db
            .prepare(
              `SELECT statement FROM items
               WHERE extracted_from_source_id = ? AND manual_project = 1
                 AND state != 'superseded'`,
            )
            .all(sourceId) as Array<{ statement: string }>
        ).map((r) => r.statement),
      );
      const effective = stillSafe.filter(({ row }) => {
        if (movedStatements.has(row.statement)) {
          stats.skippedPreserved++;
          return false;
        }
        return true;
      });
      for (const { row, segmentId, conflictsWithProtected } of effective) {
        const itemId = crypto.randomUUID();
        // 项目归属（M1.1 + G5/V09）：以提交时点的来源归属为准 ——
        // 提取开始后用户改绑项目时不得把新理解写回旧项目。
        const projectId = projectIdAtCommit;
        let needsReview = 0;
        let suggestedProjectId: string | null = null;
        if (!projectId && row.project_hint) {
          const m = this.db
            .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE')
            .get(row.project_hint) as { id: string } | undefined;
          if (m) suggestedProjectId = m.id;
        }
        if (!projectId) needsReview = 1; // 待讨论（计划 5.1.8）
        // G4：与人工决定相似的新结论 → 待讨论（可见冲突，不替用户选边）
        if (conflictsWithProtected) needsReview = 1;
        // G6：重要决定类（decision/rejected_option/project_summary）未经用户确认
        // → 进入待讨论；「属于哪个项目」与「是否需要确认」是两个维度
        if (
          row.type === 'decision' ||
          row.type === 'rejected_option' ||
          row.type === 'project_summary'
        ) {
          needsReview = 1;
        }
        insertItem.run(
          itemId,
          projectId,
          projectId ? 'project' : 'unassigned',
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
          suggestedProjectId,
        );
        insertEvidence.run(itemId, segmentId, row.excerpt, row.confidence);
        // F01：待处理状态按原因落库 —— 缺项目/人工约束冲突是持久原因，
        // 归属操作只解除「缺项目」，冲突必须留给用户处理。
        if (!projectId) addNeedsReason(this.db, itemId, 'no_project');
        if (conflictsWithProtected) addNeedsReason(this.db, itemId, 'conflict');
        if (
          row.type === 'decision' ||
          row.type === 'rejected_option' ||
          row.type === 'project_summary'
        ) {
          addNeedsReason(this.db, itemId, 'unconfirmed');
        }
        stats.inserted++;
        if (needsReview) stats.needsReview++;
      }
      // 冲突检测：同项目同类型、statement 高度相似的当前结论 → 双方 disputed
      stats.disputed = this.markDisputed();
    })();

    return stats;
  }

  /**
   * RF01/RF02：人工保护集 —— 单一查询供初次读取与提交前重查共用。
   * 范围 =（当前来源的条目 ∪ 沿 corrections 递归可达的整条纠正链对端），
   * 且必须满足人工条件（superseded 前驱 / 已确认或已不采纳 / origin=user）。
   * 递归 CTE 从来源条目双向扩展（old→new 与 new→old），UNION 去重防循环；
   * 只在当前数据库连接内解析，不混入其他来源或项目的用户条目。
   */
  private loadManualProtectionScope(sourceId: string): Array<{ statement: string }> {
    return this.db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
           -- 起点：当前来源的条目
           SELECT id FROM items WHERE extracted_from_source_id = ?
           UNION
           -- 沿纠正链向后：old → new（纠正产生的新条目）
           SELECT c.new_item_id FROM corrections c JOIN chain ON chain.id = c.old_item_id
           UNION
           -- 沿纠正链向前：new → old（追溯前驱）
           SELECT c.old_item_id FROM corrections c JOIN chain ON chain.id = c.new_item_id
         )
         SELECT DISTINCT it.statement
         FROM items it
         WHERE it.id IN (SELECT id FROM chain)
           AND (
             it.state = 'superseded'
             OR (it.origin = 'ai' AND it.state = 'current'
                 AND it.confirmation IN ('confirmed', 'rejected'))
             OR (it.origin = 'user' AND it.state IN ('current', 'disputed'))
           )`,
      )
      .all(sourceId) as Array<{ statement: string }>;
  }

  /**
   * 按轮次/标题切块；超长单段继续按安全字符边界（标点/空白优先）拆分为
   * 带后缀编号的子片段。任何块的完整 user 文本（含编号与角色头）都不超过上限。
   */
  buildBlocks(
    segments: Array<{ id: string; sequence: number; role: string; text: string }>,
    maxChars = MAX_BLOCK_CHARS,
  ): Array<{ userText: string; refMap: Map<string, string> }> {
    // 展开超长片段 → 引用编号列表（S1、S1.2 …）→ 片段 ID（保留原始 role）。
    // 修复 N6：按「真实编号 + 角色头」计算每块预算，并为后缀位数的增长留出余量；
    // 切分后用真实头逐一校验，超限则收紧预算重切 —— 任何完整包装块都不超过上限。
    const refs: Array<{ ref: string; segId: string; role: string; piece: string }> = [];
    for (const seg of segments) {
      const base = `S${seg.sequence + 1}`;
      const baseHeader = `[${base}]（${seg.role}）\n`;
      // 余量覆盖多级后缀（如 S1.10、S1.100 的编号增长）+ 拼接换行
      let budget = maxChars - baseHeader.length - 12;
      if (budget < 200) budget = 200;
      let parts = splitTextToFit(seg.text, budget, base);
      // 用真实头校验；发现超限（后缀位数超出余量等）→ 收紧预算重切
      for (let guard = 0; guard < 16; guard++) {
        const overflow = parts.some((p, i) => {
          const ref = i === 0 ? base : `${base}.${i + 1}`;
          return `[${ref}]（${seg.role}）\n${p}`.length > maxChars;
        });
        if (!overflow) break;
        budget = Math.floor(budget * 0.85);
        parts = splitTextToFit(seg.text, budget, base);
      }
      parts.forEach((part, i) => {
        const ref = i === 0 ? base : `${base}.${i + 1}`;
        refs.push({ ref, segId: seg.id, role: seg.role, piece: part });
      });
    }

    // 组装块：整块 user 文本（多段拼接）仍不超上限
    const blocks: Array<{ userText: string; refMap: Map<string, string> }> = [];
    let currentLines: string[] = [];
    let currentLen = 0;
    const currentMap = new Map<string, string>();

    const flush = () => {
      if (currentLines.length > 0) {
        blocks.push({ userText: currentLines.join('\n'), refMap: new Map(currentMap) });
        currentLines = [];
        currentLen = 0;
        currentMap.clear();
      }
    };

    for (const r of refs) {
      // 修复 R6：保留真实说话人角色（user/assistant/system/document），
      // 不允许把对话统一改写成 doc —— 模型必须能区分「用户决定」和「助手提议」
      const piece = `[${r.ref}]（${r.role}）\n${r.piece}`;
      if (currentLen + piece.length + 1 > maxChars) flush();
      if (piece.length > maxChars) {
        // splitTextToFit 已按上限拆分，这里兜底（极端小上限）
        blocks.push({ userText: piece, refMap: new Map([[r.ref, r.segId]]) });
        continue;
      }
      currentMap.set(r.ref, r.segId);
      currentLines.push(piece);
      currentLen += piece.length + 1;
    }
    flush();
    return blocks;
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
        // F01：disputed 是持久的冲突原因 —— 归属操作不能解除，
        // 只能由用户（确认/不采纳/纠正/明确解除）处理。
        addNeedsReason(this.db, row.id, 'conflict');
        addNeedsReason(this.db, clash.id, 'conflict');
        disputed += 2;
      } else {
        seen.push({ id: row.id, project_id: row.project_id, type: row.type, set });
      }
    }
    return disputed;
  }
}

/**
 * 把文本拆成多块（每块 ≤ limit 字符）。优先在段落/句子/标点边界切，
 * 找不到安全边界时按硬字符位置切（保证不超限）。
 */
export function splitTextToFit(text: string, limit: number, label?: string): string[] {
  if (limit < 100) limit = 100; // 防御性下限（正常调用 limit ≈ 7900）
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  let guard = 0;
  while (rest.length > limit && guard++ < 100_000) {
    let cut = findSafeCut(rest, limit);
    if (cut < Math.floor(limit / 2)) cut = limit; // 安全边界太靠前 → 硬切
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    void label;
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** 在 [floor(limit/2), limit] 内找最后一个安全切点（换行 > 句号/问号/叹号 > 顿号逗号 > 空白）。 */
function findSafeCut(text: string, limit: number): number {
  const min = Math.floor(limit / 2);
  const search = (re: RegExp): number => {
    let last = -1;
    const m = [...text.slice(0, limit).matchAll(re)];
    if (m.length > 0) last = m[m.length - 1]!.index! + 1;
    return last >= min ? last : -1;
  };
  for (const re of [/\n/g, /[。！？!?]/g, /[；;：:]/g, /[，、,]/g, /\s/g]) {
    const cut = search(re);
    if (cut > 0) return cut;
  }
  return -1;
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

/**
 * 摘录真实性校验（修复 R5）：引用编号真实不代表引用的那句话真实。
 * 规则（明确、有限、可追溯）：把摘录与片段文本都做空白规范化
 * （删除全部空白字符与零宽字符）后，摘录必须是片段文本的子串。
 * 模型自编的概述（FABRICATED_…）或来自其他片段的摘录都无法通过；
 * 用户看到的每一段引文都能在对应原文中定位。
 */
export function isExcerptGroundedInSegment(excerpt: string, segmentText: string): boolean {
  const norm = (s: string): string =>
    s
      .replace(/[\s\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/[“”«»„]/g, '"')
      .replace(/[‘’]/g, "'");
  const e = norm(excerpt);
  if (e.length === 0) return false;
  return norm(segmentText).includes(e);
}
