import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg, type Project } from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';

interface CheckOutcome {
  searchUsed: boolean;
  searchError: string | null;
  searchCandidates: Array<{ title: string; url: string; snippet: string }>;
  run?: { error: string | null };
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
    paid_budget_mode?: string;
    request_cap?: number;
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
  const [createBusy, setCreateBusy] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [topicBusy, setTopicBusy] = useState<Record<string, boolean>>({});
  const [checking, setChecking] = useState<Record<string, { startedAt: number }>>({});
  const [runNotice, setRunNotice] = useState<Record<string, string>>({});
  const checkSeq = useRef<Record<string, number>>({});
  const topicSeq = useRef<Record<string, number>>({});
  const [question, setQuestion] = useState('');
  const [publicDescription, setPublicDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceKind, setSourceKind] = useState<'page' | 'feed'>('page');
  const [paidBudgetMode, setPaidBudgetMode] = useState<'none' | 'request_cap'>('request_cap');
  const [requestCap, setRequestCap] = useState(5);
  const [extraUrl, setExtraUrl] = useState<Record<string, string>>({});
  const [draftProjectId, setDraftProjectId] = useState(projects[0]?.id ?? '');
  /** 最近一次手动检查的搜索候选（按主题 id 存；临时展示，不落库） */
  const [lastCheck, setLastCheck] = useState<Record<string, CheckOutcome>>({});
  const [suggestCount, setSuggestCount] = useState<number | null>(null);
  const [suggested, setSuggested] = useState<Awaited<
    ReturnType<typeof api.suggestWatchDirections>
  > | null>(null);
  const [decided, setDecided] = useState<Record<number, boolean>>({});

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

