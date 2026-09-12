import type { CoreDatabase } from './db/database.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { MemoryScope } from '@ixaeon/contracts';

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

export type DisclosureAudience = 'coding_client' | 'model' | 'research';

/**
 * S1：编码客户端默认只能看到已允许共享的项目背景。
 * personal / unassigned 必须有未过期、未撤销的 disclosure_grants，
 * 旧 localToken 不自动解锁新增个人资料。
 */
export function isItemDisclosedTo(
  db: CoreDatabase,
  itemId: string,
  audience: DisclosureAudience,
): boolean {
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM disclosure_grants
       WHERE item_id = ? AND audience = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
    )
    .get(itemId, audience, now) as { ok: number } | undefined;
  return row !== undefined;
}

/** 条目当前范围（缺列时按 project_id 回退，供迁移前诊断）。 */
export function itemScope(db: CoreDatabase, itemId: string): MemoryScope | null {
  const row = db.prepare('SELECT scope, project_id FROM items WHERE id = ?').get(itemId) as
    { scope: MemoryScope; project_id: string | null } | undefined;
  if (!row) return null;
  if (row.scope === 'personal' || row.scope === 'project' || row.scope === 'unassigned') {
    return row.scope;
  }
  return row.project_id ? 'project' : 'unassigned';
}

/**
 * 编码客户端是否可读该条目（不含原文授权检查）。
 * project 范围默认可见；personal/unassigned 需有效分享。
 */
export function codingClientMayReadItem(db: CoreDatabase, itemId: string): boolean {
  const scope = itemScope(db, itemId);
  if (scope === null) return false;
  if (scope === 'project') return true;
  return isItemDisclosedTo(db, itemId, 'coding_client');
}

/** 模型外发：project 默认可发；personal/unassigned 需有效 model 分享。 */
export function modelMayReadItem(db: CoreDatabase, itemId: string): boolean {
  const scope = itemScope(db, itemId);
  if (scope === null) return false;
  if (scope === 'project') return true;
  const row = db.prepare('SELECT origin, type, rationale FROM items WHERE id = ?').get(itemId) as
    { origin: string; type: string; rationale: string | null } | undefined;
  // 归档短经验：过往工作仍可被问答引用，不是未分享的个人隐私条目。
  if (
    row?.origin === 'ai' &&
    row.type === 'project_summary' &&
    (row.rationale ?? '').includes('归档经验摘要')
  ) {
    return true;
  }
  return isItemDisclosedTo(db, itemId, 'model');
}

/** 片段若支撑个人/未整理条目，编码客户端须有对应分享。 */
export function codingClientMayReadSegment(db: CoreDatabase, segmentId: string): boolean {
  const rows = db
    .prepare(
      `SELECT DISTINCT i.id AS item_id
       FROM items i
       LEFT JOIN item_evidence e ON e.item_id = i.id
       JOIN segments s ON s.id = ?
       WHERE e.segment_id = ? OR i.extracted_from_source_id = s.source_id`,
    )
    .all(segmentId, segmentId) as Array<{ item_id: string }>;
  for (const row of rows) {
    if (!codingClientMayReadItem(db, row.item_id)) return false;
  }
  return true;
}

export function assertCodingClientMayReadSegment(db: CoreDatabase, segmentId: string): void {
  if (!codingClientMayReadSegment(db, segmentId)) {
    throw new IxaError(
      ErrorCodes.SCOPE_DENIED,
      '该原文属于个人或未整理资料，未获准分享给编码客户端',
    );
  }
}

/** 断言编码客户端可读该条目，否则 SCOPE_DENIED。 */
export function assertCodingClientMayReadItem(db: CoreDatabase, itemId: string): void {
  if (!codingClientMayReadItem(db, itemId)) {
    throw new IxaError(
      ErrorCodes.SCOPE_DENIED,
      '该条目属于个人或未整理资料，未获准分享给编码客户端',
    );
  }
}
