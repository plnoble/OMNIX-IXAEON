import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg, type Project } from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';
import {
  executorExplanation,
  executorLabel,
  verifyLabel,
  type CodingTask,
  type TaskChangedFile,
  type TaskChanges,
} from '@ixaeon/contracts';

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

/** 还没有结果的状态：页面要自己跟着看。 */
const IN_FLIGHT = new Set<CodingTask['status']>(['queued', 'running', 'pending_verify']);

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

/** 落地结果一行（D4 契约 6：任务页同样显示；文案与桌面回报同款）。 */
function landingLine(t: CodingTask): string {
  if (t.applied_ref && /^ixaeon\//.test(t.applied_ref)) {
    const base = `已在项目仓库建分支 ${t.applied_ref}（没有推送，也没动你的工作区）。要合并：git merge ${t.applied_ref}`;
    return t.apply_error ? `${base}。注意：${t.apply_error}` : base;
  }
  if (t.applied_ref) return `改动包在 ${t.applied_ref}（${t.apply_error ?? '原因未记录'}）`;
  if (t.apply_error) return t.apply_error;
  if (t.status !== 'completed') return '';
  // 零改动看执行报告：有改动但没落地的旧任务不能误标「没有改动」。
  const changed = t.executor_report_json
    ? ((JSON.parse(t.executor_report_json) as { changedPaths?: string[] }).changedPaths ?? [])
    : [];
  return changed.length === 0 ? '这次没有改动文件（没有改动）' : '改动还在隔离副本里，未落地';
}

function acceptanceLines(json: string | null): string[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as unknown;
    return Array.isArray(list)
      ? list.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
  } catch {
    return [];
  }
}

function acceptanceTestsLine(json: string | null): string | null {
  if (!json) return null;
  try {
    const report = JSON.parse(json) as {
      acceptanceTests?: { files?: unknown; locked?: unknown; reason?: unknown };
    };
    const tests = report.acceptanceTests;
    if (!tests || typeof tests.locked !== 'boolean') return null;
    if (tests.locked) {
      const n = Array.isArray(tests.files) ? tests.files.length : 0;
      return `验收测试 ${n} 个，已锁定`;
    }
    const reason = typeof tests.reason === 'string' ? tests.reason.trim() : '';
    return reason ? `验收测试没锁定：${reason}` : '验收测试没锁定';
  } catch {
    return null;
  }
}

/** U5：验收条件、验收测试、执行器自己的说明。没有的不显示。 */
function TaskWords({ task: t }: { task: CodingTask }) {
  const acceptance = acceptanceLines(t.acceptance_json);
  const testsLine = acceptanceTestsLine(t.executor_report_json);
  const explanation = executorExplanation(t);
  return (
    <>
      {acceptance.length > 0 && (
        <div data-testid={`task-acceptance-${t.id}`}>
          <p>验收条件：</p>
          {acceptance.map((a) => (
            <p key={a}>{a}</p>
          ))}
        </div>
      )}
      {testsLine && <p data-testid={`task-acceptance-tests-${t.id}`}>{testsLine}</p>}
      {explanation && <p data-testid={`task-explanation-${t.id}`}>它的说明：{explanation}</p>}
    </>
  );
}

/** 执行报告里的 changedPaths 条数；没有报告或清单为空返回 null（不显示「看改动」）。 */
function changedCount(t: CodingTask): number | null {
  if (!t.executor_report_json) return null;
  try {
    const report = JSON.parse(t.executor_report_json) as { changedPaths?: unknown };
    const list = Array.isArray(report.changedPaths)
      ? (report.changedPaths as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    return list.length > 0 ? list.length : null;
  } catch {
    return null;
  }
}

const changeKindLabel: Record<TaskChangedFile['kind'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  same: '没有变化',
  unknown: '看不了',
};

/** 一行差异正文：+ 行绿色，- 行红色，其余原色。 */
function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="diff-pre">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={`diff-line ${line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : ''}`}
        >
          {line}
        </div>
      ))}
    </pre>
  );
}

