import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Project } from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';
import type { CodingTask } from '@ixaeon/contracts';

const statusLabel: Record<CodingTask['status'], string> = {
  draft: '草案',
  waiting_approval: '等待批准',
  queued: '排队',
  running: '执行中',
  pending_verify: '待验证',
  pending_accept: '待用户接受',
  completed: '完成（未部署）',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态不明',
};

export function TasksPage({ projects }: { projects: Project[] }) {
  const [notice, setNotice] = useState('');
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('note.txt');

  const reload = useCallback(async () => {
    try {
      const snap = await api.listCodingTasks();
      setNotice(snap.notice);
      setTasks(snap.tasks);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  return (
    <div data-testid="page-tasks">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="编码任务" testId="tasks-notice">
        <p className="note">{notice || '加载中…'}</p>
        <p className="muted">
          批准绑定项目、隔离工作区、允许的验证命令。网页/MCP 不能替你批准。接受 ≠ 上线。
        </p>
      </Card>
      <Card title="新建草案">
        {projects.length === 0 ? (
          <p className="muted">先登记一个项目。</p>
        ) : (
          <>
            <Field label="项目">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="任务目标">
              <input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                data-testid="task-goal"
              />
            </Field>
            <Field label="可修改范围（相对工作区，逗号分隔）">
              <input value={scope} onChange={(e) => setScope(e.target.value)} />
            </Field>
            <Button
              kind="primary"
              disabled={busy || !projectId}
              onClick={() =>
                void act(() =>
                  api.createCodingTask({
                    projectId,
                    goal: goal.trim(),
                    scope: scope
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                    allowedCommands: [['node', '-e', 'process.exit(0)']],
                  }),
                )
              }
            >
              创建草案
            </Button>
          </>
        )}
      </Card>
      {tasks.length === 0 && !notice ? <Spinner /> : null}
      {tasks.map((t) => (
        <Card key={t.id} title={t.goal} testId={`task-${t.id}`}>
          <p className="muted">
            {statusLabel[t.status]} · 版本 {t.version}
            {t.verify_status ? ` · 独立验证 ${t.verify_status}` : ''}
            {t.tests_modified ? ' · 测试代码被修改' : ''}
          </p>
          {t.error && <p className="warn">{t.error}</p>}
          {t.verify_output && <pre className="muted">{t.verify_output.slice(0, 400)}</pre>}
          <div className="card-actions">
            {(t.status === 'draft' || t.status === 'waiting_approval') && (
              <Button disabled={busy} onClick={() => void act(() => api.approveCodingTask(t.id))}>
                批准并排队
              </Button>
            )}
            {t.status === 'queued' && (
              <Button
                kind="primary"
                disabled={busy}
                onClick={() => void act(() => api.dispatchCodingTask(t.id))}
              >
                派发（Fake）
              </Button>
            )}
            {t.status === 'pending_accept' && (
              <Button
                kind="primary"
                disabled={busy}
                onClick={() => void act(() => api.acceptCodingTask(t.id))}
              >
                接受结果（不部署）
              </Button>
            )}
            {['queued', 'running', 'waiting_approval', 'draft'].includes(t.status) && (
              <Button
                kind="ghost"
                disabled={busy}
                onClick={() => void act(() => api.cancelCodingTask(t.id))}
              >
                取消
              </Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
