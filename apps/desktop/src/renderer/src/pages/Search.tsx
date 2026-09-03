import { useState } from 'react';
import { api, errMsg, type Project, type SegmentHit } from '../api.js';
import { Button, Card, Empty, ErrorBanner, roleLabel, Spinner } from '../ui.js';

/** 搜索页：全文检索（FTS5 trigram），可按项目过滤。 */
export function SearchPage({
  projects,
  projectId,
  onProjectChange,
}: {
  projects: Project[];
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SegmentHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async () => {
    if (query.trim().length === 0) {
      setHits(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setHits(await api.searchSegments({ query: query.trim(), projectId, limit: 20 }));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="page-search">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="全文检索" testId="search-card">
        <div className="search-bar">
          <select
            value={projectId ?? ''}
            onChange={(e) => onProjectChange(e.target.value || null)}
            data-testid="search-project-filter"
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            value={query}
            placeholder="搜索原文关键词（支持中文，2 字以上走全文索引）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            data-testid="search-input"
          />
          <Button kind="primary" disabled={busy} onClick={runSearch} testId="search-run">
            {busy ? '搜索中…' : '搜索'}
          </Button>
        </div>

        {busy ? (
          <Spinner label="搜索中…" />
        ) : hits === null ? (
          <Empty>输入关键词检索已导入的原文片段。</Empty>
        ) : hits.length === 0 ? (
          <Empty testId="search-empty">没有匹配的结果。</Empty>
        ) : (
          <ul className="search-results" data-testid="search-results">
            {hits.map((hit) => (
              <li key={hit.segmentId} className="search-hit">
                <header>
                  <span className="badge">{roleLabel(hit.role)}</span>
                  <strong>{hit.sourceTitle}</strong>
                  {hit.occurredAt && (
                    <span className="muted">{hit.occurredAt.slice(0, 19).replace('T', ' ')}</span>
                  )}
                </header>
                <pre className="segment-text">{hit.excerpt}</pre>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
