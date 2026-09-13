import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Project } from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';

interface CheckOutcome {
  searchUsed: boolean;
  searchError: string | null;
  searchCandidates: Array<{ title: string; url: string; snippet: string }>;
}

interface Snapshot {
  mode: 'approved-sources-only' | 'approved-sources-plus-search';
  searchConfigured: boolean;
  notice: string;
  topics: Array<{
    id: string;
    question: string;
    public_description: string;
    enabled: boolean;
    paused: boolean;
    last_success_at: string | null;
    last_failure_at: string | null;
    last_failure: string | null;
    consecutive_failures: number;
    next_check_at: string | null;
    sources: Array<{ id: string; url: string; kind: string; last_error: string | null }>;
    findings: Array<{
      id: string;
      title: string;
      url: string;
      excerpt: string;
      claimed_published_at: string | null;
      fetched_at: string;
      evidence_class: string;
      limitations: string | null;
      action_worthy: boolean;
      action_reason: string | null;
    }>;
    runs: Array<{
      id: string;
      status: string;
      pages_fetched: number;
      findings_new: number;
      error: string | null;
    }>;
  }>;
}

export function ResearchPage({
  projects,
  onOpenTasks,
}: {
  projects: Project[];
  onOpenTasks?: () => void;
}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [publicDescription, setPublicDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceKind, setSourceKind] = useState<'page' | 'feed'>('page');
  const [extraUrl, setExtraUrl] = useState<Record<string, string>>({});
  const [draftProjectId, setDraftProjectId] = useState(projects[0]?.id ?? '');
  /** 最近一次手动检查的搜索候选（按主题 id 存；临时展示，不落库） */
  const [lastCheck, setLastCheck] = useState<Record<string, CheckOutcome>>({});

  const reload = useCallback(async () => {
    try {
      setData((await api.listResearchTopics()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (draftProjectId && projects.some((p) => p.id === draftProjectId)) return;
    setDraftProjectId(projects[0]?.id ?? '');
  }, [projects, draftProjectId]);

  const create = async () => {
    setBusy(true);
    try {
      await api.createResearchTopic({
        question: question.trim(),
        publicDescription: publicDescription.trim(),
        sources: sourceUrl.trim() ? [{ url: sourceUrl.trim(), kind: sourceKind }] : [],
      });
      setQuestion('');
      setPublicDescription('');
      setSourceUrl('');
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data && !error) return <Spinner />;

  return (
    <div data-testid="page-research">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="主动研究" testId="research-notice">
        <p className="note">
          {data?.notice ??
            '当前未配置搜索服务。只给方向、不给网址时不能完成真实搜索；已批准来源检查不是全网检索。'}
        </p>
        <p className="muted">
          有批准网址时，「立即检查」只证明这个网址能打开并记下内容。
          {data?.searchConfigured
            ? ' 配置了搜索服务后：写了「出门说法」的关注，手动检查会再做一次受控搜索（查询本地脱敏后外发），返回候选网址。候选不是发现——你批准后才会被读取。定时轮次仍只读批准来源，不消耗搜索额度。'
            : ' 无网址的关注可以先记下方向，检查会明确失败，直到在设置页配置搜索入口。'}{' '}
          发现是外部线索，不会自动变成你的目标。
        </p>
      </Card>
      <Card title="新建关注">
        <Field label="研究问题">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            data-testid="research-question"
          />
        </Field>
        <Field
          label="出门说法（搜索用）"
          hint="配置搜索服务后，手动检查会把这句话（本地脱敏后）发给搜索服务找候选来源；不写就不搜。问题本身不会外发。"
        >
          <input
            value={publicDescription}
            onChange={(e) => setPublicDescription(e.target.value)}
            data-testid="research-public"
            placeholder="可空。例如：关注某开源项目的 Release"
          />
        </Field>
        <Field
          label="批准来源 URL（可选）"
          hint="只给方向也可以创建。没配搜索、也没写出门说法时，空来源的立即检查会失败，不会假装已搜索。"
        >
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            data-testid="research-url"
            placeholder="https://… 可空"
          />
        </Field>
        <Field label="来源类型">
          <select
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value as 'page' | 'feed')}
            data-testid="research-kind"
          >
            <option value="page">发布页</option>
            <option value="feed">RSS / Atom</option>
          </select>
        </Field>
        <Button
          kind="primary"
          disabled={busy || question.trim().length === 0}
          onClick={() => void create()}
          testId="research-create"
        >
          创建（默认不自动运行）
        </Button>
      </Card>
      {(data?.topics ?? []).map((t) => (
        <Card key={t.id} title={t.question} testId={`research-topic-${t.id}`}>
          {t.public_description ? <p className="muted">出门说法：{t.public_description}</p> : null}
          <p className="muted">
            {t.enabled ? '已启用自动检查' : '自动检查关闭'} · {t.paused ? '已暂停' : '未暂停'}
          </p>
          <p className="muted">
            上次成功 {t.last_success_at ?? '无'} · 上次失败 {t.last_failure_at ?? '无'}
            {t.last_failure ? `（${t.last_failure}）` : ''}
          </p>
          {t.consecutive_failures >= 3 && (
            <p className="warn">连续失败 {t.consecutive_failures} 次，未把失败写成无变化。</p>
          )}
          <div className="card-actions">
            <Button
              disabled={busy}
              onClick={() =>
                void act(() => api.setResearchTopicEnabled({ id: t.id, enabled: !t.enabled }))
              }
            >
              {t.enabled ? '关闭自动' : '启用自动'}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void act(() => api.setResearchTopicPaused({ id: t.id, paused: !t.paused }))
              }
            >
              {t.paused ? '恢复' : '暂停'}
            </Button>
            <Button
              kind="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const outcome = (await api.checkResearchTopicNow(t.id)) as CheckOutcome;
                  setLastCheck((prev) => ({ ...prev, [t.id]: outcome }));
                })
              }
            >
              立即检查
            </Button>
          </div>
          <h3>来源</h3>
          <ul>
            {t.sources.map((s) => (
              <li key={s.id}>
                {s.kind} · {s.url}
                {s.last_error ? ` · 失败：${s.last_error}` : ''}
              </li>
            ))}
          </ul>
          {lastCheck[t.id] && (
            <div data-testid={`research-search-${t.id}`}>
              {lastCheck[t.id]!.searchUsed ? (
                lastCheck[t.id]!.searchError ? (
                  <p className="warn">
                    搜索失败（不影响批准来源检查）：{lastCheck[t.id]!.searchError}
                  </p>
                ) : lastCheck[t.id]!.searchCandidates.length > 0 ? (
                  <>
                    <h4>搜索候选（不是发现；你批准后才会被读取）</h4>
                    <ul>
                      {lastCheck[t.id]!.searchCandidates.map((c) => (
                        <li key={c.url}>
                          <a href={c.url} target="_blank" rel="noreferrer">
                            {c.title}
                          </a>
                          <div className="muted">{c.snippet}</div>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await api.addResearchSource({
                                  topicId: t.id,
                                  url: c.url,
                                  kind: 'page',
                                });
                                setLastCheck((prev) => ({
                                  ...prev,
                                  [t.id]: {
                                    ...prev[t.id]!,
                                    searchCandidates: prev[t.id]!.searchCandidates.filter(
                                      (x) => x.url !== c.url,
                                    ),
                                  },
                                }));
                              })
                            }
                            testId={`research-approve-${t.id}`}
                          >
                            批准为来源
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="muted">已搜索，本轮没有新候选。</p>
                )
              ) : t.public_description ? (
                <p className="muted">本轮未搜索（定时轮次不搜；或查询脱敏后为空）。</p>
              ) : (
                <p className="muted">未写「出门说法」，搜索不会外发这个问题。</p>
              )}
            </div>
          )}
          <div className="field-row">
            <input
              value={extraUrl[t.id] ?? ''}
              onChange={(e) => setExtraUrl((prev) => ({ ...prev, [t.id]: e.target.value }))}
              placeholder="再批准一个 HTTPS 来源"
              data-testid={`research-add-url-${t.id}`}
            />
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.addResearchSource({
                    topicId: t.id,
                    url: (extraUrl[t.id] ?? '').trim(),
                    kind: 'page',
                  });
                  setExtraUrl((prev) => ({ ...prev, [t.id]: '' }));
                })
              }
              testId={`research-add-source-${t.id}`}
            >
              加来源
            </Button>
          </div>
          <h3>发现</h3>
          {t.findings.length === 0 ? (
            <p className="muted">
              尚无发现。检查成功只表示这个网址能打开；没新标题就不会重复通知。
            </p>
          ) : (
            <ul>
              {t.findings.map((f) => (
                <li key={f.id}>
                  <a href={f.url} target="_blank" rel="noreferrer">
                    {f.title}
                  </a>
                  <div className="muted">
                    抓取 {f.fetched_at.slice(0, 19).replace('T', ' ')}
                    {f.claimed_published_at
                      ? ` · 发布方日期 ${f.claimed_published_at.slice(0, 10)}`
                      : ' · 发布日期未知'}
                    {' · '}
                    {f.evidence_class === 'publisher' ? '发布方声明' : f.evidence_class}
                    {f.limitations ? ` · ${f.limitations}` : ''}
                    {f.action_worthy ? ' · 你标了值得行动' : ''}
                  </div>
                  <p>{f.excerpt}</p>
                  {f.action_reason && <p className="muted">{f.action_reason}</p>}
                  <div className="card-actions">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api.setResearchFindingAction({
                            findingId: f.id,
                            actionWorthy: !f.action_worthy,
                            actionReason: f.action_worthy ? null : '用户标记：值得跟进',
                          }),
                        )
                      }
                      testId={`research-action-${f.id}`}
                    >
                      {f.action_worthy ? '取消「值得行动」' : '标为值得行动'}
                    </Button>
                    {f.action_worthy && projects.length > 0 ? (
                      <>
                        <select
                          value={draftProjectId}
                          onChange={(e) => setDraftProjectId(e.target.value)}
                          data-testid={`research-draft-project-${f.id}`}
                        >
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          disabled={busy || !draftProjectId}
                          onClick={() =>
                            void act(async () => {
                              await api.createCodingDraftFromFinding({
                                findingId: f.id,
                                projectId: draftProjectId,
                              });
                              onOpenTasks?.();
                            })
                          }
                          testId={`research-draft-${f.id}`}
                        >
                          开编码草案（不派发）
                        </Button>
                      </>
                    ) : null}
                    {f.action_worthy && projects.length === 0 ? (
                      <p className="muted">先登记一个项目，才能开草案。</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
