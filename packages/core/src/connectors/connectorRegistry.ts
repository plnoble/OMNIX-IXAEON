import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

export type ConnectorPlatform =
  | 'chatgpt_web'
  | 'chatgpt_export'
  | 'claude_export'
  | 'gemini_export'
  | 'grok_export'
  | 'local_file';

export type CaptureMethod = 'history_export' | 'live_capture' | 'local_file';

export interface ConnectorRecord {
  id: string;
  platform: ConnectorPlatform;
  account_namespace: string;
  capture_method: CaptureMethod;
  sync_cursor: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  last_success_at: string | null;
  last_failure_reason: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ConnectorRow {
  id: string;
  platform: string;
  account_namespace: string;
  capture_method: string;
  sync_cursor: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  last_success_at: string | null;
  last_failure_reason: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * P3-A 连接器注册表（迁移 25）：
 * 从「支持导入」变成「知道接入到哪里」。
 * - 每个连接器（平台 × 账号命名空间 × 采集方式）一行；
 * - 同步成功推进游标与覆盖区间；失败记录原因，不覆盖成功历史；
 * - 撤销后记录 revoked_at，后续同步检查立即拒绝；
 * - 同一 (platform, namespace, method) 幂等复用（不重复登记）。
 */
export class ConnectorRegistry {
  constructor(private readonly db: CoreDatabase) {}

  private rowToRecord(row: ConnectorRow): ConnectorRecord {
    return {
      id: row.id,
      platform: row.platform as ConnectorPlatform,
      account_namespace: row.account_namespace,
      capture_method: row.capture_method as CaptureMethod,
      sync_cursor: row.sync_cursor,
      coverage_start: row.coverage_start,
      coverage_end: row.coverage_end,
      last_success_at: row.last_success_at,
      last_failure_reason: row.last_failure_reason,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** 登记或取回连接器（幂等）。 */
  upsert(input: {
    platform: ConnectorPlatform;
    accountNamespace?: string;
    captureMethod: CaptureMethod;
  }): ConnectorRecord {
    const namespace = input.accountNamespace ?? 'local';
    const existing = this.db
      .prepare(
        'SELECT * FROM connectors WHERE platform = ? AND account_namespace = ? AND capture_method = ?',
      )
      .get(input.platform, namespace, input.captureMethod) as ConnectorRow | undefined;
    if (existing) return this.rowToRecord(existing);

    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO connectors (id, platform, account_namespace, capture_method, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.platform, namespace, input.captureMethod, now, now);
    return this.rowToRecord(
      this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow,
    );
  }

  get(id: string): ConnectorRecord {
    const row = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as
      ConnectorRow | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `连接器不存在: ${id}`);
    return this.rowToRecord(row);
  }

  list(): ConnectorRecord[] {
    return (
      this.db.prepare('SELECT * FROM connectors ORDER BY created_at').all() as ConnectorRow[]
    ).map((r) => this.rowToRecord(r));
  }

  /** 同步前检查：撤销后拒绝新同步。 */
  assertActive(id: string): void {
    const rec = this.get(id);
    if (rec.revoked_at) {
      throw new IxaError(
        ErrorCodes.PERMISSION_REVOKED,
        `该连接器已于 ${rec.revoked_at} 撤销，拒绝新同步`,
      );
    }
  }

  /** 记录一次成功同步：推进游标与覆盖区间（单调扩展，不回退）。 */
  recordSuccess(
    id: string,
    info: { cursor?: string; coverageStart?: string; coverageEnd?: string },
  ): ConnectorRecord {
    this.assertActive(id);
    const rec = this.get(id);
    const now = new Date().toISOString();
    const coverageStart =
      info.coverageStart && (!rec.coverage_start || info.coverageStart < rec.coverage_start)
        ? info.coverageStart
        : rec.coverage_start;
    const coverageEnd =
      info.coverageEnd && (!rec.coverage_end || info.coverageEnd > rec.coverage_end)
        ? info.coverageEnd
        : rec.coverage_end;
    this.db
      .prepare(
        `UPDATE connectors SET sync_cursor = ?, coverage_start = ?, coverage_end = ?,
           last_success_at = ?, last_failure_reason = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(info.cursor ?? rec.sync_cursor, coverageStart, coverageEnd, now, now, id);
    return this.get(id);
  }

  /** 记录一次失败：保留最后成功历史（不被失败覆盖）。 */
  recordFailure(id: string, reason: string): ConnectorRecord {
    const now = new Date().toISOString();
    const info = this.db
      .prepare('UPDATE connectors SET last_failure_reason = ?, updated_at = ? WHERE id = ?')
      .run(reason.slice(0, 500), now, id);
    if (info.changes === 0) throw new IxaError(ErrorCodes.NOT_FOUND, `连接器不存在: ${id}`);
    return this.get(id);
  }

  /** 撤销连接器（不再允许新同步；历史保留）。 */
  revoke(id: string): ConnectorRecord {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        'UPDATE connectors SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(now, now, id);
    if (info.changes === 0) {
      // 已撤销或不存在：已撤销幂等返回，不存在报错
      this.get(id);
    }
    return this.get(id);
  }
}
