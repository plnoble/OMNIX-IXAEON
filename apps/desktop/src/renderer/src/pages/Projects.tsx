import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Project, type WorkRun } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Field, projectStatusLabel, Spinner } from '../ui.js';

type WorkTest = { name: string; result: 'passed' | 'failed' | 'not_run' };

function parseWorkJson<T>(json: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(json ?? '') as T;
  } catch {
    return fallback;
  }
}

const testResultLabel: Record<WorkTest['result'], string> = {
  passed: '通过',
  failed: '失败',
  not_run: '未运行',
};

/** 单条工作记录：摘要行 + 可展开详情（RF06：失败测试/未完成事项必须在界面可见）。 */
function WorkRunRow({ run }: { run: WorkRun }) {
  const [open, setOpen] = useState(false);
  const tests = parseWorkJson<WorkTest[]>(run.tests_json, []);
  const loops = parseWorkJson<string[]>(run.open_loops_json, []);
  const changes = parseWorkJson<string[]>(run.changes_json, []);
  const failedTests = tests.filter((t) => t.result === 'failed');

  return (
    <li className="work-run" data-testid={`work-run-${run.id}`}>
      <span
        className={`badge badge-${run.outcome === 'success' ? 'active' : run.outcome === 'failed' ? 'paused' : 'muted'}`}
      >
        {run.outcome === 'success' ? '成功' : run.outcome === 'failed' ? '失败' : '部分完成'}
      </span>
      <strong>{run.task}</strong>
      <span className="muted">{run.agent_name}</span>
      <span className="muted">{run.finished_at.slice(0, 19).replace('T', ' ')}</span>
      <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>
        {run.summary.slice(0, 200)}
      </p>
      {/* RF06：失败测试与未完成事项不再只藏在数据库里 —— 摘要行直接点名，展开看全量 */}
      {(failedTests.length > 0 || loops.length > 0) && (
        <p style={{ fontSize: 12, margin: '4px 0 0' }}>
          {failedTests.length > 0 && (
            <span className="badge badge-paused">
              失败测试 {failedTests.length}：{failedTests.map((t) => t.name).join('、')}
            </span>
          )}{' '}
          {loops.length > 0 && (
            <span className="badge badge-muted">
              未完成事项 {loops.length}：{loops.join('、')}
            </span>
          )}
        </p>
      )}
      <Button kind="ghost" onClick={() => setOpen(!open)} testId={`work-run-toggle-${run.id}`}>
        {open ? '收起详情' : '展开详情'}
      </Button>
      {open && (
        <div className="work-run-detail" data-testid={`work-run-detail-${run.id}`}>
          {changes.length > 0 && (
            <p className="muted" style={{ fontSize: 12 }}>
              变更摘要：{changes.join('；')}
            </p>
          )}
          <p className="muted" style={{ fontSize: 12 }}>
            测试（{tests.length} 项）：
            {tests.length === 0
              ? '未记录'
              : tests.map((t) => `${t.name}=${testResultLabel[t.result]}`).join('、')}
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            未完成事项：
            {loops.length === 0 ? '无' : loops.map((l) => `${l}（待用户确认）`).join('；')}
          </p>
        </div>
      )}
    </li>
  );
}

/** 单个项目的最近工作记录（C10：agent 回写接入用户界面）。 */
function ProjectWorkRuns({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<WorkRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api
      .listWorkRuns({ projectId, limit: 5 })
      .then((r) => {
        if (alive) setRuns(r);
      })
      .catch((err) => {
        // RF06：加载失败如实显示，不悄悄伪装成「暂无记录」
        if (alive) setError(errMsg(err));
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (runs === null && !error) return null;
  if (error) {
    return (
      <p
        className="error-text"
        style={{ fontSize: 12 }}
        data-testid={`project-work-error-${projectId}`}
      >
        最近工作加载失败：{error}
      </p>
    );
  }
  if (runs!.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12 }}>
        最近工作：暂无编码 agent 回写记录。
      </p>
    );
  }
  return (
    <div className="project-work" data-testid={`project-work-${projectId}`}>
      <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        最近工作（agent 自报，用户尚未验收 ≠ 用户决定）：
      </p>
      <ul className="work-run-list">
        {runs!.map((w) => (
          <WorkRunRow key={w.id} run={w} />
        ))}
      </ul>
    </div>
  );
}

