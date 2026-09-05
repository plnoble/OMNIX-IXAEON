import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Correction, type Item, type Project } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Spinner } from '../ui.js';

/** Inbox（待讨论）：无法归属项目或需要人工确认的条目。 */
export function InboxPage({ projects }: { projects: Project[] }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await api.listItems({ projectId: null, needsReview: true, shelved: false }));
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const assign = async (itemId: string, projectId: string) => {
    try {
      await api.assignItemToProject({ itemId, projectId });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div data-testid="page-inbox">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="待讨论（Inbox）" testId="inbox-card">
        <p className="note">无法确定所属项目或相互冲突的结论，需要你确认归属。</p>
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty testId="inbox-empty">没有待讨论的条目。</Empty>
        ) : (
          <ul className="project-list">
            {items.map((item) => (
              <li key={item.id} className="project-row" data-testid={`inbox-item-${item.id}`}>
                <div className="project-main">
                  <span>{item.statement}</span>
                  {item.state === 'disputed' && <span className="badge badge-paused">冲突</span>}
                  <span className="muted">
                    {item.origin === 'ai'
                      ? `AI（把握 ${Math.round(item.confidence * 100)}%）`
                      : item.origin}
                  </span>
                </div>
                <div className="project-actions">
                  {item.confirmation === 'none' && (
                    <>
                      <Button
                        onClick={async () => {
                          await api.confirmItem(item.id);
                          await reload();
                        }}
                        testId={`inbox-confirm-${item.id}`}
                      >
                        确认正确
                      </Button>
                      <Button
                        kind="ghost"
                        onClick={async () => {
                          await api.rejectItem(item.id);
                          await reload();
                        }}
                        testId={`inbox-reject-${item.id}`}
                      >
                        不采纳
                      </Button>
                    </>
                  )}
                  <select
                    value=""
                    onChange={(e) => e.target.value && void assign(item.id, e.target.value)}
                    data-testid={`inbox-assign-${item.id}`}
                  >
                    <option value="">归属到项目…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    kind="ghost"
                    onClick={async () => {
                      await api.setItemPendingReview({ itemId: item.id, needsReview: false });
                      await reload();
                    }}
                  >
                    暂不处理
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** 改口历史：纠正时间线（旧 → 新 + 时间 + 用户原话）。 */
export function HistoryPage() {
  const [corrections, setCorrections] = useState<Array<
    Correction & { oldItem: Item; newItem: Item }
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listCorrections({ projectId: null })
      .then(setCorrections)
      .catch((err) => setError(errMsg(err)));
  }, []);

  return (
    <div data-testid="page-history">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="我改过主意（改口历史）" testId="history-card">
        <p className="note">
          每次纠正的完整记录：旧结论、新结论、时间和你的原话。原始资料永不改变。
        </p>
        {corrections === null ? (
          <Spinner />
        ) : corrections.length === 0 ? (
          <Empty testId="history-empty">还没有纠正记录。</Empty>
        ) : (
          <ol className="history-list" data-testid="history-list">
            {corrections.map((c) => (
              <li key={c.id} className="history-entry">
                <time className="muted">{c.created_at.slice(0, 19).replace('T', ' ')}</time>
                <p className="old-statement">{c.oldItem.statement}</p>
                <p>↓ 你说：{c.user_text}</p>
                <p className="new-statement">{c.newItem.statement}</p>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
