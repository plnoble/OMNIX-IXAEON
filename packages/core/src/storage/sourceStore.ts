import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import type { Permission, Project, Segment, Source } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { sha256 } from '../vault.js';
import { assertSourceAuthorized } from '../access.js';
import type { ParsedSource } from '../import/parsers.js';

export interface SourceWithStats {
  source: Source;
  permissionStatus: Permission['status'];
  segmentCount: number;
  itemCount: number;
}

/** 来源与片段存储。所有写入都在事务中：要么完整入库，要么回滚不留半套数据。 */
export class SourceStore {
  constructor(private readonly db: CoreDatabase) {}

  /**
   * 按 (provider, external_id, content_hash) 查找已有来源（幂等去重键）。
   */
  findExisting(provider: string, externalId: string, contentHash: string): Source | null {
    const row = this.db
      .prepare('SELECT * FROM sources WHERE provider = ? AND external_id = ? AND content_hash = ?')
      .get(provider, externalId, contentHash) as Source | undefined;
    return row ?? null;
  }

  /** 解析结果入库（事务：source + segments + FTS 一起成功或一起回滚）。 */
  insertParsed(
    parsed: ParsedSource,
    opts: { permissionId: string; projectId: string | null; rawPath: string },
  ): Source {
    const now = new Date().toISOString();
    const sourceId = randomUUID();
    const insertSource = this.db.prepare(
      `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
        captured_at, imported_at, permission_id, project_id, metadata_json, content_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const insertSegment = this.db.prepare(
      `INSERT INTO segments (id, source_id, sequence, role, external_node_id, external_parent_id,
        is_active_branch, occurred_at, text, content_hash, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      insertSource.run(
        sourceId,
        parsed.kind,
        parsed.provider,
        parsed.externalId,
        parsed.title,
        parsed.contentHash,
        opts.rawPath,
        parsed.capturedAt,
        now,
        opts.permissionId,
        opts.projectId,
        JSON.stringify(parsed.metadata),
      );
      for (const seg of parsed.segments) {
        insertSegment.run(
          randomUUID(),
          sourceId,
          seg.sequence,
          seg.role,
          seg.externalNodeId,
          seg.externalParentId,
          seg.isActiveBranch ? 1 : 0,
          seg.occurredAt,
          seg.text,
          sha256(seg.text),
          JSON.stringify(seg.metadata),
        );
      }
    });
    try {
      tx();
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed: sources.provider')) {
        // 并发下重复导入：视为已存在
        const existing = this.findExisting(parsed.provider, parsed.externalId, parsed.contentHash);
        if (existing) return existing;
      }
      throw err;
    }
    return this.get(sourceId) as Source;
  }

  get(id: string): Source | null {
    const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Source | undefined;
    return row ?? null;
  }

  /**
   * 撤销授权后的读取边界（修复 P1-5）：授权已撤销的来源不返回原文。
   * 列表（含状态展示）仍可见；读取片段 / 上下文 / 搜索 / 问答 / MCP 均拒绝。
   */
  getSegments(
    sourceId: string,
    offset: number,
    limit: number,
  ): { segments: Segment[]; total: number } {
    assertSourceAuthorized(this.db, sourceId);
    const total = (
      this.db.prepare('SELECT count(*) AS c FROM segments WHERE source_id = ?').get(sourceId) as {
        c: number;
      }
    ).c;
    const segments = this.db
      .prepare('SELECT * FROM segments WHERE source_id = ? ORDER BY sequence LIMIT ? OFFSET ?')
      .all(sourceId, limit, offset) as Segment[];
    return { segments, total };
  }

  getSegment(segmentId: string): Segment | null {
    const row = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId) as
      Segment | undefined;
    return row ?? null;
  }

  /**
   * 片段上下文：取同来源中位于该片段前后的原文（字符预算内），
   * 供引用展开时显示“前后少量上下文”。撤销授权后拒绝。
   */
  getSegmentContext(
    segmentId: string,
    beforeChars: number,
    afterChars: number,
  ): { segment: Segment; before: string; after: string; sourceTitle: string } | null {
    const seg = this.getSegment(segmentId);
    if (!seg) return null;
    assertSourceAuthorized(this.db, seg.source_id);
    const source = this.get(seg.source_id);
    if (!source) return null;
    const beforeRows = this.db
      .prepare(
        'SELECT text FROM segments WHERE source_id = ? AND sequence < ? ORDER BY sequence DESC',
      )
      .all(seg.source_id, seg.sequence) as Array<{ text: string }>;
    const afterRows = this.db
      .prepare(
        'SELECT text FROM segments WHERE source_id = ? AND sequence > ? ORDER BY sequence ASC',
      )
      .all(seg.source_id, seg.sequence) as Array<{ text: string }>;
    let before = '';
    for (const r of beforeRows) {
      if (before.length >= beforeChars) break;
      before = r.text + '\n\n' + before;
    }
    before = before.slice(-beforeChars);
    let after = '';
    for (const r of afterRows) {
      if (after.length >= afterChars) break;
      after += r.text + '\n\n';
    }
    after = after.slice(0, afterChars);
    return { segment: seg, before, after, sourceTitle: source.title };
  }

  /** 项目查找（名称精确/模糊、ID、根路径）。 */
  resolveProject(ref: string, projects: Project[]): Project | null {
    if (!ref) return null;
    const byId = projects.find((p) => p.id === ref);
    if (byId) return byId;
    const byRoot = projects.find(
      (p) => p.root_path && p.root_path.toLowerCase() === ref.toLowerCase(),
    );
    if (byRoot) return byRoot;
    const lower = ref.toLowerCase();
    const exact = projects.find((p) => p.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = projects.find((p) => p.name.toLowerCase().includes(lower));
    return partial ?? null;
  }

  list(opts: { projectId: string | null }): SourceWithStats[] {
    const sql = `
      SELECT s.*, p.status AS permission_status,
        (SELECT count(*) FROM segments sg WHERE sg.source_id = s.id) AS segment_count,
        (SELECT count(*) FROM items i WHERE i.extracted_from_source_id = s.id) AS item_count
      FROM sources s
      JOIN permissions p ON p.id = s.permission_id
      ${opts.projectId ? 'WHERE s.project_id = ?' : ''}
      ORDER BY s.imported_at DESC
    `;
    const rows = (
      opts.projectId ? this.db.prepare(sql).all(opts.projectId) : this.db.prepare(sql).all()
    ) as Array<
      Source & {
        permission_status: Permission['status'];
        segment_count: number;
        item_count: number;
      }
    >;
    return rows.map((r) => ({
      source: {
        id: r.id,
        kind: r.kind,
        provider: r.provider,
        external_id: r.external_id,
        title: r.title,
        content_hash: r.content_hash,
        raw_path: r.raw_path,
        captured_at: r.captured_at,
        imported_at: r.imported_at,
        permission_id: r.permission_id,
        project_id: r.project_id,
        metadata_json: r.metadata_json,
      },
      permissionStatus: r.permission_status,
      segmentCount: r.segment_count,
      itemCount: r.item_count,
    }));
  }

  /**
   * 扩展采集：把新轮次追加到 chatgpt_web 来源。
   * 幂等键：(source_id, external_node_id=顺序, content_hash)。
   * 回答被编辑或重新生成（同顺序不同指纹）时保存为新版本：
   * 旧版本 is_active_branch 置 0（保留历史、可查看），新版本为唯一活动版本。
   * 提取默认只使用活动版本（Extractor 过滤）。
   * 返回 {accepted, deduplicated}。
   */
  appendCapturedTurns(
    sourceId: string,
    turns: Array<{
      order: number;
      role: 'user' | 'assistant' | 'system' | 'document';
      text: string;
      clientHash?: string;
    }>,
    opts?: { title?: string },
  ): { accepted: number; deduplicated: number } {
    const source = this.get(sourceId);
    if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, `来源不存在: ${sourceId}`);
    const existing = this.db
      .prepare(
        'SELECT sequence, external_node_id, content_hash FROM segments WHERE source_id = ? ORDER BY sequence',
      )
      .all(sourceId) as Array<{
      sequence: number;
      external_node_id: string | null;
      content_hash: string;
    }>;
    const maxSeq = existing.length > 0 ? Math.max(...existing.map((e) => e.sequence)) : -1;
    const insertSegment = this.db.prepare(
      `INSERT INTO segments (id, source_id, sequence, role, external_node_id, external_parent_id,
        is_active_branch, occurred_at, text, content_hash, metadata_json)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, '{}')`,
    );
    // 同一 external_node_id 出现新指纹（编辑/重新生成）→ 旧版本全部转为非活动分支
    const deactivateSiblings = this.db.prepare(
      'UPDATE segments SET is_active_branch = 0 WHERE source_id = ? AND external_node_id = ? AND content_hash != ?',
    );
    const existsStmt = this.db.prepare(
      'SELECT 1 AS one FROM segments WHERE source_id = ? AND external_node_id = ? AND content_hash = ?',
    );
    const activeStmt = this.db.prepare(
      'SELECT 1 AS one FROM segments WHERE source_id = ? AND external_node_id = ? AND content_hash = ? AND is_active_branch = 1',
    );
    const reactivateStmt = this.db.prepare(
      'UPDATE segments SET is_active_branch = 1 WHERE source_id = ? AND external_node_id = ? AND content_hash = ?',
    );
    const updateHash = this.db.prepare('UPDATE sources SET content_hash = ? WHERE id = ?');
    const updateTitle = this.db.prepare('UPDATE sources SET title = ? WHERE id = ?');
    const touchImported = this.db.prepare(
      'UPDATE sources SET imported_at = ?, captured_at = ? WHERE id = ?',
    );
    // 修复 v0.1.1 M0.2：可用内容版本 —— 影响理解的新增/编辑/分支切换递增；
    // 完全重复提交不递增（「已收到」与「已分析」在此分离，供持久化待分析状态）
    const bumpRevision = this.db.prepare(
      'UPDATE sources SET content_revision = content_revision + 1 WHERE id = ?',
    );
    let accepted = 0;
    let deduplicated = 0;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      let next = maxSeq + 1;
      const allHashes: string[] = existing.map((e) => e.content_hash);
      for (const turn of [...turns].sort((a, b) => a.order - b.order)) {
        const hash = sha256(turn.text);
        const node = String(turn.order);
        // 后端不信任扩展端指纹，自行计算并校验
        const dup = existsStmt.get(sourceId, node, hash) as { one: number } | undefined;
        if (dup) {
          const isActive = activeStmt.get(sourceId, node, hash) as { one: number } | undefined;
          if (isActive) {
            deduplicated += 1;
            continue;
          }
          // 该指纹曾作为旧版本存在、当前被替代：同一内容再次成为当前版本 → 重新激活
          reactivateStmt.run(sourceId, node, hash);
          deactivateSiblings.run(sourceId, node, hash);
          deduplicated += 1;
          continue;
        }
        // 新指纹：同顺序的旧版本保留但转为非活动分支（回答被编辑/重新生成）
        deactivateSiblings.run(sourceId, node, hash);
        insertSegment.run(randomUUID(), sourceId, next++, turn.role, node, now, turn.text, hash);
        allHashes.push(hash);
        accepted += 1;
      }
      updateHash.run(sha256(allHashes.join('\n')), sourceId);
      if (opts?.title && opts.title.trim().length > 0 && opts.title !== source.title) {
        updateTitle.run(opts.title.trim(), sourceId);
      }
      // 每次成功追加都刷新「最近同步」（修复 P1-6.6：不再停留在首次采集时间）
      if (accepted > 0 || deduplicated > 0) {
        touchImported.run(now, now, sourceId);
      }
      if (accepted > 0) {
        bumpRevision.run(sourceId);
      }
    });
    tx();
    return { accepted, deduplicated };
  }

  /**
   * 推进「已分析版本」（修复 v0.1.1 M0.2）：只允许前进，不允许较旧任务
   * 覆盖较新结果。返回推进后的 analyzed_revision。
   */
  advanceAnalyzedRevision(sourceId: string, targetRevision: number): number {
    this.db
      .prepare('UPDATE sources SET analyzed_revision = ? WHERE id = ? AND analyzed_revision < ?')
      .run(targetRevision, sourceId, targetRevision);
    const row = this.db
      .prepare('SELECT analyzed_revision AS a FROM sources WHERE id = ?')
      .get(sourceId) as { a: number } | undefined;
    return row?.a ?? 0;
  }

  /** 来源的当前内容版本与已分析版本。 */
  getRevisions(sourceId: string): { content: number; analyzed: number } {
    const row = this.db
      .prepare('SELECT content_revision AS c, analyzed_revision AS a FROM sources WHERE id = ?')
      .get(sourceId) as { c: number; a: number } | undefined;
    return { content: row?.c ?? 0, analyzed: row?.a ?? 0 };
  }

  /**
   * 绑定/重新绑定/解绑来源的项目（M1.1：一次归属，后续继承）。
   * 受控事务：
   * - 来源行与「派生 AI 条目」（origin='ai' 且未废弃）的有效归属一起更新；
   * - 人工纠正/手工条目（origin='user'）不搬（人工归属不能被静默带走）；
   * - 解绑时派生条目回到未分配并进入待讨论；
   * - superseded 条目属于历史，不参与归属变更。
   * 返回移动的条目数。
   */
  bindProject(sourceId: string, projectId: string | null): { movedItems: number } {
    const source = this.get(sourceId);
    if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, `来源不存在: ${sourceId}`);
    if (projectId !== null) {
      const p = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!p) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${projectId}`);
    }
    let movedItems = 0;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE sources SET project_id = ? WHERE id = ?').run(projectId, sourceId);
      const r = this.db
        .prepare(
          `UPDATE items SET project_id = ?,
             needs_review = CASE WHEN ? IS NULL THEN 1 ELSE 0 END
           WHERE extracted_from_source_id = ? AND origin = 'ai' AND state != 'superseded'`,
        )
        .run(projectId, projectId, sourceId);
      movedItems = r.changes;
    });
    tx();
    return { movedItems };
  }

  /**
   * 对话身份合并（修复 P1-6.5）：新对话先用 page:<hash> 身份保存，
   * ChatGPT 分配正式 /c/<id> 后，把临时来源并入正式来源。
   * 合并策略：片段按 (external_node_id, content_hash) 幂等搬运（不重复、不丢内容），
   * 临时来源行随后删除（原文 vault 副本按内容指纹保留，不丢原件）。
   */
  mergeConversationSources(
    fromSourceId: string,
    intoSourceId: string,
  ): { moved: number; deduplicated: number } {
    const from = this.get(fromSourceId);
    const into = this.get(intoSourceId);
    if (!from || !into) throw new IxaError(ErrorCodes.NOT_FOUND, '合并来源不存在');
    if (from.provider !== 'chatgpt_web' || into.provider !== 'chatgpt_web') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '仅支持 chatgpt_web 来源合并');
    }
    const fromSegs = this.db
      .prepare('SELECT * FROM segments WHERE source_id = ? ORDER BY sequence')
      .all(fromSourceId) as Segment[];
    const intoExisting = this.db
      .prepare('SELECT external_node_id, content_hash FROM segments WHERE source_id = ?')
      .all(intoSourceId) as Array<{ external_node_id: string | null; content_hash: string }>;
    const intoKeys = new Set(intoExisting.map((s) => `${s.external_node_id}|${s.content_hash}`));
    const maxSeq =
      intoExisting.length > 0
        ? ((
            this.db
              .prepare('SELECT MAX(sequence) AS m FROM segments WHERE source_id = ?')
              .get(intoSourceId) as { m: number | null }
          ).m ?? -1)
        : -1;
    const insert = this.db.prepare(
      `INSERT INTO segments (id, source_id, sequence, role, external_node_id, external_parent_id,
        is_active_branch, occurred_at, text, content_hash, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const moveEvidence = this.db.prepare(
      'UPDATE item_evidence SET segment_id = ? WHERE segment_id = ?',
    );
    const deleteFrom = this.db.prepare('DELETE FROM segments WHERE source_id = ?');
    const deleteSource = this.db.prepare('DELETE FROM sources WHERE id = ?');
    let moved = 0;
    let deduplicated = 0;
    let next = maxSeq + 1;
    const tx = this.db.transaction(() => {
      for (const seg of fromSegs) {
        const key = `${seg.external_node_id}|${seg.content_hash}`;
        if (intoKeys.has(key)) {
          // 临时来源已有的提取依据指向重复片段 → 转挂到正式来源的同内容片段
          const target = this.db
            .prepare(
              'SELECT id FROM segments WHERE source_id = ? AND external_node_id = ? AND content_hash = ? LIMIT 1',
            )
            .get(intoSourceId, seg.external_node_id, seg.content_hash) as
            { id: string } | undefined;
          if (target) moveEvidence.run(target.id, seg.id);
          deduplicated += 1;
          continue;
        }
        const newId = randomUUID();
        insert.run(
          newId,
          intoSourceId,
          next++,
          seg.role,
          seg.external_node_id,
          seg.external_parent_id,
          seg.is_active_branch,
          seg.occurred_at,
          seg.text,
          seg.content_hash,
          seg.metadata_json,
        );
        moveEvidence.run(newId, seg.id);
        intoKeys.add(key);
        moved += 1;
      }
      // M1.1：先读取被合并方的项目绑定（删除前），随身份转正继承
      const fromProject =
        (
          this.db.prepare('SELECT project_id AS p FROM sources WHERE id = ?').get(fromSourceId) as
            | {
                p: string | null;
              }
            | undefined
        )?.p ?? null;
      deleteFrom.run(fromSourceId);
      deleteSource.run(fromSourceId);
      this.db
        .prepare('UPDATE sources SET project_id = ? WHERE id = ? AND project_id IS NULL')
        .run(fromProject, intoSourceId);
      // 合并改变了正式来源的可用内容 → 递增内容版本（待分析状态持久化）
      if (moved > 0) {
        this.db
          .prepare('UPDATE sources SET content_revision = content_revision + 1 WHERE id = ?')
          .run(intoSourceId);
      }
    });
    tx();
    return { moved, deduplicated };
  }

  /** 来源的派生理解条目数。 */
  countItems(sourceId: string): number {
    return (
      this.db
        .prepare('SELECT count(*) AS c FROM items WHERE extracted_from_source_id = ?')
        .get(sourceId) as { c: number }
    ).c;
  }

  /** 删除派生理解（保留原文与片段）。 */
  deleteDerivedItems(sourceId: string): number {
    const rows = this.db
      .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
      .all(sourceId) as Array<{ id: string }>;
    const del = this.db.prepare('DELETE FROM items WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const r of rows) del.run(r.id);
    });
    tx();
    return rows.length;
  }

  /** 删除整份来源（含片段、派生理解；vault 原件保留）。 */
  deleteSource(id: string): void {
    const del = this.db.transaction(() => {
      this.deleteDerivedItems(id);
      this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    });
    del();
  }

  /** 解析该来源对应的 vault 内容指纹路径（raw_path 为严格 vault 相对路径；授权撤销后拒绝）。 */
  rawContent(id: string, vaultRead: (path: string) => Buffer): Buffer | null {
    const source = this.get(id);
    if (!source) return null;
    assertSourceAuthorized(this.db, id);
    try {
      return vaultRead(source.raw_path);
    } catch {
      return null;
    }
  }
}