/** 项目页：列表 + 新建 + 目录登记 + 状态切换。 */
export function ProjectsPage({ onOpenSources }: { onOpenSources: (projectId: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    purpose: '',
    currentState: '',
    unknowns: '',
  });

  const reload = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    if (form.name.trim().length === 0) {
      setError('项目名不能为空');
      return;
    }
    setBusy(true);
    try {
      await api.createProject({
        name: form.name.trim(),
        rootPath: null,
        description: form.description.trim() || null,
        purpose: form.purpose.trim() || null,
        currentState: form.currentState.trim() || null,
        unknowns: form.unknowns.trim() || null,
      });
      setForm({ name: '', description: '', purpose: '', currentState: '', unknowns: '' });
      setCreating(false);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (p: Project, status: Project['status']) => {
    setBusy(true);
    try {
      await api.updateProjectStatus({ id: p.id, status });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="page-projects">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card
        title="项目"
        testId="projects-card"
        actions={
          <Button kind="primary" onClick={() => setCreating(!creating)} testId="projects-new">
            新建项目
          </Button>
        }
      >
        {creating && (
          <div className="form-area" data-testid="project-form">
            <Field label="名称">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="project-form-name"
              />
            </Field>
            <Field label="描述（可选）">
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            <Field label="目的（可选，无目录的构想也可登记）">
              <input
                value={form.purpose}
                onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                data-testid="project-form-purpose"
              />
            </Field>
            <Field label="当前状态（可选）">
              <input
                value={form.currentState}
                onChange={(e) => setForm({ ...form, currentState: e.target.value })}
              />
            </Field>
            <Field label="未知项（可选）">
              <input
                value={form.unknowns}
                onChange={(e) => setForm({ ...form, unknowns: e.target.value })}
              />
            </Field>
            <div className="wizard-nav">
              <Button onClick={() => setCreating(false)}>取消</Button>
              <Button kind="primary" disabled={busy} onClick={create} testId="project-form-save">
                保存
              </Button>
            </div>
          </div>
        )}

        {projects === null ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <Empty>
            还没有项目。可以登记有目录的项目，也可以只登记构想（不强迫创建文件夹）。导入授权只读，不授予执行权。
          </Empty>
        ) : (
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id} className="project-row" data-testid={`project-row-${p.id}`}>
                <div className="project-main">
                  <strong>{p.name}</strong>
                  <span className={`badge badge-${p.status}`}>{projectStatusLabel(p.status)}</span>
                  <span className="muted">{p.root_path ?? '构想（未绑定目录）'}</span>
                  {p.purpose && (
                    <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                      目的：{p.purpose}
                    </span>
                  )}
                </div>
                <ProjectWorkRuns projectId={p.id} />
                <div className="project-actions">
                  <Button
                    onClick={() => onOpenSources(p.id)}
                    testId={`project-open-sources-${p.id}`}
                  >
                    查看来源
                  </Button>
                  {p.status === 'active' && (
                    <Button kind="ghost" disabled={busy} onClick={() => setStatus(p, 'paused')}>
                      暂停
                    </Button>
                  )}
                  {p.status !== 'archived' && (
                    <Button kind="ghost" disabled={busy} onClick={() => setStatus(p, 'archived')}>
                      归档
                    </Button>
                  )}
                  {p.status === 'archived' && (
                    <Button kind="ghost" disabled={busy} onClick={() => setStatus(p, 'active')}>
                      恢复
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
