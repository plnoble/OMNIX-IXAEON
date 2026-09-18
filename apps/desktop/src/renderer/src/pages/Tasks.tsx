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
export function splitCommandLine(line: string): { argv: string[]; unclosed: boolean } {
  const argv: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ' ' && !inQuote) {
      if (cur) argv.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) argv.push(cur);
  return { argv, unclosed: inQuote };
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
  const [skills, setSkills] = useState<Awaited<ReturnType<typeof api.listSkillCandidates>>>([]);

  const reload = useCallback(async () => {
    try {
      const snap = await api.listCodingTasks();
      setNotice(snap.notice);
      setRealDispatch(snap.realDispatchEnabled);
      setTasks(snap.tasks);
      const sk = await api.listSkillCandidates(projectId || undefined);
      setSkills(sk);
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  }, [projectId]);

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
                    allowedCommands: [splitCommandLine(verify).argv],
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
            {t.status === 'failed' && (
              <Button
                kind="default"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.proposeSkillCandidate({
                      projectId: t.project_id,
                      task: t.goal,
                      summary: t.error || '任务执行失败',
                    });
                  })
                }
              >
                提炼为能力候选
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

      <Card title="能力候选与自我演进 (Skill Candidates)" testId="skills-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="muted" style={{ margin: 0 }}>
            经验到能力成长：任务失败可提炼候选；必须填报真实客观执行证据（前后对比+退出码验证）后方可批准上架。修改方法旧证据自动作废。
          </p>
          <Button
            kind="default"
            disabled={busy}
            onClick={() => {
              void act(async () => {
                const evolved = await api.autoEvolveSkillCandidates({
                  projectId: projectId || null,
                });
                if (evolved.length === 0) {
                  setError('未发现未处理的高频或聚类失败记录');
                }
              });
            }}
            testId="auto-evolve-skills"
          >
            自动分析历史失败提炼
          </Button>
        </div>
        {skills.length === 0 ? (
          <p className="muted">暂无能力候选。可在失败任务上点击「提炼为能力候选」。</p>
        ) : (
          skills.map((s) => (
            <div
              key={s.id}
              style={{
                borderTop: '1px solid var(--color-border, #eee)',
                paddingTop: 12,
                marginTop: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>
                  {s.title} (v{s.version})
                </strong>
                <span className="badge">{s.status}</span>
              </div>
              <p className="muted" style={{ margin: '4px 0' }}>
                问题：{s.problem}
              </p>
              <p style={{ margin: '4px 0' }}>方法：{s.method}</p>
              {s.eval_evidence_json ? (
                <p className="note" style={{ fontSize: '0.85em' }}>
                  已验证证据：{s.eval_evidence_json.slice(0, 200)}...
                </p>
              ) : (
                <p className="warn" style={{ fontSize: '0.85em' }}>
                  尚无受控执行证据（需经沙箱真实验证退出码与输出），无法批准。
                </p>
              )}
              <div className="card-actions" style={{ marginTop: 8 }}>
                {s.status !== 'approved' && s.status !== 'retired' && (
                  <SkillEvalForm
                    skillId={s.id}
                    method={s.method}
                    tasks={tasks}
                    disabled={busy}
                    onDone={reload}
                  />
                )}
                {s.status === 'evaluated' && s.eval_evidence_json && (
                  <Button
                    kind="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.approveSkillCandidate({ id: s.id, version: s.version }))
                    }
                  >
                    批准上架（绑定 v{s.version}）
                  </Button>
                )}
                {s.status !== 'retired' && (
                  <Button
                    kind="ghost"
                    disabled={busy}
                    onClick={() => void act(() => api.retireSkillCandidate({ id: s.id }))}
                  >
                    废弃
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

/**
 * K1：技能候选的受控对照验证表单（卡片内展开）。原实现用 window.prompt 收集参数，
 * Electron 不支持 prompt，这个入口在真实应用里从未生效过。
 */
function SkillEvalForm({
  skillId,
  method,
  tasks,
  disabled,
  onDone,
}: {
  skillId: string;
  method: string;
  tasks: CodingTask[];
  disabled: boolean;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [command, setCommand] = useState('');
  const [benefit, setBenefit] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const split = splitCommandLine(command);
  const canRun =
    !disabled && !running && split.argv.length > 0 && !split.unclosed && benefit.trim().length > 0;

  if (!open) {
    return (
      <Button
        kind="default"
        disabled={disabled}
        onClick={() => setOpen(true)}
        testId="skill-eval-open"
      >
        运行受控对照验证
      </Button>
    );
  }

  return (
    <div data-testid={`skill-eval-form-${skillId}`} style={{ flex: 1 }}>
      <Field label="关联任务（可选）">
        <select
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          data-testid="skill-eval-task"
        >
          <option value="">不指定任务工作区</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.goal}
            </option>
          ))}
        </select>
      </Field>
      <Field label="验证命令">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          data-testid="skill-eval-command"
        />
      </Field>
      <p className="muted" data-testid="skill-eval-preview">
        {split.unclosed
          ? '引号未闭合，无法运行'
          : split.argv.length === 0
            ? '按空格拆成参数，双引号内的空格不拆'
            : split.argv.join(' · ')}
      </p>
      <Field label="收益说明">
        <textarea
          value={benefit}
          onChange={(e) => setBenefit(e.target.value)}
          data-testid="skill-eval-benefit"
          rows={3}
        />
      </Field>
      {formError && (
        <p className="warn" data-testid="skill-eval-error">
          {formError}
        </p>
      )}
      <div className="card-actions" style={{ marginTop: 8 }}>
        <Button
          kind="primary"
          disabled={!canRun}
          testId="skill-eval-run"
          onClick={() => {
            void (async () => {
              setRunning(true);
              setFormError(null);
              try {
                await api.evaluateSkillWithEvidence({
                  id: skillId,
                  method,
                  command: split.argv,
                  taskId: taskId.length > 0 ? taskId : null,
                  benefit: benefit.trim(),
                });
                setOpen(false);
                await onDone();
              } catch (err) {
                setFormError(errMsg(err));
              } finally {
                setRunning(false);
              }
            })();
          }}
        >
          {running ? '正在验证…' : '运行'}
        </Button>
        <Button kind="ghost" disabled={running} onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
