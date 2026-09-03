import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from './db/database.js';
import type { AuditEvent } from '@ixaeon/contracts';

/** 记录审计事件（授权变更、删除、恢复、导出等敏感操作）。 */
export function recordAudit(db: CoreDatabase, kind: string, detail: Record<string, unknown>): void {
  db.prepare(
    'INSERT INTO audit_events (id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)',
  ).run(randomUUID(), kind, JSON.stringify(detail), new Date().toISOString());
}

export function listAuditEvents(db: CoreDatabase, limit = 100): AuditEvent[] {
  return db
    .prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AuditEvent[];
}
