import { useEffect, useState } from 'react';
import type { GoalDetailView, GoalSummaryView } from '@ixaeon/contracts';
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
const STEP: Record<string, string> = {
  pending: '待做',
  doing: '进行中',
  done: '做完',
  skipped: '跳过',
  blocked: '卡住',
};
const EVENT: Record<string, string> = {
  created: '建立',
  confirmed: '确认',
  status: '状态',
  progress: '进度',
  plan: '方案',
  step: '步骤',
  task_done: '任务完成',
  task_failed: '任务失败',
  watch: '疑点',
  note: '备注',
};
const ACTOR: Record<string, string> = { user: '用户', agent: '模型', system: '系统' };
const LINK: Record<string, string> = {
  todo: '待办',
  coding_task: '编码任务',
  research_topic: '研究话题',
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

type DetailProps = { goal: GoalDetailView; onBack: () => void; onOpen: (id: string) => void };

function GoalDetail({ goal, onBack, onOpen }: DetailProps) {
  const current = goal.plans.find((p) => p.status === 'current');
  return (
    <Card
      title={goal.title}
      actions={
        <button type="button" className="btn btn-ghost" data-testid="goal-back" onClick={onBack}>
          返回列表
        </button>
      }
    >
      <div data-testid="goal-detail">
        <p>
          <StatusBadge status={goal.status} /> 进度 {goal.progress}%
        </p>
        <p data-testid="goal-detail-description">{goal.description || '（没有描述）'}</p>
        <section data-testid="goal-detail-children">
          <h3>子目标</h3>
          {goal.children.length === 0 ? (
            <Empty>没有子目标</Empty>
          ) : (
            goal.children.map((c) => (
              <button
                key={c.id}
                type="button"
                className="btn btn-ghost"
                data-testid={`goal-child-${c.id}`}
                onClick={() => onOpen(c.id)}
              >
                {c.title} · {STATUS[c.status] ?? c.status} · {c.progress}%
              </button>
            ))
          )}
        </section>
        <section data-testid="goal-detail-steps">
          <h3>当前方案{current ? ` v${current.version}` : ''}</h3>
          {current && current.steps.length > 0 ? (
            current.steps.map((s) => (
              <div className="item-row" key={s.id} data-testid={`goal-step-${s.id}`}>
                <p>
                  {s.seq}. {s.title} · {STEP[s.status] ?? s.status}
                </p>
                {s.linkedTitle && (
                  <p>
                    关联：{LINK[s.linkedKind ?? ''] ?? s.linkedKind} · {s.linkedTitle} ·{' '}
                    {s.linkedStatus}
                  </p>
                )}
              </div>
            ))
          ) : (
            <Empty>还没有方案</Empty>
          )}
        </section>
        <section data-testid="goal-detail-history">
          <h3>方案历史</h3>
          {goal.plans.length === 0 ? (
            <Empty>没有方案历史</Empty>
          ) : (
            goal.plans.map((p) => (
              <div className="item-row" key={p.version} data-testid={`goal-plan-${p.version}`}>
                <p>
                  v{p.version} ·{' '}
                  {p.status === 'current'
                    ? '当前'
                    : p.status === 'superseded'
                      ? '已被取代'
                      : '已放弃'}{' '}
                  · {date(p.createdAt)}
                </p>
                <p>{p.reason}</p>
                <p>{p.steps.map((s) => `${s.seq}. ${s.title}`).join('；') || '没有步骤'}</p>
              </div>
            ))
          )}
        </section>
        <section data-testid="goal-detail-links">
          <h3>关联任务</h3>
          {goal.links.length === 0 ? (
            <Empty>没有关联任务</Empty>
          ) : (
            goal.links.map((l) => (
              <p
                className="item-row"
                key={`${l.kind}:${l.refId}`}
                data-testid={`goal-link-${l.refId}`}
              >
                {LINK[l.kind] ?? l.kind} · {l.title} · {l.status}
              </p>
            ))
          )}
        </section>
        <section data-testid="goal-detail-events">
          <h3>事件时间线</h3>
          {goal.events.length === 0 ? (
            <Empty>还没有事件</Empty>
          ) : (
            goal.events.map((e) => (
              <p className="item-row" key={e.id} data-testid={`goal-event-${e.id}`}>
                {date(e.at)} · {EVENT[e.kind] ?? e.kind} · {ACTOR[e.decidedBy] ?? e.decidedBy}
                {e.summary !== e.kind ? `：${e.summary}` : ''}
              </p>
            ))
          )}
        </section>
      </div>
    </Card>
  );
}

export function GoalsPage() {
  const [goals, setGoals] = useState<GoalSummaryView[] | null>(null);
  const [detail, setDetail] = useState<GoalDetailView | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listGoals()
      .then(setGoals)
      .catch((err) => setError(errMsg(err)));
  }, []);

  const open = async (id: string): Promise<void> => {
    setOpenId(id);
    setDetail(null);
    try {
      setDetail(await api.getGoalDetail(id));
    } catch (err) {
      setError(errMsg(err));
      setOpenId(null);
    }
  };

  if (openId) {
    return (
      <div className="page">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {detail ? (
          <GoalDetail
            goal={detail}
            onBack={() => {
              setOpenId(null);
              setDetail(null);
            }}
            onOpen={(id) => void open(id)}
          />
        ) : (
          <Empty>加载中…</Empty>
        )}
      </div>
    );
  }

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
              <div
                className="item-row"
                key={g.id}
                role="button"
                tabIndex={0}
                data-testid={`goal-${g.id}`}
                onClick={() => void open(g.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  void open(g.id);
                }}
              >
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