/** U3「看改动」：结果留在卡片里，出错不上页顶。openToken 为 0 是收起，每加一就重新读。 */
function TaskChangesCard({
  task,
  openToken,
  onToggle,
}: {
  task: CodingTask;
  openToken: number;
  onToggle: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TaskChanges | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 旧请求序号对不上就作废（收起再展开时的竞态）。 */
  const reqSeq = useRef(0);
  const count = changedCount(task);

  useEffect(() => {
    if (count === null || openToken === 0) {
      reqSeq.current += 1;
      return;
    }
    setLoading(true);
    setLoadError(null);
    const seq = ++reqSeq.current;
    void api.getCodingTaskChanges(task.id).then(
      (res) => {
        if (reqSeq.current !== seq) return;
        setData(res);
        setLoading(false);
      },
      (err) => {
        if (reqSeq.current !== seq) return;
        setLoadError(errMsg(err));
        setLoading(false);
      },
    );
  }, [openToken, task.id, count]);

  if (count === null) return null;

  return (
    <div className="u3-changes">
      <p className="muted">
        改了 {count} 个文件{' '}
        <Button kind="default" testId={`task-changes-toggle-${task.id}`} onClick={onToggle}>
          {openToken > 0 ? '收起' : '看改动'}
        </Button>
      </p>
      {openToken > 0 && (
        <div data-testid={`task-changes-${task.id}`}>
          {loading && <Spinner />}
          {!loading && loadError && (
            <p className="warn" data-testid={`task-changes-error-${task.id}`}>
              {loadError}
            </p>
          )}
          {!loading && !loadError && data && (
            <>
              {data.total > data.files.length && (
                <p className="muted">共 {data.total} 个，只列了前 50 个</p>
              )}
              {data.files.map((f) => (
                <div
                  key={f.path}
                  style={{
                    borderTop: '1px solid var(--line, #eee)',
                    paddingTop: 8,
                    marginTop: 8,
                  }}
                >
                  <p style={{ margin: '4px 0' }}>
                    <strong>{f.path}</strong>{' '}
                    <span className={`badge badge-${f.kind === 'unknown' ? 'muted' : f.kind}`}>
                      {changeKindLabel[f.kind]}
                    </span>
                  </p>
                  {f.note && <p className="muted">{f.note}</p>}
                  {f.diff !== null && <DiffBody diff={f.diff} />}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** U4：要任务页停在哪条任务上。每点一次按钮给一个新的对象。 */
export interface TaskFocus {
  taskId: string;
  /** 点按钮的时刻（Date.now()），同一条任务连点两次也能再生效。 */
  at: number;
}

export function TasksPage({
  projects,
  focus = null,
}: {
  projects: Project[];
  focus?: TaskFocus | null;
}) {
  const [notice, setNotice] = useState('');
  const [realDispatch, setRealDispatch] = useState(false);
  /** D7b：主进程回传的执行器种类（'model' 时不显示 Fake / 真机 Codex 那两句）。 */
  const [executorKind, setExecutorKind] = useState<'fake' | 'codex-cli' | 'model'>('fake');
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('note.txt');
  const [verify, setVerify] = useState(DEFAULT_VERIFY);
  const [skills, setSkills] = useState<Awaited<ReturnType<typeof api.listSkillCandidates>>>([]);
  const [changesToken, setChangesToken] = useState<Readonly<Record<string, number>>>({});
  const appliedFocusAt = useRef<number | null>(null);
  const bumpChanges = (id: string) =>
    setChangesToken((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));

  const reload = useCallback(async () => {
    try {
      const snap = await api.listCodingTasks();
      setNotice(snap.notice);
      setRealDispatch(snap.realDispatchEnabled);
      setExecutorKind(snap.executor);
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

  // U4：清单读回来之后滚到 focus 那条；有改动就展开。at 变了再做一次。不在了就不管。
  // 用 id 串当依赖：两秒轮询换了对象、还是这几条时，不重复滚、不重复读。
  const taskIds = tasks.map((t) => t.id).join('\0');
  useEffect(() => {
    if (!focus || appliedFocusAt.current === focus.at || tasks.length === 0) return;
    appliedFocusAt.current = focus.at;
    const target = tasks.find((t) => t.id === focus.taskId);
    if (!target) return;
    document.querySelector(`[data-testid="task-${target.id}"]`)?.scrollIntoView();
    if (changedCount(target) !== null) bumpChanges(target.id);
  }, [focus, taskIds, tasks]);

  // U2：任务是在后台跑的（聊天里点「要做」就开工）。有任务在排队、执行或验证时每两秒看一眼，
  // 不然这一页会一直停在「执行中」。只更新任务，不动用户正在看的报错条；都做完了就停。
  const inFlight = tasks.some((t) => IN_FLIGHT.has(t.status));
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      void api
        .listCodingTasks()
        .then((snap) => setTasks(snap.tasks))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [inFlight]);

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
        {executorKind !== 'model' && (
          <p className="muted">
            {realDispatch
              ? '当前执行器：真机 Codex。没额度时派发会失败，不会改成 Fake。'
              : '当前执行器：Fake（模拟写文件，不调用 Codex，不扣额度）。0.2.4 安装包还是 Fake；源码开发版找到 codex.exe 才会显示真机。'}
          </p>
        )}
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
            {t.executor_name ? ` · 执行器 ${executorLabel(t.executor_name)}` : ''}
            {t.verify_status ? ` · ${verifyLabel(t)}` : ''}
            {t.tests_modified ? ' · 测试代码被修改' : ''}
          </p>
          <TaskChangesCard
            task={t}
            openToken={changesToken[t.id] ?? 0}
            onToggle={() =>
              setChangesToken((prev) => ({
                ...prev,
                [t.id]: prev[t.id] ? 0 : (prev[t.id] ?? 0) + 1,
              }))
            }
          />
          {landingLine(t) && (
            <p className="note" data-testid={`task-landing-${t.id}`}>
              {landingLine(t)}
            </p>
          )}
          <TaskWords task={t} />
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
                {executorKind === 'model'
                  ? '派发（我的模型）'
                  : realDispatch
                    ? '派发（Codex）'
                    : '派发（Fake）'}
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
