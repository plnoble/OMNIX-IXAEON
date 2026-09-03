import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Project } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Field, projectStatusLabel, Spinner } from '../ui.js';

/** 项目页：列表 + 新建 + 目录登记 + 状态切换。 */
export function ProjectsPage({ onOpenSources }: { onOpenSources: (projectId: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });

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
      });
      setForm({ name: '', description: '' });
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
          <Empty>还没有项目。新建一个项目，开始导入资料。</Empty>
        ) : (
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id} className="project-row" data-testid={`project-row-${p.id}`}>
                <div className="project-main">
                  <strong>{p.name}</strong>
                  <span className={`badge badge-${p.status}`}>{projectStatusLabel(p.status)}</span>
                  <span className="muted">{p.root_path ?? '未绑定目录'}</span>
                </div>
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
