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

/** 独立验证命令默认值（与既有 note.txt 检查一致；创建草案不改字段=原行为）。 */
const DEFAULT_VERIFY =
  `node -e "const fs=require('fs');const p=require('path').join('note.txt');` +
  `if(!fs.existsSync(p))process.exit(2);if(!String(fs.readFileSync(p,'utf8')).trim())process.exit(3);"`;

/** 引号感知的命令行拆分：双引号内的空格不切分（如 node -e "代码 含空格"）。 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ' ' && !inQuote) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function TasksPage({ projects }: { projects: Project[] }) {
  const [notice, setNotice] = useState('');
  const [realDispatch, setRealDispatch] = useState(false);
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('note.txt');
  const [verify, setVerify] = useState(DEFAULT_VERIFY);

  const reload = useCallback(async () => {
    try {
      const snap = await api.listCodingTasks();
      setNotice(snap.notice);
      setRealDispatch(snap.realDispatchEnabled);
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
          {realDispatch
            ? '当前执行器：真机 Codex。没额度时派发会失败，不会改成 Fake。'
            : '当前执行器：Fake（模拟写文件，不调用 Codex，不扣额度）。0.2.4 安装包还是 Fake；源码开发版找到 codex.exe 才会显示真机。'}
        </p>
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
            <Field label="独立验证命令（工作区内运行；node 命令自动加权限沙箱）">
              <input
                value={verify}
                onChange={(e) => setVerify(e.target.value)}
                data-testid="task-verify"
              />
            </Field>
            <p className="muted">
              验证在权限沙箱内运行：文件读写限制在工作区，且不能启动子进程——`node --test` / `npm
              test` 会被拒绝，请用 `node 文件名` 进程内直跑（node:test 兼容）。
            </p>
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
                    allowedCommands: [splitCommandLine(verify)],
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
            {t.executor_name
              ? ` · 执行器 ${t.executor_name === 'codex-cli' ? 'Codex' : t.executor_name}`
              : ''}
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
                {realDispatch ? '派发（Codex）' : '派发（Fake）'}
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
                disabled={false}
                onClick={() => {
                  void api.cancelCodingTask(t.id).then(
                    () => reload(),
                    (err) => setError(errMsg(err)),
                  );
                }}
              >
                取消
              </Button>
            )}
            {t.status !== 'running' && (
              <Button
                kind="ghost"
                disabled={busy}
                onClick={() => {
                  const ok = window.confirm(
                    '删除这条编码任务？隔离工作区目录也会删。不会改你的项目主目录。',
                  );
                  if (!ok) return;
                  void act(() => api.deleteCodingTask(t.id));
                }}
                testId={`task-delete-${t.id}`}
              >
                删除
              </Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
