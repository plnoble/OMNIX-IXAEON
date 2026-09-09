import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Correction, type Item, type Project } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Spinner } from '../ui.js';

/** Inbox（待讨论）：无法归属项目或需要人工确认的条目。 */
export function InboxPage({ projects }: { projects: Project[] }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [shelvedItems, setShelvedItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // N01：可处理范围排除已被替代的历史条目（纠正后旧条目不再占据列表）
      // N02：搁置的条目移入下方「已搁置」区，可随时恢复
      const [pending, shelved] = await Promise.all([
        api.listItems({
          projectId: null,
          needsReview: true,
          shelved: false,
          excludeSuperseded: true,
        }),
        api.listItems({ projectId: null, needsReview: true, shelved: true }),
      ]);
      setItems(pending);
      setShelvedItems(shelved);
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

  // N02：暂不处理 = 搁置（可恢复），不是确认/不采纳/删除；
  // 待处理原因与确认状态原样保留，恢复后回到待讨论。
  const defer = async (itemId: string) => {
    try {
      await api.shelveItem({ itemId, shelved: true });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const resume = async (itemId: string) => {
    try {
      await api.shelveItem({ itemId, shelved: false });
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
                          try {
                            await api.confirmItem(item.id);
                            await reload();
                          } catch (err) {
                            setError(errMsg(err));
                          }
                        }}
                        testId={`inbox-confirm-${item.id}`}
                      >
                        确认正确
                      </Button>
                      <Button
                        kind="ghost"
                        onClick={async () => {
                          try {
                            await api.rejectItem(item.id);
                            await reload();
                          } catch (err) {
                            setError(errMsg(err));
                          }
                        }}
                        testId={`inbox-reject-${item.id}`}
                      >
                        不采纳
                      </Button>
                    </>
                  )}
                  {item.scope !== 'personal' && (
                    <Button
                      kind="ghost"
                      onClick={async () => {
                        try {
                          await api.setItemScope({ itemId: item.id, scope: 'personal' });
                          await reload();
                        } catch (err) {
                          setError(errMsg(err));
                        }
                      }}
                      testId={`inbox-personal-${item.id}`}
                    >
                      标为个人
                    </Button>
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
                    onClick={() => void defer(item.id)}
                    testId={`inbox-defer-${item.id}`}
                  >
                    暂不处理
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* N02：已搁置区 —— 暂不处理的条目在这里可找回、可恢复；原因与确认状态未被篡改 */}
      <Card title="已搁置（暂不处理）" testId="inbox-shelved-card">
        <p className="note">
          点过「暂不处理」的条目。搁置不是解决：原因与确认状态原样保留，恢复后回到待讨论。
        </p>
        {shelvedItems === null ? (
          <Spinner />
        ) : shelvedItems.length === 0 ? (
          <Empty testId="inbox-shelved-empty">没有已搁置的条目。</Empty>
        ) : (
          <ul className="project-list">
            {shelvedItems.map((item) => (
              <li key={item.id} className="project-row" data-testid={`inbox-shelved-${item.id}`}>
                <div className="project-main">
                  <span>{item.statement}</span>
                  {item.state === 'disputed' && <span className="badge badge-paused">冲突</span>}
                  <span className="muted">
                    {item.origin === 'ai'
                      ? `AI（把握 ${Math.round(item.confidence * 100)}%）`
                      : item.origin}
                  </span>
                  {item.shelved_at && (
                    <span className="muted">
                      搁置于 {item.shelved_at.slice(0, 19).replace('T', ' ')}
                    </span>
                  )}
                </div>
                <div className="project-actions">
                  <Button onClick={() => void resume(item.id)} testId={`inbox-resume-${item.id}`}>
                    恢复待讨论
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
