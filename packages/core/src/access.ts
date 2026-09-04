import type { CoreDatabase } from './db/database.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

/**
 * 撤销授权后的统一读取边界。
 *
 * 规则（修复 P1-5）：一个来源的授权被撤销后，所有读取入口行为一致——
 * 桌面原文阅读、全文搜索、问答、MCP 摘录（segment_id 与 item_id 两条路径）、
 * 重新提取，一律拒绝暴露原文。派生结论（items）是否保留由用户另行决定，
 * 不在读取路径上自动清理。
 */
export function isSourceAuthorized(db: CoreDatabase, sourceId: string): boolean {
  const row = db
    .prepare(
      `SELECT p.status AS status
       FROM sources s JOIN permissions p ON p.id = s.permission_id
       WHERE s.id = ?`,
    )
    .get(sourceId) as { status: string | null } | undefined;
  return row?.status === 'active';
}

/** 断言来源授权仍有效，否则抛 PERMISSION_REVOKED。 */
export function assertSourceAuthorized(db: CoreDatabase, sourceId: string): void {
  if (!isSourceAuthorized(db, sourceId)) {
    throw new IxaError(
      ErrorCodes.PERMISSION_REVOKED,
      '该来源的读取授权已被用户撤销，无法读取原文（可在来源页重新授权或删除）',
    );
  }
}

/** 片段所属来源（找不到时抛 INVALID_REFERENCE）。 */
export function segmentSourceId(db: CoreDatabase, segmentId: string): string {
  const row = db.prepare('SELECT source_id FROM segments WHERE id = ?').get(segmentId) as
    { source_id: string } | undefined;
  if (!row) {
    throw new IxaError(ErrorCodes.INVALID_REFERENCE, `片段不存在: ${segmentId}`);
  }
  return row.source_id;
}

/** 片段可读 = 存在且其来源授权有效。返回 source_id。 */
export function assertSegmentAuthorized(db: CoreDatabase, segmentId: string): string {
  const sourceId = segmentSourceId(db, segmentId);
  assertSourceAuthorized(db, sourceId);
  return sourceId;
}

/**
 * 项目隔离规则（修复 P1-4，问答 / prepare_task / search_context 共用）：
 * - 指定 projectId：只返回明确属于该项目的来源片段（project_id 严格相等）；
 *   project_id IS NULL（未分配）绝不混入项目上下文。
 * - 全局（projectId=null）：返回全部（含未分配），已撤销授权来源除外。
 * 该规则记录于 docs/privacy-model.md「项目隔离与全局检索」。
 */
export const PROJECT_ISOLATION_RULE =
  '指定项目时仅返回明确归属该项目的资料；未分配资料只在全局检索中出现，不自动混入项目上下文。';
