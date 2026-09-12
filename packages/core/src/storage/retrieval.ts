import type { SearchResult } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { SearchService, type SegmentSearchHit } from './search.js';

export type RetrievalBackend = 'keyword' | 'lancedb';

export interface RetrievalHit {
  backend: RetrievalBackend;
  items: SearchResult[];
  segments: SegmentSearchHit[];
  degraded: boolean;
  notice: string;
}

export interface RetrievalAdapter {
  readonly backend: RetrievalBackend;
  lookup(query: string, opts: { projectId?: string | null; limit?: number }): RetrievalHit;
}

/**
 * 关键词路径：现有 SQLite FTS。LanceDB 未获准嵌入模型时必须走这里，
 * 不得假装语义检索已验收。
 */
export class KeywordRetrievalAdapter implements RetrievalAdapter {
  readonly backend = 'keyword' as const;
  constructor(private readonly keywords: SearchService) {}

  lookup(query: string, opts: { projectId?: string | null; limit?: number } = {}): RetrievalHit {
    const mixed = this.keywords.searchAll(query, opts);
    return {
      backend: 'keyword',
      items: mixed.items,
      segments: mixed.segments,
      degraded: false,
      notice: '关键词检索（SQLite FTS）。语义索引未启用。',
    };
  }
}

/**
 * LanceDB 适配器骨架。没有 IXAEON_LANCEDB_PATH / 嵌入模型时立刻降级关键词，
 * 不下载模型、不假装混合检索已通过。
 */
export class LanceDbRetrievalAdapter implements RetrievalAdapter {
  readonly backend = 'lancedb' as const;
  constructor(
    private readonly keyword: KeywordRetrievalAdapter,
    private readonly indexPath = process.env.IXAEON_LANCEDB_PATH?.trim() || '',
  ) {}

  lookup(query: string, opts: { projectId?: string | null; limit?: number } = {}): RetrievalHit {
    if (!this.indexPath) {
      const fallback = this.keyword.lookup(query, opts);
      return {
        ...fallback,
        backend: 'lancedb',
        degraded: true,
        notice:
          'LanceDB 未配置（缺 IXAEON_LANCEDB_PATH / 嵌入模型）。已降级关键词检索，不是语义验收通过。',
      };
    }
    const fallback = this.keyword.lookup(query, opts);
    return {
      ...fallback,
      backend: 'lancedb',
      degraded: true,
      notice:
        'LanceDB 路径已声明但本机嵌入未获准，不静默下载模型。本轮仍用关键词，语义对比未跑。',
    };
  }
}

export function createRetrievalAdapter(db: CoreDatabase): RetrievalAdapter {
  const keyword = new KeywordRetrievalAdapter(new SearchService(db));
  if (process.env.IXAEON_RETRIEVAL === 'lancedb' || process.env.IXAEON_LANCEDB_PATH) {
    return new LanceDbRetrievalAdapter(keyword);
  }
  return keyword;
}
