import type { CoreDatabase } from '../db/database.js';
import {
  ErrorCodes,
  IxaError,
  type Item,
  type Correction,
  type ItemEvidenceView,
  type ItemLink,
  type DisclosureGrant,
  type MemoryScope,
} from '@ixaeon/contracts';
import { assertSourceAuthorized } from '../access.js';
import {
  addNeedsReason,
  clearNeedsReasons,
  syncDerivedNeedsReasons,
  setNeedsReasons,
  getNeedsReasons,
} from './needsReview.js';

/** row → camelCase。 */
function toItem(row: Record<string, unknown>): Item {
  return {
    id: row['id'] as string,
    project_id: (row['project_id'] as string | null) ?? null,
    scope: ((row['scope'] as MemoryScope | undefined) ??
      (row['project_id'] ? 'project' : 'unassigned')) as MemoryScope,
    type: row['type'] as Item['type'],
    statement: row['statement'] as string,
    rationale: (row['rationale'] as string | null) ?? null,
    state: row['state'] as Item['state'],
    confidence: row['confidence'] as number,
    origin: row['origin'] as Item['origin'],
    observed_at: (row['observed_at'] as string | null) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    supersedes_item_id: (row['supersedes_item_id'] as string | null) ?? null,
    extracted_from_source_id: (row['extracted_from_source_id'] as string | null) ?? null,
    prompt_version: (row['prompt_version'] as string | null) ?? null,
    model_name: (row['model_name'] as string | null) ?? null,
    needs_review: (row['needs_review'] as number) === 1,
    shelved_at: (row['shelved_at'] as string | null) ?? null,
    confirmation: (row['confirmation'] as Item['confirmation']) ?? 'none',
    confirmation_at: (row['confirmation_at'] as string | null) ?? null,
    manual_project: (row['manual_project'] as number) === 1,
  };
}

/**
 * 条目与纠正服务（计划 4.7：纠正必须在单个事务中完成，
 * 旧项 superseded、新项 origin=user、双向可追溯）。
 */
export class ItemService {
  constructor(private readonly db: CoreDatabase) {}

