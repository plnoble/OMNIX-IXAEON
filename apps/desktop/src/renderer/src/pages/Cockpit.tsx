import { useCallback, useEffect, useState } from 'react';
import type { AttentionItem, CockpitSnapshot, ProjectCard, SourceHealth } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Spinner, projectStatusLabel } from '../ui.js';

/** K3：驾驶舱（规格 docs/委派/K3-驾驶舱页面.md）。只读 K2 的快照；项目区是 K3b。 */

const SOURCE_ORDER = ['relay', 'queue', 'projects'] as const;
const SOURCE_LABEL: Record<(typeof SOURCE_ORDER)[number], string> = {
  relay: '调度器',
  queue: '队列',
  projects: '项目',
};

const ATTENTION_LABEL: Record<AttentionItem['kind'], string> = {
  relay_down: '调度器不在',
  turn_unfinished: '上一棒没跑完',
  relay_stale: '可能停了',
  relay_stopped: '调度器停了',
  queue_user: '等你拍板',
};
/** 规格第 3 条：这三类要用户处理的事用红色。 */
const ATTENTION_RED = new Set<AttentionItem['kind']>([
  'relay_down',
  'turn_unfinished',
  'relay_stale',
]);

const OUTCOME_LABEL = {
  done: '完成',
  failed: '失败',
  timeout: '超时',
  quota: '额度',
  other: '其他',
} as const;

