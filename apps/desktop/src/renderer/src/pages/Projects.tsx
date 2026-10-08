import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Project, type WorkRun } from '../api.js';
import type { UnbindProjectFolderPreview } from '@ixaeon/contracts';
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

function toResult(v: unknown): WorkTest['result'] {
  return v === 'passed' || v === 'failed' ? v : 'not_run';
}

/**
 * tests_json 有两种写入方，形状不同：
 * - record_work_result（外部编码工具）写 [{ name, result }]；
 * - 编码任务执行器写 { verify_status, verify_exit_code }（skills.ts 靠它取退出码，不能改写）。
 * 界面两种都认；认不出的形状当作没有测试记录。
 * 2026-09-18 真机：唯一一条工作记录是后一种，`tests.filter is not a function`
 * 让整个项目页崩掉（9-17 用户看到的黑屏很可能就是它）。
 */
export function parseWorkTests(json: string | null | undefined): WorkTest[] {
  const v = parseWorkJson<unknown>(json, null);
  if (Array.isArray(v)) {
    return v
      .filter((t): t is { name: unknown; result: unknown } => !!t && typeof t === 'object')
      .map((t) => ({ name: String(t.name ?? '未命名'), result: toResult(t.result) }));
  }
  if (v && typeof v === 'object' && 'verify_status' in v) {
    const s = v as { verify_status?: unknown; verify_exit_code?: unknown };
    const code = typeof s.verify_exit_code === 'number' ? `（退出码 ${s.verify_exit_code}）` : '';
    return [{ name: `独立验证${code}`, result: toResult(s.verify_status) }];
  }
  return [];
}

export function parseWorkStrings(json: string | null | undefined): string[] {
  const v = parseWorkJson<unknown>(json, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 单条工作记录：摘要行 + 可展开详情（RF06：失败测试/未完成事项必须在界面可见）。 */
function WorkRunRow({ run }: { run: WorkRun }) {
  const [open, setOpen] = useState(false);
  const tests = parseWorkTests(run.tests_json);
  const loops = parseWorkStrings(run.open_loops_json);
  const changes = parseWorkStrings(run.changes_json);
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

/** P5：确认框整段文字照契约 7；带数字的三行数字是 0 就不出现；讲授权的那一行三选一。 */
function unbindConfirmText(p: Project, v: UnbindProjectFolderPreview): string {
  const grantLine =
    v.grant === 'revoke'
      ? '- 这个文件夹的读取授权一并撤销。'
      : v.grant === 'kept_other_project'
        ? '- 读取授权不撤销：另一个项目也绑着这个文件夹。'
        : '- 这个文件夹没有单独的读取授权，没有可撤销的。';
  const lines = [
    `解除「${p.name}」和这个文件夹的绑定？`,
    '',
    v.rootPath,
    '',
    '解除之后：',
    '- IXAEON 不再读这个文件夹：不能再给这个项目派编码任务，对话里也不再带这个文件夹的项目近况。',
    grantLine,
  ];
  if (v.sourcesUnderGrant > 0) {
    lines.push(
      `- 这条授权下导入过 ${v.sourcesUnderGrant} 份资料：不再读它们的原文，已经提炼出的理解保留。重新绑定也恢复不了，要再用得重新导入。`,
    );
  }
  if (v.inFlightTasks > 0) {
    lines.push(`- 有 ${v.inFlightTasks} 个编码任务正在排队或执行，会被取消。`);
  }
  if (v.pendingAcceptTasks > 0) {
    lines.push(
      `- 有 ${v.pendingAcceptTasks} 个任务做完了还没接受：解除之后再点接受，改动落不到项目里。可以先去任务页接受，或者之后重新绑定再接受。`,
    );
  }
  lines.push(
    '',
    '已经做完的任务、它们的隔离副本（里面有当时的项目文件）和已有的记忆都不动。要清掉副本，在任务页逐个删除任务。',
  );
  return lines.join('\n');
}

/** 项目页：列表 + 新建 + 目录登记 + 状态切换。 */
export function ProjectsPage({
  onOpenSources,
  onChanged,
}: {
  onOpenSources: (projectId: string) => void;
  onChanged?: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unbindResult, setUnbindResult] = useState<string | null>(null);
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

  const bindFolder = async (projectId: string) => {
    setBusy(true);
    try {
      // 只传一次性目录票据；渲染层不直接给路径（P4 契约 2/条件 7）
      const picked = await api.pickFiles('directory');
      if (!picked || picked.ticket === undefined) return;
      await api.bindProjectFolder({ ticket: picked.ticket, projectId });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  /** P5：先预览、问一次确认，确认了才解除。出错（预览或解除）都显示在整页报错条里，项目行不变。 */
  const unbindFolder = async (p: Project) => {
    setBusy(true);
    try {
      const preview = await api.previewUnbindProjectFolder(p.id);
      const ok = window.confirm(unbindConfirmText(p, preview));
      if (!ok) return;
      const done = await api.unbindProjectFolder(p.id);
      // 项目行马上变成没绑的样子（直接用返回的项目，不动别的行）
      setProjects((rows) => rows?.map((row) => (row.id === p.id ? done.project : row)) ?? null);
      const parts = [
        '已解除绑定。',
        done.revokedPermissionId !== null ? '这个文件夹的读取授权已撤销。' : '读取授权没有撤销。',
      ];
      if (done.cancelledTaskIds.length > 0) {
        parts.push(`取消了 ${done.cancelledTaskIds.length} 个编码任务。`);
      }
      setUnbindResult(parts.join(''));
      onChanged?.();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

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
      onChanged?.();
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
      onChanged?.();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (p: Project) => {
    const ok = window.confirm(
      `删除项目「${p.name}」？\n\n属于该项目的理解、关系、编码任务会删除。来源会变成未归属，对话原文保留。个人记忆不动。此操作不能从列表撤销（可用备份恢复）。`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteProject(p.id);
      await reload();
      onChanged?.();
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
                  {p.root_path ? (
                    <>
                      <span className="muted">{p.root_path}</span>
                      <Button
                        kind="ghost"
                        disabled={busy}
                        testId={`project-unbind-folder-${p.id}`}
                        onClick={() => void unbindFolder(p)}
                      >
                        解除绑定
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="muted">构想（未绑定目录）</span>
                      <Button
                        kind="ghost"
                        disabled={busy}
                        testId={`project-bind-folder-${p.id}`}
                        onClick={() => bindFolder(p.id)}
                      >
                        绑定文件夹
                      </Button>
                    </>
                  )}
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
                  <Button
                    kind="danger"
                    disabled={busy}
                    onClick={() => void removeProject(p)}
                    testId={`project-delete-${p.id}`}
                  >
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {unbindResult && (
          <p className="note" data-testid="project-unbind-result" style={{ marginTop: 12 }}>
            {unbindResult}
          </p>
        )}
      </Card>
    </div>
  );
}
