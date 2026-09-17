import type { CoreDatabase } from '../db/database.js';
import { modelMayReadItem } from '../access.js';
import { isEphemeralStatement, questionLooksEventSpecific } from './ephemeral.js';
import type { SemanticIndex } from './semanticIndex.js';

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
  /** 这条是什么时候记下的（observed_at，退回 updated_at）。不是事情发生的日期。 */
  recordedAt: string;
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
    recordedAt: string;
  }> {
    const raw = this.db
      .prepare(
        `SELECT i.id, i.type, i.statement, i.state, i.origin, i.updated_at,
                COALESCE(i.observed_at, i.updated_at) AS recorded_at,
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
      recorded_at: string;
    }>;
    const rows = raw.map((r) => ({ ...r, recordedAt: r.recorded_at }));

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
        recordedAt: x.item.recordedAt,
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
          recordedAt: x.item.recordedAt,
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
          recordedAt: x.item.recordedAt,
        }));
    } else {
      selected = selected.slice(0, maxItems);
    }

    return {
      items: selected,
      promptBlock: buildPromptBlock(selected),
      totalCandidates: candidates.length,
      selectedCount: selected.length,
    };
  }

  /**
   * 混合选材：本机语义相似度 + 关键词（三周任务单 R1/R3）。
   *
   * 首次真机问题：关键词路径里问句任意两字片段出现在条目中就给入选分，
   * 「正式系统名是什么」的「正式」撞上「正式开业」，「什么」几乎撞上一切。
   * 这里的规则：
   * - 有向量时：相似度达到 relevant → 入选；英文/数字标识符或 ≥4 字中文精确命中
   *  （项目代号、文件名一类，字面最可靠）→ 入选；2–3 字中文片段命中 → 需相似度
   *   达到 weakConfirm 才入选，不再单独算数；
   * - 条目还没有当前向量时：沿用关键词规则，补向量期间召回不变差；
   * - 语义服务不可用时：整体退回关键词路径，并在 retrievalNotice 里如实说明。
   * 候选范围与权限过滤完全沿用 loadVisibleCandidates，有向量不代表可以被取用。
   */
  async selectForQuestionHybrid(
    question: string,
    projectId: string | null,
    opts: {
      audience?: 'model' | 'coding_client' | 'user';
      maxItems?: number;
      semantic?: SemanticIndex | null;
      thresholds?: SemanticThresholds;
    } = {},
  ): Promise<
    ContextSelectionResult & { retrieval: 'hybrid' | 'keyword'; retrievalNotice: string | null }
  > {
    const audience = opts.audience ?? 'model';
    const maxItems = opts.maxItems ?? 24;
    const semantic = opts.semantic ?? null;
    const t = opts.thresholds ?? SEMANTIC_THRESHOLDS;
    const keywordOnly = (notice: string) => ({
      ...this.selectForQuestion(question, projectId, { audience, maxItems }),
      retrieval: 'keyword' as const,
      retrievalNotice: notice,
    });
    if (!semantic) return keywordOnly('语义检索未启用，本轮按关键词选取记忆。');

    const candidates = this.loadVisibleCandidates(projectId, audience);
    let sims: Map<string, number>;
    try {
      // 「A和B……」这类并列问题整句向量会被两头拉扯，另按各自子问题再查一次，取最高
      //（真机：「花园和健身哪个更急」整句对半程马拉松 0.417，「健身哪个更急」0.462）。
      sims = await semantic.score(
        [question, ...conjunctSubQueries(question)],
        candidates.map((c) => c.id),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return keywordOnly(`语义检索暂不可用（${reason.slice(0, 120)}），本轮按关键词选取记忆。`);
    }

    const q = question.toLowerCase();
    const idents = identifierTokens(question);
    const eventQ = questionLooksEventSpecific(question);
    const scored = candidates.map((item) => {
      const st = item.statement.toLowerCase();
      const cjk = longestCjkOverlap(question, item.statement);
      const strong = idents.some((k) => st.includes(k)) || cjk >= 4;
      const weak = cjk >= 2;
      const sim = sims.get(item.id);
      const relevant =
        sim === undefined
          ? strong || weak
          : sim >= t.relevant || strong || (weak && sim >= t.weakConfirm);
      let rank = (sim ?? 0) + (strong ? 0.3 : 0) + (weak ? 0.05 : 0);
      if (item.origin === 'user') rank += 0.05;
      if (item.type === 'goal' || item.type === 'constraint' || item.type === 'preference') {
        rank += 0.02;
      }
      return { item, sim, relevant, rank };
    });
    scored.sort((a, b) => b.rank - a.rank);
    const toSelected = (x: (typeof scored)[number]): SelectedMemoryItem & { state: string } => ({
      id: x.item.id,
      statement: x.item.statement,
      type: x.item.type,
      state: x.item.state,
      origin: x.item.origin,
      confirmation: x.item.confirmation,
      score: Math.round(x.rank * 100),
      recordedAt: x.item.recordedAt,
    });
    const notEphemeral = (x: (typeof scored)[number]) =>
      eventQ || !isEphemeralStatement(x.item.statement);

    let selected = scored
      .filter((x) => x.relevant)
      .filter(notEphemeral)
      .map(toSelected);

    // 与关键词路径相同的两个兜底（均来自既往审核）：问整体目标时给已确认目标；
    // 项目视角下给用户指定的条目与目标。允许零记忆。
    if (selected.length === 0 && /目标|想做|理解我|目前|计划/.test(q)) {
      selected = scored
        .filter(
          (x) =>
            x.item.type === 'goal' &&
            (x.item.origin === 'user' || x.item.confirmation === 'confirmed'),
        )
        .filter(notEphemeral)
        .slice(0, 12)
        .map(toSelected);
    }
    // 概览兜底：问题明确在问「我最近/现在在忙什么、手上有哪些事」时，给目标与待办。
    // 真实用户的记忆几乎全是 AI 提炼、未经确认的（按「普通理解不必逐条确认」的设计），
    // 上面那条只认已确认目标的兜底对他们永远不会触发——2026-09-17 在用户真实资料副本上，
    // 65 条可见记忆里只有 1 条已确认，「我最近在忙什么」一条记忆都没拿到。
    // 触发条件刻意从严：宽松的「含目标/计划」会被「什么是目标检测算法」这类问题误触发，
    // 所以那条兜底仍只放已确认目标，放宽候选范围只在这里、只对明确的概览问题。
    // 概览问题与具体条目的语义相似度天然偏低且平坦（真实资料上最高 0.369），不能靠语义阈值。
    if (selected.length === 0 && isOverviewQuestion(question)) {
      const byId = new Map(scored.map((x) => [x.item.id, x]));
      // candidates 已按「用户指定优先、最近更新优先」排序
      selected = candidates
        .filter((c) => c.type === 'goal' || c.type === 'open_loop')
        .map((c) => byId.get(c.id)!)
        .filter(notEphemeral)
        .slice(0, maxItems)
        .map(toSelected);
    }
    if (selected.length === 0 && projectId !== null) {
      selected = scored
        .filter(
          (x) =>
            x.item.origin === 'user' ||
            x.item.type === 'goal' ||
            (x.sim !== undefined && x.sim >= t.weakConfirm),
        )
        .filter(notEphemeral)
        .map(toSelected);
    }
    selected = selected.slice(0, maxItems);

    const unindexed = candidates.filter((c) => !sims.has(c.id)).length;
    return {
      items: selected,
      promptBlock: buildPromptBlock(selected),
      totalCandidates: candidates.length,
      selectedCount: selected.length,
      retrieval: 'hybrid',
      retrievalNotice:
        unindexed > 0
          ? `语义索引尚未覆盖 ${unindexed} / ${candidates.length} 条候选记忆，这部分按关键词判断。`
          : null,
    };
  }
}

export interface SemanticThresholds {
  /** 相似度达到即入选 */
  relevant: number;
  /** 2–3 字中文片段命中时所需的相似度 */
  weakConfirm: number;
}

/**
 * 语义判定阈值（qwen3-embedding:0.6b，2026-09-17 在记忆评测语料上校准）：
 * - 个人视角 10 道「无关话题」题，每题最高相似度 0.248–0.403；
 * - 期望召回的条目多在 0.55 以上，最低的是并列题拆分后的 0.462；
 * - 60 个场景全过（且无关题一条都不选）的区间：relevant 0.42–0.45、weakConfirm 0.35–0.40
 *  （0.48 丢并列题召回，weakConfirm 0.45 丢 x7）。选材对阈值单调，取区间中部。
 * 曾试过「相对同批候选的标准分」规则，已弃用：无关题最高分的标准分为 1.43–2.71，
 * 相关题为 1.87–2.79，两者完全重叠——候选只有十来条时，噪音的最大值天然显得突出。
 * 换模型需重新校准，见 packages/core/test/integration/hybrid-memory-eval.test.ts。
 */
export const SEMANTIC_THRESHOLDS: SemanticThresholds = {
  relevant: 0.43,
  weakConfirm: 0.38,
};

/**
 * 「问我自己的整体情况」的问句。主语必须是「我」，且整句就是在问概览；
 * 只含「目标」「计划」「想做」字样的不算（「我的目标检测模型」「我想做红烧肉」
 * 「帮我制定健身计划」「我手上的伤」都不能触发）。
 */
const OVERVIEW_PATTERNS: RegExp[] = [
  // 我最近/现在/这段时间在忙什么、在做些什么（「在做什么样的」不算）
  /我(最近|现在|目前|这阵子|这段时间|这几天|近来)?(都|还)?在(忙|做|搞)些?(什么|啥)(?!样)/,
  // 我手上/手头有哪些事
  /我(现在|目前)?(手上|手头)(都|还)?有(哪些|什么|啥)(事|活|工作)/,
  // 我的目标/计划是什么、有哪些
  /我(最近|现在|目前|接下来)?的(目标|计划)都?(是|有)(什么|哪些|啥)/,
  // 我接下来该做什么（整句只问这个；「我想做什么菜」不算）
  /我(最近|现在|目前|接下来)?(想|要|该|应该)做些?(什么|哪些事|啥)[？?。！!]*$/,
  // 你了解我吗、你对我了解多少（「理解我」偏情感，不算）
  /(了解|认识)我(吗|多少)?[？?。！!]*$|对我有?(多少|多)?(了解|认识)/,
];

export function isOverviewQuestion(question: string): boolean {
  return OVERVIEW_PATTERNS.some((re) => re.test(question));
}

const CONJUNCTION = /(和|与|跟|及|还是|或者)/;

/**
 * 并列问题拆成子问题，保留共同的后半句：
 * 「花园和健身哪个更急？」→「花园哪个更急？」「健身哪个更急？」。
 * 不做分词，按「并列两项长度相近」估计右项边界；估不准时子问题只是多一个
 * 噪音查询（与整句取最高），不会丢掉整句的结果。左项少于 2 个汉字不拆
 *（避开「和平」「温和」这类词里的「和」）。
 */
export function conjunctSubQueries(question: string): string[] {
  const m = CONJUNCTION.exec(question);
  if (!m || m.index === undefined) return [];
  const left = question.slice(0, m.index).trim();
  const right = question.slice(m.index + m[0].length).trim();
  if (!/^[\u4e00-\u9fff]{2,8}$/.test(left) || right.length < 2) return [];
  const tail = right.slice(Math.min(left.length, right.length - 1));
  const leftQuery = `${left}${tail}`;
  return leftQuery === right ? [right] : [leftQuery, right];
}

/** 英文/数字标识符：长度 ≥3，或两位全大写/数字（如 AI、5090 的前两位不单独算）。 */
function identifierTokens(question: string): string[] {
  return (question.match(/[A-Za-z0-9_]{2,}/g) ?? [])
    .filter((w) => w.length >= 3 || /^[A-Z0-9]{2}$/.test(w))
    .map((w) => w.toLowerCase());
}

/** 问句与条目共有的最长中文片段长度（只看连续汉字）。 */
function longestCjkOverlap(question: string, statement: string): number {
  let best = 0;
  for (const run of question.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let len = Math.min(run.length, 12); len > best; len--) {
      let found = false;
      for (let i = 0; i + len <= run.length; i++) {
        if (statement.includes(run.slice(i, i + len))) {
          found = true;
          break;
        }
      }
      if (found) {
        best = len;
        break;
      }
    }
  }
  return best;
}

/** 本地日历日（YYYY-MM-DD）。不能用 toISOString：那是 UTC，晚上会差一天。 */
export function localDay(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 注入引擎的记忆段。
 *
 * 每条都带「记于」日期，段首写明今天是哪天：2026-09-18 真机反馈——7 月的门店开业
 * 筹备被当成「当前核心主线」答了出来。条目本身不带任何时间，类型又是 goal，
 * 模型只能当成现在的目标（Hermes 系统提示里有今天的日期，但没有记忆的日期，
 * 两个时间对不上就无从判断）。
 * 「记于」是把这条记下来的日子（多为导入分析那天），不是事情发生的日子——
 * 标注必须说清楚，否则模型会把记录日期当成事件日期，错得更离谱。
 */
function buildPromptBlock(selected: Array<SelectedMemoryItem & { state: string }>): string {
  if (selected.length === 0) return '';
  const lines = selected.map((item) => {
    const originTag = item.origin === 'user' ? '用户指定' : '系统推断';
    const stateTag = item.state === 'disputed' ? ' · disputed/争议未定' : '';
    const day = localDay(item.recordedAt);
    const dateTag = day ? ` · 记于 ${day}` : '';
    return `- [${item.type} · ${originTag}${stateTag}${dateTag}] ${item.statement}`;
  });
  const header =
    `IXAEON 记忆上下文（今天 ${localDay(new Date())}；` +
    `「记于」是 IXAEON 记下这条的日期，不是事情发生的日期，` +
    `早先记的事可能已经过去或不再成立）：`;
  return `\n\n（${header}\n${lines.join('\n')}\n）`;
}
