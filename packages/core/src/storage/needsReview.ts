import type { CoreDatabase } from '../db/database.js';

/**
 * F01/RF03：待处理原因集合 —— 单一事实来源，两个归属入口共用。
 *
 * needs_review 不再被任何入口整体覆写：它是 needs_reasons 的物化视图
 * （非空 = 待处理）。每个操作只增删自己负责的原因：
 *
 * - no_project   派生：条目没有归属项目（等待归属）。选项目/来源绑定
 *                只解决这一个原因 —— 这是 F01 的核心要求。
 * - unconfirmed  派生：重要 AI 决定类（decision/rejected_option/
 *                project_summary）尚未确认；agent 自报 open_loop 候选
 *                （origin=work_result）同样待用户确认。
 * - conflict     持久：与人工决定相似（提取器判定）或双方 disputed
 *                （markDisputed）。只能被用户动作（确认/不采纳/纠正/
 *                明确解除）清掉，绝不被归属操作清掉。
 * - manual       持久：用户显式要求继续待处理（setPendingReview(true)）。
 *
 * 派生原因随事实重算；持久原因只有用户动作能清除。
 */
export type NeedsReason = 'no_project' | 'unconfirmed' | 'conflict' | 'manual';

/** 持久原因（sync 不触碰）。 */
const PERSISTENT: ReadonlySet<NeedsReason> = new Set<NeedsReason>(['conflict', 'manual']);

/** 派生原因计算所需的最小事实。 */
export interface NeedsReviewFacts {
  project_id: string | null;
  type: string;
  origin: string;
  state: string;
  confirmation: string;
}

/** 按当前事实计算派生原因（不含 manual / conflict）。 */
export function derivedNeedsReasons(facts: NeedsReviewFacts): Set<NeedsReason> {
  const out = new Set<NeedsReason>();
  if (facts.project_id === null) out.add('no_project');
  const importantAi =
    facts.origin === 'ai' &&
    facts.state === 'current' &&
    facts.confirmation === 'none' &&
    (facts.type === 'decision' ||
      facts.type === 'rejected_option' ||
      facts.type === 'project_summary');
  // agent 自报的 open_loop 候选永远需要用户确认（不是用户决定）
  const workCandidate =
    facts.origin === 'work_result' && facts.state === 'current' && facts.confirmation === 'none';
  if (importantAi || workCandidate) out.add('unconfirmed');
  return out;
}

function parse(raw: string): Set<NeedsReason> {
  const out = new Set<NeedsReason>();
  for (const part of raw.split(',')) {
    if (
      part === 'no_project' ||
      part === 'unconfirmed' ||
      part === 'conflict' ||
      part === 'manual'
    ) {
      out.add(part);
    }
  }
  return out;
}

function serialize(reasons: Set<NeedsReason>): string {
  return [...reasons].join(',');
}

function factsOf(db: CoreDatabase, itemId: string): NeedsReviewFacts | undefined {
  const row = db
    .prepare(`SELECT project_id, type, origin, state, confirmation FROM items WHERE id = ?`)
    .get(itemId) as NeedsReviewFacts | undefined;
  return row ?? undefined;
}

/** 读当前原因集合。 */
export function getNeedsReasons(db: CoreDatabase, itemId: string): Set<NeedsReason> {
  const row = db.prepare('SELECT needs_reasons FROM items WHERE id = ?').get(itemId) as
    { needs_reasons: string } | undefined;
  return parse(row?.needs_reasons ?? '');
}

/** 写原因集合并同步物化标记（单一写入口）。 */
export function setNeedsReasons(db: CoreDatabase, itemId: string, reasons: Set<NeedsReason>): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE items SET needs_reasons = ?, needs_review = ?, updated_at = ? WHERE id = ?',
  ).run(serialize(reasons), reasons.size > 0 ? 1 : 0, now, itemId);
}

/** 增加一个原因（幂等）。 */
export function addNeedsReason(db: CoreDatabase, itemId: string, reason: NeedsReason): void {
  const current = getNeedsReasons(db, itemId);
  if (current.has(reason)) return;
  current.add(reason);
  setNeedsReasons(db, itemId, current);
}

/** 移除一个原因（幂等）。 */
export function removeNeedsReason(db: CoreDatabase, itemId: string, reason: NeedsReason): void {
  const current = getNeedsReasons(db, itemId);
  if (!current.has(reason)) return;
  current.delete(reason);
  setNeedsReasons(db, itemId, current);
}

/**
 * 按当前事实重算派生原因（no_project / unconfirmed），完整保留持久原因
 * （conflict / manual）。归属入口（assignToProject / bindProject）只调用
 * 这个 —— 选项目解决「缺项目」，绝不顺带抹掉冲突或用户的显式要求。
 */
export function syncDerivedNeedsReasons(db: CoreDatabase, itemId: string): void {
  const facts = factsOf(db, itemId);
  if (!facts) return;
  const current = getNeedsReasons(db, itemId);
  const next = new Set<NeedsReason>(derivedNeedsReasons(facts));
  for (const reason of PERSISTENT) if (current.has(reason)) next.add(reason);
  setNeedsReasons(db, itemId, next);
}

/** 清空全部原因（明确解除 / 确认 / 不采纳 / 被纠正替代）。 */
export function clearNeedsReasons(db: CoreDatabase, itemId: string): void {
  setNeedsReasons(db, itemId, new Set<NeedsReason>());
}
