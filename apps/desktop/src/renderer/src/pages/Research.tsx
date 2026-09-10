import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';

interface Snapshot {
  mode: 'approved-sources-only';
  searchConfigured: false;
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

export function ResearchPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [publicDescription, setPublicDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceKind, setSourceKind] = useState<'page' | 'feed'>('page');
  const [extraUrl, setExtraUrl] = useState<Record<string, string>>({});

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

  const create = async () => {
    setBusy(true);
    try {
      await api.createResearchTopic({
        question: question.trim(),
        publicDescription: publicDescription.trim(),
        sources: [{ url: sourceUrl.trim(), kind: sourceKind }],
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
          {data?.notice ?? '当前未配置搜索服务，只检查已批准来源，不是全网搜索。'}
        </p>
        <p className="muted">
          检查成功 =
          这个网址能打开，内容记下来了。有新标题/摘录会出现在下面「发现」；没变化就是还是上次那样。
          发现是外部线索，不会自动变成你的目标。启用自动后大约每 24
          小时再看一次；电脑休眠或退出期间不执行。
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
          label="出门说法（选填）"
          hint="现在检查网页不会带上这句话。只有以后要对外说明「我在盯什么」时才用。不写也行。"
        >
          <input
            value={publicDescription}
            onChange={(e) => setPublicDescription(e.target.value)}
            data-testid="research-public"
            placeholder="可空。例如：关注某开源项目的 Release"
          />
        </Field>
        <Field label="批准来源 URL（仅 HTTPS）">
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            data-testid="research-url"
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
          disabled={busy}
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
              onClick={() => void act(() => api.checkResearchTopicNow(t.id))}
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
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
