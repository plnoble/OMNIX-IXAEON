import { createHash } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import { cosine, type TextEmbedder } from './embedder.js';

/**
 * 记忆条目的语义索引（三周任务单 R1/R2，迁移 27）。
 *
 * 只负责「算向量、存向量、比相似度」。哪些条目可以被取用，由调用方用既有的
 * 候选查询（ContextSelector.loadVisibleCandidates）决定——有向量不代表可以被取用。
 */
export class SemanticIndex {
  constructor(
    private readonly db: CoreDatabase,
    private readonly embedder: TextEmbedder,
  ) {}

  get modelId(): string {
    return this.embedder.modelId;
  }

  /**
   * 给缺向量或已过期（原文变了）的条目补向量。只处理可能成为候选的条目
   *（current / disputed）。分批请求，单批失败即停并抛出，已写入的保留。
   */
  async backfill(opts: { batchSize?: number; limit?: number } = {}): Promise<{
    embedded: number;
    remaining: number;
  }> {
    const batchSize = Math.max(1, opts.batchSize ?? 16);
    const pending = this.pendingItems(opts.limit);
    const upsert = this.db.prepare(
      `INSERT INTO item_embeddings (item_id, model, text_hash, dim, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id, model) DO UPDATE SET
         text_hash = excluded.text_hash, dim = excluded.dim,
         vector = excluded.vector, created_at = excluded.created_at`,
    );
    let embedded = 0;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await this.embedder.embedDocuments(batch.map((b) => b.text));
      const now = new Date().toISOString();
      this.db.transaction(() => {
        batch.forEach((b, j) => {
          const vec = vectors[j]!;
          upsert.run(b.id, this.embedder.modelId, b.hash, vec.length, toBlob(vec), now);
        });
      })();
      embedded += batch.length;
    }
    return { embedded, remaining: this.pendingItems().length };
  }

  /** 覆盖情况：可候选条目里有多少已有当前模型的有效向量。 */
  coverage(): { indexed: number; total: number } {
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM items WHERE state IN ('current', 'disputed')`)
        .get() as { n: number }
    ).n;
    return { indexed: total - this.pendingItems().length, total };
  }

  /**
   * 丢掉当前模型的向量再补一遍；其它模型的行不动。
   * 先确认向量服务可用再删：Ollama 没开时点重建，不能把现有向量删光却补不回来
   *（那样聊天选记忆会整体退回关键词）。
   */
  async rebuild(): Promise<{ embedded: number; remaining: number }> {
    await this.embedder.embedQuery('重建前确认向量服务可用');
    this.db.prepare('DELETE FROM item_embeddings WHERE model = ?').run(this.embedder.modelId);
    return this.backfill();
  }

  /**
   * 问题与指定条目的余弦相似度。传多个问题（如并列问题的子问题）时每条取最高。
   * 没有当前有效向量的条目不出现在结果里，由调用方决定怎么对待
   *（不能把「没算过」当成「不相关」）。
   */
  async score(question: string | string[], itemIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (itemIds.length === 0) return result;
    const questions = [...new Set(Array.isArray(question) ? question : [question])];
    const qs: Float32Array[] = [];
    for (const text of questions) qs.push(await this.embedder.embedQuery(text));
    const stmt = this.db.prepare(
      `SELECT e.vector, e.text_hash, i.statement
       FROM item_embeddings e JOIN items i ON i.id = e.item_id
       WHERE e.item_id = ? AND e.model = ?`,
    );
    for (const id of itemIds) {
      const row = stmt.get(id, this.embedder.modelId) as
        { vector: Buffer; text_hash: string; statement: string } | undefined;
      if (!row || row.text_hash !== textHash(row.statement)) continue;
      const vec = fromBlob(row.vector);
      result.set(id, Math.max(...qs.map((q) => cosine(q, vec))));
    }
    return result;
  }

  private pendingItems(limit?: number): Array<{ id: string; text: string; hash: string }> {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.statement, e.text_hash
         FROM items i
         LEFT JOIN item_embeddings e ON e.item_id = i.id AND e.model = ?
         WHERE i.state IN ('current', 'disputed')
         ORDER BY i.updated_at DESC`,
      )
      .all(this.embedder.modelId) as Array<{
      id: string;
      statement: string;
      text_hash: string | null;
    }>;
    const pending: Array<{ id: string; text: string; hash: string }> = [];
    for (const row of rows) {
      const hash = textHash(row.statement);
      if (row.text_hash === hash) continue;
      pending.push({ id: row.id, text: row.statement, hash });
      if (limit !== undefined && pending.length >= limit) break;
    }
    return pending;
  }
}

function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** 复制出独立的 Float32Array：SQLite 返回的 Buffer 不保证 4 字节对齐。 */
function fromBlob(buf: Buffer): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, Math.floor(buf.byteLength / 4));
}