  list(filter: {
    projectId: string | null;
    state?: 'current' | 'disputed' | 'superseded';
    needsReview?: boolean;
    shelved?: boolean;
    type?: string;
    limit?: number;
    /** N01：排除已被替代的历史条目（Inbox 可处理范围） */
    excludeSuperseded?: boolean;
    /** S1：按语义范围过滤；不传则不过滤 */
    scope?: MemoryScope;
  }): Item[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId !== null) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.scope) {
      where.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter.state) {
      where.push('state = ?');
      args.push(filter.state);
    }
    if (filter.excludeSuperseded) {
      where.push("state != 'superseded'");
    }
    if (filter.needsReview !== undefined) {
      where.push('needs_review = ?');
      args.push(filter.needsReview ? 1 : 0);
    }
    if (filter.shelved !== undefined) {
      where.push(filter.shelved ? 'shelved_at IS NOT NULL' : 'shelved_at IS NULL');
    }
    if (filter.type) {
      where.push('type = ?');
      args.push(filter.type);
    }
    const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY updated_at DESC LIMIT ?`;
    args.push(filter.limit ?? 500);
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(toItem);
  }

  get(itemId: string): Item {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `条目不存在: ${itemId}`);
    return toItem(row as Record<string, unknown>);
  }

  /**
   * 依据列表（含片段与来源标题，供界面展开核验）。
   * 修复 R3a：每个返回原文的出口都做授权检查 —— 撤销授权后不返回片段正文
   * 与引用摘录（整体拒绝，与阅读/搜索/问答/MCP 行为一致）。
   */
  getEvidence(itemId: string): ItemEvidenceView[] {
    const rows = this.db
      .prepare(
        `SELECT e.segment_id, e.excerpt, e.relevance, s.id AS seg_id, s.source_id,
                s.sequence, s.role, s.text AS seg_text, src.title AS source_title
         FROM item_evidence e
         JOIN segments s ON s.id = e.segment_id
         JOIN sources src ON src.id = s.source_id
         WHERE e.item_id = ?`,
      )
      .all(itemId) as Record<string, unknown>[];
    if (rows.length === 0) return [];
    const viewed = new Set<string>();
    for (const row of rows) {
      const sourceId = row['source_id'] as string;
      if (viewed.has(sourceId)) continue;
      viewed.add(sourceId);
      assertSourceAuthorized(this.db, sourceId);
    }
    return rows.map((row) => ({
      segment_id: row['segment_id'] as string,
      excerpt: row['excerpt'] as string,
      relevance: row['relevance'] as number,
      segment: {
        id: row['seg_id'] as string,
        source_id: row['source_id'] as string,
        sequence: row['sequence'] as number,
        role: row['role'] as string,
        text: row['seg_text'] as string,
      },
      sourceTitle: row['source_title'] as string,
    }));
  }

  /**
   * 用户纠正（计划 5.5）：事务内 ——
   * 旧项 state=superseded；新项 origin=user、supersedes_item_id 指向旧项；
   * corrections 记录 user_text 与双向 ID；旧依据保留。
   */
  correct(input: {
    itemId: string;
    userText: string;
    newType?: Item['type'];
    projectId?: string | null;
  }): { oldItem: Item; newItem: Item; correction: Correction } {
    if (input.userText.trim().length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '纠正内容不能为空');
    }
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const correctionId = crypto.randomUUID();

    const tx = this.db.transaction(() => {
      const oldRow = this.db.prepare('SELECT * FROM items WHERE id = ?').get(input.itemId);
      if (!oldRow) throw new IxaError(ErrorCodes.NOT_FOUND, `条目不存在: ${input.itemId}`);
      const old = toItem(oldRow as Record<string, unknown>);

      this.db
        .prepare(`UPDATE items SET state = 'superseded', updated_at = ? WHERE id = ?`)
        .run(now, input.itemId);
      // N01：被替代的旧条目退出待处理 —— 纠正是用户动作，旧内容已由新结论
      // 替代，全部待处理原因（unconfirmed/conflict/manual/no_project）一并
      // 清空。旧条目、纠正链与依据保留，仅退出操作队列。
      clearNeedsReasons(this.db, input.itemId);

      const nextProjectId = input.projectId !== undefined ? input.projectId : old.project_id;
      const nextScope: MemoryScope =
        nextProjectId !== null ? 'project' : old.scope === 'personal' ? 'personal' : old.scope;
      this.db
        .prepare(
          `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
             origin, observed_at, created_at, updated_at, supersedes_item_id,
             prompt_version, model_name, needs_review)
           VALUES (?, ?, ?, ?, ?, NULL, 'current', 1.0, 'user', ?, ?, ?, ?, NULL, NULL, 0)`,
        )
        .run(
          newId,
          nextProjectId,
          nextScope,
          input.newType ?? old.type,
          input.userText.trim(),
          now,
          now,
          now,
          input.itemId,
        );

      this.db
        .prepare(
          `INSERT INTO corrections (id, old_item_id, user_text, new_item_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(correctionId, input.itemId, input.userText.trim(), newId, now);
      // S3：纠正后旧关系不再当确定事实
      this.db
        .prepare(
          `UPDATE project_relations SET stale = 1, updated_at = ?
           WHERE stale = 0 AND status != 'superseded'
             AND evidence_json LIKE ?`,
        )
        .run(now, `%"itemId":"${input.itemId}"%`);
    });
    tx();

    return {
      oldItem: this.get(input.itemId),
      newItem: this.get(newId),
      correction: {
        id: correctionId,
        old_item_id: input.itemId,
        user_text: input.userText.trim(),
        new_item_id: newId,
        created_at: now,
      },
    };
  }

  /** 纠正预览（不改数据）。 */
  previewCorrection(
    itemId: string,
    userText: string,
  ): {
    oldStatement: string;
    newStatement: string;
    type: Item['type'];
  } {
    const old = this.get(itemId);
    return { oldStatement: old.statement, newStatement: userText.trim(), type: old.type };
  }

  /** 改口历史（项目内全部纠正，含新旧条目）。 */
  listCorrections(projectId: string | null): Array<Correction & { oldItem: Item; newItem: Item }> {
    const rows = projectId
      ? this.db
          .prepare(
            `SELECT c.* FROM corrections c
             JOIN items i ON i.id = c.new_item_id WHERE i.project_id = ?
             ORDER BY c.created_at DESC`,
          )
          .all(projectId)
      : this.db.prepare('SELECT * FROM corrections ORDER BY created_at DESC').all();
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: row['id'] as string,
      old_item_id: row['old_item_id'] as string,
      user_text: row['user_text'] as string,
      new_item_id: row['new_item_id'] as string,
      created_at: row['created_at'] as string,
      oldItem: this.get(row['old_item_id'] as string),
      newItem: this.get(row['new_item_id'] as string),
    }));
  }

  /**
   * M2 确认：用户确认该 AI 理解正确（不改变 origin —— 不篡改为「用户写的」）。
   * 同时清除待讨论标记。
   */
  confirm(itemId: string): Item {
    const item = this.get(itemId);
    if (item.state === 'superseded') {
      throw new IxaError(ErrorCodes.CONFLICT, '该条目已被替代，不能确认');
    }
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE items SET confirmation = 'confirmed', confirmation_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, itemId);
      // F01：确认是用户动作 → 清空全部待处理原因（含冲突/显式要求）
      clearNeedsReasons(this.db, itemId);
    });
    tx();
    return this.get(itemId);
  }

  /**
   * M2 不采纳：用户明确不采纳该建议 —— 不是「确认正确」，条目保留可追溯，
   * 但从简报/问答/检索的当前理解中排除。
   */
  reject(itemId: string): Item {
    const item = this.get(itemId);
    if (item.state === 'superseded') {
      throw new IxaError(ErrorCodes.CONFLICT, '该条目已被替代，无需不采纳');
    }
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE items SET confirmation = 'rejected', confirmation_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, itemId);
      // F01：不采纳是用户动作 → 清空全部待处理原因
      clearNeedsReasons(this.db, itemId);
    });
    tx();
    return this.get(itemId);
  }

  /**
   * F01：显式置位/解除待处理。true → 加 manual 原因（用户显式要求，
   * 只有再次显式解除或确认/不采纳能清掉）；false → 明确解除 —— 清掉
   * manual 原因，再按当前事实重算派生原因（缺项目/未确认等仍在则保留）。
   */
  setPendingReview(itemId: string, needsReview: boolean): Item {
    if (needsReview) {
      addNeedsReason(this.db, itemId, 'manual');
    } else {
      const current = getNeedsReasons(this.db, itemId);
      current.delete('manual');
      setNeedsReasons(this.db, itemId, current);
      syncDerivedNeedsReasons(this.db, itemId);
    }
    return this.get(itemId);
  }

  shelve(itemId: string, shelved: boolean): Item {
    this.db
      .prepare('UPDATE items SET shelved_at = ?, updated_at = ? WHERE id = ?')
      .run(shelved ? new Date().toISOString() : null, new Date().toISOString(), itemId);
    return this.get(itemId);
  }

  assignToProject(itemId: string, projectId: string): Item {
    const proj = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!proj) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${projectId}`);
    // G5：人工单独归属 —— 标记后来源级批量重绑不再搬动该条目。
    // C04/A03/F01：选项目不是确认结论 —— 只解决「缺项目」这一个待处理原因；
    // 未确认 / 冲突 / 用户显式要求等原因原样保留（集中规则见 needsReview.ts）。
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE items SET project_id = ?, scope = 'project', manual_project = 1, updated_at = ? WHERE id = ?",
        )
        .run(projectId, new Date().toISOString(), itemId);
      syncDerivedNeedsReasons(this.db, itemId);
    });
    tx();
    return this.get(itemId);
  }

  /**
   * S1：显式校正语义范围。标为 personal 只消除 no_project（sync 派生原因），
   * 不清除 manual / conflict / unconfirmed，不复活 superseded。
   */
  setScope(itemId: string, scope: MemoryScope): Item {
    const item = this.get(itemId);
    if (item.state === 'superseded') {
      throw new IxaError(ErrorCodes.CONFLICT, '该条目已被替代，不能改变范围');
    }
    if (scope === 'project' && item.project_id === null) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '标为项目范围前请先归属到具体项目');
    }
    const tx = this.db.transaction(() => {
      // personal / unassigned 解除项目所有者；project 保留已有 project_id。
      const projectId = scope === 'project' ? item.project_id : null;
      this.db
        .prepare(
          'UPDATE items SET scope = ?, project_id = ?, manual_project = CASE WHEN ? = 1 THEN 1 ELSE manual_project END, updated_at = ? WHERE id = ?',
        )
        .run(scope, projectId, scope === 'personal' ? 1 : 0, new Date().toISOString(), itemId);
      syncDerivedNeedsReasons(this.db, itemId);
    });
    tx();
    return this.get(itemId);
  }

  listLinks(itemId: string): ItemLink[] {
    this.get(itemId);
    return this.db
      .prepare('SELECT * FROM item_links WHERE item_id = ? ORDER BY created_at')
      .all(itemId) as ItemLink[];
  }

  addLink(input: { itemId: string; kind: ItemLink['kind']; targetId: string }): ItemLink {
    this.get(input.itemId);
    if (input.kind === 'project') {
      const proj = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(input.targetId);
      if (!proj) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${input.targetId}`);
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      this.db
        .prepare(
          'INSERT INTO item_links (id, item_id, kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.itemId, input.kind, input.targetId, now);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) {
        throw new IxaError(ErrorCodes.CONFLICT, '该关联已存在');
      }
      throw err;
    }
    return this.db.prepare('SELECT * FROM item_links WHERE id = ?').get(id) as ItemLink;
  }

  removeLink(linkId: string): { ok: true } {
    const info = this.db.prepare('DELETE FROM item_links WHERE id = ?').run(linkId);
    if (info.changes === 0) throw new IxaError(ErrorCodes.NOT_FOUND, `关联不存在: ${linkId}`);
    return { ok: true };
  }

  grantDisclosure(input: {
    itemId: string;
    audience: DisclosureGrant['audience'];
    expiresAt?: string | null;
    note?: string | null;
  }): DisclosureGrant {
    this.get(input.itemId);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO disclosure_grants (id, item_id, audience, granted_at, expires_at, revoked_at, note)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, input.itemId, input.audience, now, input.expiresAt ?? null, input.note ?? null);
    return this.db
      .prepare('SELECT * FROM disclosure_grants WHERE id = ?')
      .get(id) as DisclosureGrant;
  }

  revokeDisclosure(grantId: string): { ok: true } {
    const now = new Date().toISOString();
    const info = this.db
      .prepare('UPDATE disclosure_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, grantId);
    if (info.changes === 0) {
      throw new IxaError(ErrorCodes.NOT_FOUND, `分享授权不存在或已撤销: ${grantId}`);
    }
    return { ok: true };
  }

  /**
   * F01：按当前事实重算派生原因并保留持久原因 —— 与来源绑定入口
   * （SourceStore.bindProject）真正共用同一函数，不再是两套规则。
   */
  recomputeNeedsReview(itemId: string): void {
    syncDerivedNeedsReasons(this.db, itemId);
  }

  /** 助手建议：origin=assistant_suggestion，不自动确认，不能冒充用户目标。 */
  createAssistantSuggestion(input: {
    projectId: string | null;
    type: Item['type'];
    statement: string;
    rationale: string | null;
    scope?: MemoryScope;
  }): Item {
    if (input.type === 'goal' || input.type === 'preference') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '助手建议不能直接写成用户目标或偏好，请用 open_loop 等待用户确认',
      );
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const scope: MemoryScope = input.scope ?? (input.projectId !== null ? 'project' : 'unassigned');
    const projectId = scope === 'project' ? input.projectId : null;
    this.db
      .prepare(
        `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
           origin, observed_at, created_at, updated_at, needs_review, needs_reasons)
         VALUES (?, ?, ?, ?, ?, ?, 'current', 0.5, 'assistant_suggestion', ?, ?, ?, 1, 'unconfirmed')`,
      )
      .run(id, projectId, scope, input.type, input.statement, input.rationale, now, now, now);
    return this.get(id);
  }

  /** 手工条目（origin=user，无依据）。 */
  createManual(input: {
    projectId: string | null;
    type: Item['type'];
    statement: string;
    rationale: string | null;
    scope?: MemoryScope;
  }): Item {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const scope: MemoryScope = input.scope ?? (input.projectId !== null ? 'project' : 'unassigned');
    if (scope === 'project' && input.projectId === null) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '项目范围条目必须指定项目');
    }
    const projectId = scope === 'project' ? input.projectId : null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
             origin, observed_at, created_at, updated_at, needs_review)
           VALUES (?, ?, ?, ?, ?, ?, 'current', 1.0, 'user', ?, ?, ?, 0)`,
        )
        .run(id, projectId, scope, input.type, input.statement, input.rationale, now, now, now);
      syncDerivedNeedsReasons(this.db, id);
    });
    tx();
    return this.get(id);
  }
}
