import { useCallback, useEffect, useState } from 'react';
import {
  api,
  errMsg,
  type Project,
  type Segment,
  type Source,
  type SourceListItem,
} from '../api.js';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  providerLabel,
  roleLabel,
  sourceKindLabel,
  Spinner,
} from '../ui.js';

const PAGE_SIZE = 50;

/** 来源页：导入 → 列表 → 详情（片段阅读器 + 上下文查看）。 */
export function SourcesPage({
  projects,
  projectId,
  onProjectChange,
}: {
  projects: Project[];
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
}) {
  const [list, setList] = useState<SourceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    source: Source;
    segments: Segment[];
    total: number;
  } | null>(null);

  const reload = useCallback(async () => {
    setList(null);
    try {
      setList(await api.listSources({ projectId }));
    } catch (err) {
      setError(errMsg(err));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
    setDetail(null);
  }, [reload]);

  const importDocuments = async () => {
    setBusy(true);
    setError(null);
    try {
      const paths = await api.pickFiles('documents');
      if (!paths || paths.length === 0) return;
      await api.importPaths({ paths, projectId });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const importChatgptExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const paths = await api.pickFiles('chatgptExport');
      if (!paths || paths.length === 0) return;
      await api.importPaths({ paths, projectId });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    setError(null);
    try {
      const source = await api.getSource(id);
      if (!source) throw new Error('来源不存在');
      const result = await api.getSourceSegments({ sourceId: id, offset: 0, limit: PAGE_SIZE });
      setDetail({ source, segments: result.segments, total: result.total });
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const loadMore = async () => {
    if (!detail) return;
    const next = await api.getSourceSegments({
      sourceId: detail.source.id,
      offset: detail.segments.length,
      limit: PAGE_SIZE,
    });
    setDetail({ ...detail, segments: detail.segments.concat(next.segments), total: next.total });
  };

  const removeSource = async (id: string) => {
    setBusy(true);
    try {
      await api.deleteSource(id);
      setDetail(null);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="page-sources">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card
        title="来源"
        testId="sources-card"
        actions={
          <>
            <select
              value={projectId ?? ''}
              onChange={(e) => onProjectChange(e.target.value || null)}
              data-testid="sources-project-filter"
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button disabled={busy} onClick={importDocuments} testId="sources-import-docs">
              导入文档
            </Button>
            <Button disabled={busy} onClick={importChatgptExport} testId="sources-import-chatgpt">
              导入 ChatGPT 导出
            </Button>
          </>
        }
      >
        <p className="note">
          原文导入后永久保留、只读。导入相同内容会自动去重。授权只覆盖你在对话框中明确选择的文件。
        </p>
        {list === null ? (
          <Spinner />
        ) : list.length === 0 ? (
          <Empty testId="sources-empty">还没有来源。点击“导入文档”开始。</Empty>
        ) : (
          <table className="table" data-testid="sources-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th>提供者</th>
                <th>片段</th>
                <th>条目</th>
                <th>导入时间</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => (
                <tr
                  key={item.source.id}
                  onClick={() => void openDetail(item.source.id)}
                  className="row-click"
                  data-testid={`source-row-${item.source.id}`}
                >
                  <td>{item.source.title}</td>
                  <td>{sourceKindLabel(item.source.kind)}</td>
                  <td>{providerLabel(item.source.provider)}</td>
                  <td>{item.segmentCount}</td>
                  <td>{item.itemCount}</td>
                  <td>{item.source.imported_at.slice(0, 19).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {detail && (
        <SourceDetail
          detail={detail}
          onClose={() => setDetail(null)}
          onLoadMore={loadMore}
          onDelete={() => removeSource(detail.source.id)}
        />
      )}
    </div>
  );
}

function SourceDetail({
  detail,
  onClose,
  onLoadMore,
  onDelete,
}: {
  detail: { source: Source; segments: Segment[]; total: number };
  onClose: () => void;
  onLoadMore: () => void;
  onDelete: () => void;
}) {
  const { source, segments, total } = detail;
  const [context, setContext] = useState<{
    segment: Segment;
    before: string;
    after: string;
    sourceTitle: string;
  } | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);

  const showContext = async (segment: Segment) => {
    setCtxError(null);
    try {
      const result = await api.getSegmentContext({
        segmentId: segment.id,
        beforeChars: 600,
        afterChars: 600,
      });
      setContext(result);
    } catch (err) {
      setCtxError(errMsg(err));
    }
  };

  return (
    <Card
      title={
        <>
          <span data-testid="source-detail-title">{source.title}</span>
          <span className="badge">{sourceKindLabel(source.kind)}</span>
          <span className="badge">{providerLabel(source.provider)}</span>
        </>
      }
      testId="source-detail"
      actions={
        <>
          <Button kind="danger" onClick={onDelete} testId="source-delete">
            删除来源
          </Button>
          <Button kind="ghost" onClick={onClose} testId="source-detail-close">
            关闭
          </Button>
        </>
      }
    >
      {ctxError && <ErrorBanner message={ctxError} onDismiss={() => setCtxError(null)} />}
      <p className="note">
        共 {total} 个片段；显示 {segments.length} 个。点击“上下文”查看该片段前后原文（证据核验）。
      </p>
      <div className="segment-list" data-testid="segment-list">
        {segments.map((seg) => (
          <article key={seg.id} className={`segment role-${seg.role}`}>
            <header>
              <span className="role-tag">{roleLabel(seg.role)}</span>
              {seg.occurred_at && (
                <span className="muted">{seg.occurred_at.slice(0, 19).replace('T', ' ')}</span>
              )}
              {!seg.is_active_branch && <span className="badge badge-muted">非活动分支</span>}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void showContext(seg)}
                data-testid={`segment-context-${seg.id}`}
              >
                上下文
              </button>
            </header>
            <pre className="segment-text">{seg.text}</pre>
          </article>
        ))}
      </div>
      {segments.length < total && (
        <div className="wizard-nav">
          <Button onClick={onLoadMore} testId="source-load-more">
            加载更多（{segments.length}/{total}）
          </Button>
        </div>
      )}
      {context && (
        <div className="context-panel" data-testid="context-panel">
          <header>
            <h3>上下文核验 — {context.sourceTitle}</h3>
            <Button kind="ghost" onClick={() => setContext(null)}>
              关闭
            </Button>
          </header>
          <pre className="segment-text">{context.before}</pre>
          <pre className="segment-text segment-focus">{context.segment.text}</pre>
          <pre className="segment-text">{context.after}</pre>
        </div>
      )}
    </Card>
  );
}
