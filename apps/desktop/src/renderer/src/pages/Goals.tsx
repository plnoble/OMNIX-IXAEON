import { useCallback, useEffect, useState } from 'react';
import type { GoalSummaryView } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Card, Empty, ErrorBanner } from '../ui.js';

const STATUS: Record<string, string> = {
  proposed: '待你确认',
  active: '进行中',
  paused: '已暂停',
  blocked: '卡住',
  completed: '已完成',
  abandoned: '已放弃',
};

const date = (s: string | null): string => (s ? s.slice(0, 10) : '未安排');
const overdue = (s: string | null): boolean => Boolean(s && new Date(s).getTime() < Date.now());

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'active'
      ? 'badge badge-active'
      : status === 'paused'
        ? 'badge badge-paused'
        : status === 'blocked'
          ? 'badge warn'
          : 'badge';
  return <span className={cls}>{STATUS[status] ?? status}</span>;
}

export function GoalsPage() {
  const [goals, setGoals] = useState<GoalSummaryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setGoals(await api.listGoals());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const proposed = (goals ?? []).filter((g) => g.status === 'proposed');
  const rest = (goals ?? []).filter((g) => g.status !== 'proposed');

  return (
    <div className="page">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="AI 觉得你可能想要的目标（待你确认）" testId="goals-proposed">
        {proposed.length === 0 ? (
          <Empty>没有待确认的目标</Empty>
        ) : (
          proposed.map((g) => (
            <div className="item-row" key={g.id} data-testid={`goal-proposed-${g.id}`}>
              <p className="item-statement">{g.title}</p>
              <span className="badge">待你确认</span>
              {g.watch && (
                <div data-testid={`goal-proposed-watch-${g.id}`}>
                  <span className="badge warn">有疑点</span>
                  {g.watchReason && <p>{g.watchReason}</p>}
                </div>
              )}
            </div>
          ))
        )}
      </Card>

      <Card title="目标" testId="goals-list">
        {goals === null ? (
          <Empty>加载中…</Empty>
        ) : rest.length === 0 ? (
          <Empty>还没有目标</Empty>
        ) : (
          rest.map((g) => {
            const late = overdue(g.nextReviewAt);
            return (
              <div className="item-row" key={g.id} data-testid={`goal-${g.id}`}>
                <header>
                  <p className="item-statement">{g.title}</p>
                  <StatusBadge status={g.status} />
                </header>
                <p data-testid={`goal-progress-${g.id}`}>
                  进度 <progress max={100} value={g.progress} /> {g.progress}% · 子目标{' '}
                  {g.children.length} 个
                </p>
                <p className={late ? 'warn' : undefined} data-testid={`goal-review-${g.id}`}>
                  下次复核：{date(g.nextReviewAt)}
                  {late ? '（已过期）' : ''}
                </p>
                {g.status === 'blocked' && g.blockedReason && (
                  <p className="warn" data-testid={`goal-blocked-${g.id}`}>
                    卡住原因：{g.blockedReason}
                  </p>
                )}
                {g.watch && (
                  <div data-testid={`goal-watch-${g.id}`}>
                    <span className="badge warn">有疑点</span>
                    {g.watchReason && <p>{g.watchReason}</p>}
                  </div>
                )}
                <p data-testid={`goal-next-${g.id}`}>
                  下一步：
                  {g.nextStep ? `${g.nextStep.seq}. ${g.nextStep.title}` : '还没排到可做的步骤'}
                </p>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
