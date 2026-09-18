import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type AppState, type Item } from '../api.js';
import { Button, Card, ErrorBanner, Spinner } from '../ui.js';
import type { ProjectRelation } from '@ixaeon/contracts';

interface OverviewData {
  generatedAt: string;
  goals: Item[];
  constraints: Item[];
  unknowns: Item[];
  conflicts: Item[];
  /** E1：看起来已经结束的事（内容里的日期已过、你还没表态）。 */
  pastSuggestions: Array<{ item: Item; day: string }>;
  pastSources: Array<{
    sourceId: string;
    title: string;
    lastDay: string;
    pastItems: number;
    totalItems: number;
  }>;
  projects: Array<{ project: { id: string; name: string }; goals: Item[]; constraints: Item[] }>;
  relations: ProjectRelation[];
  researchFollowUps: Array<{
    id: string;
    title: string;
    url: string;
    excerpt: string;
    action_reason: string | null;
    related_project_id: string | null;
  }>;
  coverage: {
    projectCount: number;
    analyzedSources: number;
    unanalyzedSources: number;
    unassignedItems: number;
  };
}

const kindLabel: Record<ProjectRelation['kind'], string> = {
  serves_goal: '服务于目标',
  depends_on: '依赖',
  provides_capability: '可提供能力',
  reusable: '可复用',
  suspected_duplicate: '疑似重复',
  conflict: '冲突',
};

const statusLabel: Record<ProjectRelation['status'], string> = {
  proposed: '提案',
  accepted: '已接受（未等于已联通）',
  rejected: '不采纳',
  superseded: '已替代',
};

function ItemList({ items }: { items: Item[] }) {
  if (items.length === 0) return <p className="muted">暂无</p>;
  return (
    <ul>
      {items.slice(0, 8).map((i) => (
        <li key={i.id}>
          {i.statement}
          {i.confirmation === 'none' ? '（待确认）' : ''}
          {i.state === 'disputed' ? '（冲突）' : ''}
        </li>
      ))}
    </ul>
  );
}

/**
 * E1：看起来已经结束的事。按内容里写的日期判断（条目时间戳是导入分析的日期，不是
 * 事情发生的日期），所以可能认错——每条都让你一键确认或纠正，确认过的不再出现。
 */
