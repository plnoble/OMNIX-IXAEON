import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import type { Permission, Project, Segment, Source } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { sha256 } from '../vault.js';
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
        captured_at, imported_at, permission_id, project_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  getSegments(
    sourceId: string,
    offset: number,
    limit: number,
  ): { segments: Segment[]; total: number } {
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
   * 供引用展开时显示“前后少量上下文”。
   */
  getSegmentContext(
    segmentId: string,
    beforeChars: number,
    afterChars: number,
  ): { segment: Segment; before: string; after: string; sourceTitle: string } | null {
    const seg = this.getSegment(segmentId);
    if (!seg) return null;
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

  /**
   * 扩展采集：把新轮次追加到 chatgpt_web 来源。
   * 幂等键：(source_id, external_node_id=顺序, content_hash)。
   * 回答被编辑或重新生成（同顺序不同指纹）时保存为新版本，不覆盖旧版本。
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
      .prepare('SELECT sequence, content_hash FROM segments WHERE source_id = ? ORDER BY sequence')
      .all(sourceId) as Array<{ sequence: number; content_hash: string }>;
    const maxSeq = existing.length > 0 ? Math.max(...existing.map((e) => e.sequence)) : -1;
    const insertSegment = this.db.prepare(
      `INSERT INTO segments (id, source_id, sequence, role, external_node_id, external_parent_id,
        is_active_branch, occurred_at, text, content_hash, metadata_json)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, '{}')`,
    );
    const existsStmt = this.db.prepare(
      'SELECT 1 AS one FROM segments WHERE source_id = ? AND external_node_id = ? AND content_hash = ?',
    );
    const updateHash = this.db.prepare('UPDATE sources SET content_hash = ? WHERE id = ?');
    const updateTitle = this.db.prepare('UPDATE sources SET title = ? WHERE id = ?');
    let accepted = 0;
    let deduplicated = 0;
    const tx = this.db.transaction(() => {
      let next = maxSeq + 1;
      const allHashes: string[] = existing.map((e) => e.content_hash);
      for (const turn of [...turns].sort((a, b) => a.order - b.order)) {
        const hash = sha256(turn.text);
        // 后端不信任扩展端指纹，自行计算并校验
        const dup = existsStmt.get(sourceId, String(turn.order), hash) as
          { one: number } | undefined;
        if (dup) {
          deduplicated += 1;
          continue;
        }
        insertSegment.run(
          randomUUID(),
          sourceId,
          next++,
          turn.role,
          String(turn.order),
          null,
          turn.text,
          hash,
        );
        allHashes.push(hash);
        accepted += 1;
      }
      updateHash.run(sha256(allHashes.join('\n')), sourceId);
      if (opts?.title && opts.title.trim().length > 0 && opts.title !== source.title) {
        updateTitle.run(opts.title.trim(), sourceId);
      }
    });
    tx();
    return { accepted, deduplicated };
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

  /** 解析该来源对应的 vault 内容指纹路径（raw_path 存的是 vault 相对路径或绝对路径）。 */
  rawContent(id: string, vaultRead: (path: string) => Buffer): Buffer | null {
    const source = this.get(id);
    if (!source) return null;
    try {
      return vaultRead(source.raw_path);
    } catch {
      return null;
    }
  }
}