const pad = (n: number): string => String(n).padStart(2, '0');
/** 本地时间 HH:MM。 */
const hhmm = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 本地时间，同一天只给 HH:MM，跨天再带月日。 */
const timeOf = (iso: string | null, now: number): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const t = new Date(now);
  const sameDay =
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate();
  return sameDay ? hhmm(iso) : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(iso)}`;
};
const minutesSince = (iso: string | null, now: number): number | null => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60_000));
};

/** 没有「没设仓库路径」这一种写成规格里的短句；其余照来源给的 note。 */
function sourceReason(key: string, h: SourceHealth): string {
  if (key === 'queue' && h.status === 'missing' && (h.note ?? '').includes('IXAEON 仓库路径'))
    return '没设仓库路径';
  return h.note ?? (h.status === 'stale' ? '数据可能停了' : '读取失败');
}

function ProjectBox({
  p,
  onStatus,
}: {
  p: ProjectCard;
  onStatus: (p: ProjectCard, status: 'active' | 'paused' | 'archived') => void;
}) {
  return (
    <li className="project-row" data-testid={`cockpit-project-card-${p.id}`} data-status={p.status}>
      <div className="project-main">
        <strong>{p.name}</strong>
        <span className={`badge badge-${p.status}`}>{projectStatusLabel(p.status)}</span>
        {p.description && <span className="muted">{p.description}</span>}
        {p.currentState && (
          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
            当前：{p.currentState}
          </span>
        )}
      </div>
      <div className="project-actions">
        {p.status !== 'active' && (
          <Button
            kind="ghost"
            onClick={() => onStatus(p, 'active')}
            testId={`cockpit-project-resume-${p.id}`}
          >
            恢复
          </Button>
        )}
        {p.status === 'active' && (
          <Button
            kind="ghost"
            onClick={() => onStatus(p, 'paused')}
            testId={`cockpit-project-pause-${p.id}`}
          >
            暂缓
          </Button>
        )}
        {p.status !== 'archived' && (
          <Button
            kind="ghost"
            onClick={() => onStatus(p, 'archived')}
            testId={`cockpit-project-archive-${p.id}`}
          >
            放弃
          </Button>
        )}
      </div>
    </li>
  );
}

export function CockpitPage() {
  const [snap, setSnap] = useState<CockpitSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPaused, setOpenPaused] = useState(false);
  const [openArchived, setOpenArchived] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnap(await api.getCockpitSnapshot());
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  // 每 60 秒自己刷新一次；离开页面就停。
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const setStatus = async (p: ProjectCard, status: 'active' | 'paused' | 'archived') => {
    try {
      await api.updateProjectStatus({ id: p.id, status });
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  if (!snap)
    return (
      <div data-testid="page-cockpit">{error ? <ErrorBanner message={error} /> : <Spinner />}</div>
    );

  const now = Date.now();
  const bad = SOURCE_ORDER.filter((k) => snap.sources[k].status !== 'ok');
  const readAts = SOURCE_ORDER.map((k) => Date.parse(snap.sources[k].readAt)).filter((t) =>
    Number.isFinite(t),
  );
  const oldest = readAts.length > 0 ? Math.min(...readAts) : null;
  const ago = oldest === null ? null : Math.max(0, Math.floor((now - oldest) / 60_000));
  const runningCount = snap.running.filter((r) => r.kind === 'relay' || r.kind === 'turn').length;
  const { active, paused, archived } = snap.projects;
  const totalProjects = active.length + paused.length + archived.length;

  return (
    <div data-testid="page-cockpit">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="card-header" style={{ marginBottom: 12 }}>
        <h2>驾驶舱</h2>
        <div className="card-actions">
          <Button kind="ghost" onClick={() => void load()} testId="cockpit-refresh">
            刷新
          </Button>
        </div>
        <p
          className={bad.length > 0 ? 'warn' : 'muted'}
          data-testid="cockpit-updated"
          style={{ margin: 0 }}
        >
          {ago === null ? '更新时间未知' : `${ago} 分钟前更新`}
        </p>
      </div>

      {bad.length > 0 && (
        <div className="warn" data-testid="cockpit-sources-warning">
          有来源不正常：
          <ul>
            {bad.map((k) => (
              <li key={k} data-testid={`cockpit-source-${k}`}>
                {SOURCE_LABEL[k]}：{sourceReason(k, snap.sources[k])}
                <span className="muted">（{k}）</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cockpit-stats">
        <div data-testid="cockpit-count-attention">
          <strong>{snap.attention.length}</strong>
          <span>等你处理</span>
        </div>
        <div data-testid="cockpit-count-running">
          <strong>{runningCount}</strong>
          <span>正在运行</span>
        </div>
        <div data-testid="cockpit-count-today">
          <strong>{snap.today.finishedTurns}</strong>
          <span>今天完成</span>
        </div>
        <div className="muted" data-testid="cockpit-quota-placeholder">
          额度：等 K4
        </div>
      </div>

      <Card title="等你处理" testId="cockpit-attention">
        {snap.attention.length === 0 ? (
          <Empty testId="cockpit-attention-empty">现在没有等你处理的事。</Empty>
        ) : (
          <ul className="work-run-list">
            {snap.attention.map((a, i) => (
              <li
                key={`${a.kind}-${i}`}
                className={ATTENTION_RED.has(a.kind) ? 'work-run warn' : 'work-run'}
                data-testid="cockpit-attention-item"
              >
                <span className="badge">{ATTENTION_LABEL[a.kind]}</span>
                {a.project && <span className="muted">{a.project}</span>}
                <span>{a.text}</span>
                <span className="muted">{timeOf(a.since, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="正在运行" testId="cockpit-running">
        {snap.running.length === 0 ? (
          <Empty testId="cockpit-running-empty">现在没有在跑的任务。</Empty>
        ) : (
          <ul className="work-run-list">
            {snap.running.map((r, i) => {
              const mins = minutesSince(r.startedAt, now);
              return (
                <li key={`${r.kind}-${i}`} className="work-run" data-testid="cockpit-running-item">
                  {r.kind !== 'relay' && (
                    <span className="badge">{r.kind === 'turn' ? '这一棒' : '额度暂停'}</span>
                  )}
                  {r.kind !== 'relay' && <strong>{r.role ?? '—'}</strong>}
                  {r.taskId && <span className="muted">任务 {r.taskId}</span>}
                  <span className="muted">
                    {r.kind === 'relay'
                      ? r.text
                      : r.kind === 'paused_role'
                        ? `额度暂停到 ${hhmm(r.until)}`
                        : mins === null
                          ? ''
                          : `已跑 ${mins} 分钟`}
                  </span>
                  {r.kind === 'turn' && <span className="muted">{r.text}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="项目" testId="cockpit-projects">
        {totalProjects === 0 ? (
          <Empty testId="cockpit-projects-empty">现在没有项目。</Empty>
        ) : (
          <>
            <h3>进行中</h3>
            {active.length === 0 ? (
              <p className="muted">没有进行中的项目。</p>
            ) : (
              <ul className="project-list">
                {active.map((p) => (
                  <ProjectBox key={p.id} p={p} onStatus={(x, s) => void setStatus(x, s)} />
                ))}
              </ul>
            )}
            <button
              type="button"
              className="nav-item"
              data-testid="cockpit-group-paused"
              onClick={() => setOpenPaused(!openPaused)}
            >
              暂缓（{paused.length}）
            </button>
            {openPaused && (
              <ul className="project-list">
                {paused.map((p) => (
                  <ProjectBox key={p.id} p={p} onStatus={(x, s) => void setStatus(x, s)} />
                ))}
              </ul>
            )}
            <button
              type="button"
              className="nav-item"
              data-testid="cockpit-group-archived"
              onClick={() => setOpenArchived(!openArchived)}
            >
              放弃（{archived.length}）
            </button>
            {openArchived && (
              <ul className="project-list">
                {archived.map((p) => (
                  <ProjectBox key={p.id} p={p} onStatus={(x, s) => void setStatus(x, s)} />
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card title="最近动态" testId="cockpit-recent">
        {snap.recent.length === 0 ? (
          <Empty testId="cockpit-recent-empty">还没有最近动态。</Empty>
        ) : (
          <ul className="work-run-list">
            {snap.recent.slice(0, 20).map((r, i) => (
              <li key={`${r.at}-${i}`} className="work-run" data-testid="cockpit-recent-item">
                <span className="muted">{timeOf(r.at, now)}</span>
                <span>{r.role}</span>
                {r.taskId && <span className="muted">{r.taskId}</span>}
                <span className="badge">{OUTCOME_LABEL[r.outcome]}</span>
                <span className="muted">{r.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