function PastSuggestions({
  suggestions,
  sources,
  onChanged,
}: {
  suggestions: Array<{ item: Item; day: string }>;
  sources: OverviewData['pastSources'];
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (suggestions.length === 0 && sources.length === 0) return <p className="muted">暂无</p>;
  // 整份资料归档：那份资料的提炼结果退出「当前记忆」，只留一段经验摘要；可在「资料」页恢复
  const archive = async (sourceId: string) => {
    setPending(sourceId);
    setError(null);
    try {
      await api.archiveSource({ sourceId, summary: null });
      await onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setPending(null);
    }
  };
  const mark = async (id: string, status: 'ongoing' | 'ended') => {
    setPending(id);
    setError(null);
    try {
      await api.setItemTimeStatus({ id, status });
      await onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <>
      {error && <p className="warn">{error}</p>}
      {sources.map((src) => (
        <p key={src.sourceId} data-testid="overview-past-source">
          《{src.title}》里写了日期的 {src.pastItems} 件事都已过去（最晚 {src.lastDay}），
          这份资料共 {src.totalItems} 条记忆，有些没写日期但说的是同一件事。{' '}
          <Button
            kind="ghost"
            disabled={pending === src.sourceId}
            onClick={() => void archive(src.sourceId)}
            testId="overview-past-archive"
          >
            整份归档为过往的事
          </Button>
          <span className="muted">（可在「资料」页恢复）</span>
        </p>
      ))}
      <ul>
        {suggestions.map(({ item, day }) => (
          <li key={item.id} data-testid="overview-past-item">
            {item.statement}
            <span className="muted">（内容里的日期 {day} 已过）</span>{' '}
            <Button
              kind="ghost"
              disabled={pending === item.id}
              onClick={() => void mark(item.id, 'ended')}
              testId="overview-past-ended"
            >
              确认已结束
            </Button>
            <Button
              kind="ghost"
              disabled={pending === item.id}
              onClick={() => void mark(item.id, 'ongoing')}
              testId="overview-past-ongoing"
            >
              还没结束
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PersonalOverviewPage({ state }: { state: AppState }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData((await api.getPersonalOverview()) as OverviewData);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const propose = async () => {
    setBusy(true);
    try {
      await api.proposeProjectRelations();
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, kind: 'accept' | 'reject') => {
    setBusy(true);
    try {
      if (kind === 'accept') await api.acceptProjectRelation(id);
      else await api.rejectProjectRelation(id);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data && !error) return <Spinner />;

  return (
    <div data-testid="page-overview">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="个人视角" testId="personal-overview">
        <p className="note">
          不要求先建项目。这里回答：你目前想做什么、各项目服务哪些目标、有没有重复建设。
          「不确定」只列冲突和需要拍板的决定，不是把每条提取当成作业。接受关系不等于接口已经联通。
        </p>
        <p className="muted" data-testid="overview-coverage">
          生成于 {data?.generatedAt.slice(0, 19).replace('T', ' ')} · 项目{' '}
          {data?.coverage.projectCount} · 已分析来源 {data?.coverage.analyzedSources} · 未分析{' '}
          {data?.coverage.unanalyzedSources} · 未整理 {data?.coverage.unassignedItems}
        </p>
        <p className="muted">
          数据目录 {state.dataDir} ·{' '}
          {state.serverRunning ? `本地服务 127.0.0.1:${state.serverPort}` : '本地服务未运行'}
        </p>
      </Card>
      <Card title="我想做什么" testId="overview-goals">
        <ItemList items={data?.goals ?? []} />
      </Card>
      <Card title="看起来已经结束的事" testId="overview-past">
        <p className="muted">
          这些事内容里写的日期已经过去。聊天时它们不会再被当成眼下在忙的事，问到时仍能查到（当作历史）。
        </p>
        <PastSuggestions
          suggestions={data?.pastSuggestions ?? []}
          sources={data?.pastSources ?? []}
          onChanged={reload}
        />
      </Card>
      <Card title="约束" testId="overview-constraints">
        <ItemList items={data?.constraints ?? []} />
      </Card>
      <Card title="需要你拍板" testId="overview-unknowns">
        <ItemList items={data?.unknowns ?? []} />
      </Card>
      <Card title="冲突" testId="overview-conflicts">
        <ItemList items={data?.conflicts ?? []} />
      </Card>
      <Card title="研究里你标过值得行动" testId="overview-research-followups">
        {(data?.researchFollowUps ?? []).length === 0 ? (
          <p className="muted">没有。检查成功不会自动变成目标；要跟进请在研究页自己标。</p>
        ) : (
          <ul>
            {(data?.researchFollowUps ?? []).map((f) => (
              <li key={f.id}>
                <a href={f.url} target="_blank" rel="noreferrer">
                  {f.title}
                </a>
                {f.action_reason ? <span className="muted"> · {f.action_reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="各项目服务的目标" testId="overview-projects">
        {(data?.projects ?? []).length === 0 ? (
          <p className="muted">还没有项目。构想也可以先登记。</p>
        ) : (
          <ul>
            {(data?.projects ?? []).map((p) => (
              <li key={p.project.id}>
                <strong>{p.project.name}</strong>
                <ItemList items={p.goals} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card
        title="跨项目提案"
        testId="overview-relations"
        actions={
          <Button disabled={busy} onClick={() => void propose()} testId="overview-propose">
            生成候选关系
          </Button>
        }
      >
        <p className="note">不靠项目名硬编码，不自动移动资料。没有足够证据时不会强行连接。</p>
        {(data?.relations ?? []).length === 0 ? (
          <p className="muted">暂无提案。</p>
        ) : (
          <ul data-testid="overview-relation-list">
            {(data?.relations ?? []).map((r) => (
              <li key={r.id} data-testid={`relation-${r.id}`}>
                <span className="badge">{kindLabel[r.kind]}</span>{' '}
                <span className="badge">{statusLabel[r.status]}</span>
                {r.stale ? <span className="badge badge-paused">待复核</span> : null} {r.rationale}
                {r.status === 'proposed' && !r.stale && (
                  <>
                    <Button kind="ghost" disabled={busy} onClick={() => void act(r.id, 'accept')}>
                      确认
                    </Button>
                    <Button kind="ghost" disabled={busy} onClick={() => void act(r.id, 'reject')}>
                      不采纳
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