  const checkingCount = Object.keys(checking).length;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (checkingCount === 0) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [checkingCount]);

  const setTopicFlag = (id: string, on: boolean) =>
    setTopicBusy((prev) => {
      if (on) return { ...prev, [id]: true };
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const create = async () => {
    setCreateBusy(true);
    try {
      await api.createResearchTopic({
        question: question.trim(),
        publicDescription: publicDescription.trim(),
        sources: sourceUrl.trim() ? [{ url: sourceUrl.trim(), kind: sourceKind }] : [],
        paidBudgetMode,
        requestCap: paidBudgetMode === 'request_cap' ? requestCap : 0,
      });
      setQuestion('');
      setPublicDescription('');
      setSourceUrl('');
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setSuggestBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSuggestBusy(false);
    }
  };

  const topicAct = (t: { id: string; question: string }, fn: () => Promise<unknown>) => {
    const seq = (topicSeq.current[t.id] ?? 0) + 1;
    topicSeq.current[t.id] = seq;
    void (async () => {
      setTopicFlag(t.id, true);
      try {
        await fn();
        await reload();
      } catch (err) {
        if (topicSeq.current[t.id] === seq) setError(`${t.question}：${errMsg(err)}`);
      } finally {
        if (topicSeq.current[t.id] === seq) setTopicFlag(t.id, false);
      }
    })();
  };

  const stopWaiting = (id: string) => {
    setTopicFlag(id, false);
    setChecking((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const startCheck = (t: Snapshot['topics'][number]) => {
    const seq = (checkSeq.current[t.id] ?? 0) + 1;
    checkSeq.current[t.id] = seq;
    topicSeq.current[t.id] = (topicSeq.current[t.id] ?? 0) + 1;
    const busySeq = topicSeq.current[t.id];
    setTopicFlag(t.id, true);
    setChecking((prev) => ({ ...prev, [t.id]: { startedAt: Date.now() } }));
    void (async () => {
      try {
        const outcome = (await api.checkResearchTopicNow(t.id)) as CheckOutcome;
        if (checkSeq.current[t.id] === seq) {
          setLastCheck((prev) => ({ ...prev, [t.id]: outcome }));
          const notice = outcome.run?.error ?? null;
          setRunNotice((prev) => {
            const next = { ...prev };
            if (notice) next[t.id] = notice;
            else delete next[t.id];
            return next;
          });
        }
        await reload();
      } catch (err) {
        if (checkSeq.current[t.id] === seq) setError(`${t.question}：${errMsg(err)}`);
      } finally {
        if (topicSeq.current[t.id] === busySeq) setTopicFlag(t.id, false);
        if (checkSeq.current[t.id] === seq) {
          setChecking((prev) => {
            const next = { ...prev };
            delete next[t.id];
            return next;
          });
        }
      }
    })();
  };

  const askSuggest = () =>
    void act(async () => {
      setSuggested(null);
      setDecided({});
      setSuggestCount((await api.previewWatchDirections()).memoryCount);
    });
  const confirmSuggest = () =>
    void act(async () => {
      setSuggestCount(null);
      setSuggested(await api.suggestWatchDirections());
    });
  const decide = (i: number, follow: boolean) => {
    const d = suggested?.directions[i];
    if (!d) return;
    void act(async () => {
      const { question, publicDescription, relatedGoalId, relatedProjectId } = d;
      if (follow)
        await api.followWatchDirection({
          question,
          publicDescription,
          relatedGoalId,
          relatedProjectId,
        });
      else await api.skipWatchDirection({ question, publicDescription });
      setDecided((prev) => ({ ...prev, [i]: true }));
    });
  };

  const waitFor = (id: string) => {
    const row = checking[id];
    if (!row) return null;
    const elapsed = Math.floor((Date.now() - row.startedAt) / 1000);
    return { elapsed, overdue: elapsed >= 300 };
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
            ? ' 配置了搜索服务后：写了「出门说法」的关注，手动检查会做受控搜索（公开描述经脱敏后外发出门）返回候选；在预批搜索预算内，定时轮次会自动搜索并纳入研读。'
            : ' 无网址的关注可以先记下方向，检查会明确失败，直到在设置页配置搜索入口。'}{' '}
          每轮模型研读上限 8
          次调用（与搜索预算独立，超出走规则研读）。发现是外部线索，不会自动变成你的目标。
        </p>
      </Card>
      <Button kind="primary" disabled={suggestBusy} onClick={askSuggest} testId="research-suggest">
        帮我想想该关注什么
      </Button>
      {suggestCount !== null && (
        <Card title="确认发给模型" testId="research-suggest-confirm">
          <p data-testid="research-suggest-count">
            会把你的 {suggestCount} 条目标、在做的项目、约束（记忆）发给模型，让它提 3–5
            个值得持续关注的方向。
          </p>
          <div className="card-actions">
            <Button
              kind="primary"
              disabled={suggestBusy}
              onClick={confirmSuggest}
              testId="research-suggest-ok"
            >
              好
            </Button>
            <Button
              disabled={suggestBusy}
              onClick={() => setSuggestCount(null)}
              testId="research-suggest-cancel"
            >
              取消
            </Button>
          </div>
        </Card>
      )}
      {(suggested?.directions ?? []).map((d, i) => (
        <Card key={i} title={d.question} testId={`research-direction-${i}`}>
          <p className="muted" data-testid={`research-direction-public-${i}`}>
            对外检索用：{d.publicDescription}
          </p>
          <div data-testid={`research-direction-basis-${i}`}>
            依据：{d.basis.map((b) => b.statement).join('；')}
          </div>
          <p className="muted" data-testid={`research-direction-budget-${i}`}>
            {suggested?.searchConfigured
              ? '每天自动找一次，最多搜 3 次'
              : '每天自动找一次，只看你加的来源'}
          </p>
          {!decided[i] && (
            <div className="card-actions">
              <Button
                kind="primary"
                disabled={suggestBusy}
                onClick={() => decide(i, true)}
                testId={`research-direction-follow-${i}`}
              >
                关注
              </Button>
              <Button
                disabled={suggestBusy}
                onClick={() => decide(i, false)}
                testId={`research-direction-skip-${i}`}
              >
                不关注
              </Button>
            </div>
          )}
        </Card>
      ))}
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
          hint="用于搜索候选：本地脱敏后发给搜索服务找候选网址。研读阶段模型会读取具体研究问题与抓取内容（配置云端模型时即外发模型服务）；不写出门说法则不搜索。"
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
        <Field
          label="定时自主研究预算"
          hint="预批额度内定时轮次会自动搜索候选并由模型研读（无人值守）；不设预算时定时只研读已有来源。"
        >
          <div className="field-row">
            <select
              value={paidBudgetMode}
              onChange={(e) => setPaidBudgetMode(e.target.value as 'none' | 'request_cap')}
              data-testid="research-budget-mode"
            >
              <option value="request_cap">预批搜索次数上限（无人值守自主搜索）</option>
              <option value="none">不预批搜索（仅研读已有来源）</option>
            </select>
            {paidBudgetMode === 'request_cap' && (
              <input
                type="number"
                min="1"
                max="100"
                value={requestCap}
                onChange={(e) => setRequestCap(Number(e.target.value) || 1)}
                style={{ width: 100 }}
                data-testid="research-request-cap"
              />
            )}
          </div>
        </Field>
        <Button
          kind="primary"
          disabled={createBusy || question.trim().length === 0}
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
            {' · '}
            自主搜索预算：
            {t.paid_budget_mode === 'request_cap'
              ? `剩余 ${t.request_cap ?? 0} 次`
              : '未设预批预算'}
          </p>
          <p className="muted">
            上次成功 {t.last_success_at ?? '无'} · 上次失败 {t.last_failure_at ?? '无'}
            {t.last_failure ? `（${t.last_failure}）` : ''}
          </p>
          {t.consecutive_failures >= 3 && (
            <p className="warn">连续失败 {t.consecutive_failures} 次，未把失败写成无变化。</p>
          )}
          {waitFor(t.id) && !waitFor(t.id)!.overdue && (
            <p className="muted" data-testid={`research-checking-${t.id}`}>
              正在检查…（已 {waitFor(t.id)!.elapsed} 秒）
            </p>
          )}
          {waitFor(t.id)?.overdue && (
            <p className="warn" data-testid={`research-checking-${t.id}`}>
              检查还没回来，可能是模型或网络慢；它会在后台继续跑完
            </p>
          )}
          {runNotice[t.id] && (
            <p className="warn" data-testid={`research-run-notice-${t.id}`}>
              {runNotice[t.id]}
            </p>
          )}
          <div className="card-actions">
            <Button
              disabled={!!topicBusy[t.id]}
              onClick={() =>
                topicAct(t, () => api.setResearchTopicEnabled({ id: t.id, enabled: !t.enabled }))
              }
            >
              {t.enabled ? '关闭自动' : '启用自动'}
            </Button>
            <Button
              disabled={!!topicBusy[t.id]}
              onClick={() =>
                topicAct(t, () => api.setResearchTopicPaused({ id: t.id, paused: !t.paused }))
              }
            >
              {t.paused ? '恢复' : '暂停'}
            </Button>
            <Button
              disabled={!!topicBusy[t.id]}
              onClick={() =>
                topicAct(t, () =>
                  api.setResearchBudget({
                    id: t.id,
                    paidBudgetMode: 'request_cap',
                    requestCap: (t.request_cap ?? 0) + 5,
                  }),
                )
              }
            >
              +5 次搜索预算
            </Button>
            <Button
              kind="primary"
              disabled={!!topicBusy[t.id]}
              onClick={() => startCheck(t)}
              testId={`research-check-${t.id}`}
            >
              立即检查
            </Button>
            {waitFor(t.id)?.overdue && (
              <Button onClick={() => stopWaiting(t.id)} testId={`research-stop-waiting-${t.id}`}>
                停止等待
              </Button>
            )}
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
                            disabled={!!topicBusy[t.id]}
                            onClick={() =>
                              topicAct(t, async () => {
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
              disabled={!!topicBusy[t.id]}
              onClick={() =>
                topicAct(t, async () => {
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
                      disabled={!!topicBusy[t.id]}
                      onClick={() =>
                        topicAct(t, () =>
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
                          disabled={!!topicBusy[t.id] || !draftProjectId}
                          onClick={() =>
                            topicAct(t, async () => {
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
