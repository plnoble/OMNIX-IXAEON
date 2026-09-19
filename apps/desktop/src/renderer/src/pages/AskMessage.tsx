import { useState } from 'react';
import type { ConversationMessage, MemoryUsedItem, TodoStatus } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Button, Spinner } from '../ui.js';

type ProposedTask = { id: string; goal: string; status: string; scope: string[] };

function tasksOf(meta: Record<string, unknown>): ProposedTask[] {
  const raw = meta['proposedTasks'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is ProposedTask => {
    if (!t || typeof t !== 'object') return false;
    const o = t as Record<string, unknown>;
    return typeof o['id'] === 'string' && typeof o['goal'] === 'string';
  });
}

function coverageOf(meta: Record<string, unknown>): {
  includedProjects: string[];
  unanalyzedSources: number;
} | null {
  const raw = meta['coverage'];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    includedProjects: Array.isArray(o['includedProjects'])
      ? (o['includedProjects'] as string[])
      : [],
    unanalyzedSources: typeof o['unanalyzedSources'] === 'number' ? o['unanalyzedSources'] : 0,
  };
}

function memoryUsedOf(meta: Record<string, unknown>): MemoryUsedItem[] {
  const raw = meta['memoryUsed'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is MemoryUsedItem => {
    if (!m || typeof m !== 'object') return false;
    const o = m as Record<string, unknown>;
    return typeof o['id'] === 'string' && typeof o['statement'] === 'string';
  });
}

/** P3：这一轮给模型看的项目近况计数（没带不显示）。 */
function projectBriefOf(
  meta: Record<string, unknown>,
): { commits: number; sessions: number; tasks: number } | null {
  const raw = meta['projectBrief'];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return typeof o['commits'] === 'number' &&
    typeof o['sessions'] === 'number' &&
    typeof o['tasks'] === 'number'
    ? { commits: o['commits'], sessions: o['sessions'], tasks: o['tasks'] }
    : null;
}

/**
 * E6：这一轮用到的记忆，当场纠正（用户 2026-09-18：不想导入一份资料就逐句审核）。
 * 记忆默认直接用；用的时候看到不对或过时，在这里点一下，之后就不再这样用。
 */
function MemoryUsedList({ items }: { items: MemoryUsedItem[] }) {
  const [marked, setMarked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const mark = async (id: string, action: 'wrong' | 'ended') => {
    try {
      if (action === 'wrong') await api.rejectItem(id);
      else await api.setItemTimeStatus({ id, status: 'ended' });
      setMarked((prev) => ({
        ...prev,
        [id]: action === 'wrong' ? '已标记不对，之后不再用' : '已标记过时，之后当作过去的事',
      }));
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <details className="ask-memory-used" data-testid="ask-memory-used">
      <summary className="muted">用到的记忆（{items.length} 条）· 不对或过时的可以当场点掉</summary>
      {error && <p className="warn">{error}</p>}
      <ul>
        {items.map((m) => (
          <li key={m.id} data-testid={`memory-used-${m.id}`}>
            <span>{m.statement}</span> <span className="muted">（{m.tag}）</span>
            {marked[m.id] ? (
              <span className="muted"> · {marked[m.id]}</span>
            ) : (
              <>
                <Button
                  kind="ghost"
                  onClick={() => void mark(m.id, 'wrong')}
                  testId={`memory-wrong-${m.id}`}
                >
                  不对
                </Button>
                <Button
                  kind="ghost"
                  onClick={() => void mark(m.id, 'ended')}
                  testId={`memory-ended-${m.id}`}
                >
                  过时了
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 流式过程中先不显示回答末尾的「建议待办」段：答完后主进程会把它拆成下面的待办卡，
 * 正文里就没有这一段了（标题行的认法同 packages/core/src/runtime/suggestedTodos.ts）。
 */
function hideSuggestedTodos(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^建议待办[:：]$/.test(l.replace(/[#*\s]/g, '')));
  return at < 0 ? text : lines.slice(0, at).join('\n').replace(/\s+$/, '');
}

const RESULT: Record<TodoStatus, string> = {
  proposed: '等你拍板',
  accepted: '要做',
  done: '已完成',
  rejected: '不做',
};

function proposedOf(meta: Record<string, unknown>): Array<{ id: string; title: string }> {
  const raw = meta['proposedTodos'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is { id: string; title: string } => {
    if (!t || typeof t !== 'object') return false;
    const o = t as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.title === 'string';
  });
}

function userTodoOf(meta: Record<string, unknown>): { id: string; title: string } | null {
  const raw = meta['userTodo'];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string'
    ? { id: o.id, title: o.title }
    : null;
}

export function AskMessage({
  message: m,
  showNotice,
  expandedRef,
  onToggleRef,
  waitLabel,
  todoStatus,
  todoCoding,
  onDecideTodo,
}: {
  message: ConversationMessage;
  /**
   * 说明文字是否直接露出。每轮回答都带一段引擎/存档说明，内容多半和上一轮
   * 一模一样；原样每条都显示，诊断文字会比回答本身还显眼。
   * 只有和上一条回答不同（首轮、引擎切换、存档失败或被停用）时才露出，
   * 其余收进折叠区，仍可展开核对——无变化就安静。
   */
  showNotice: boolean;
  expandedRef: string | null;
  onToggleRef: (ref: string) => void;
  /** T2b 起旧「行动批准卡」只展示历史消息，批准统一走待办卡；保留字段兼容旧调用 */
  onApprove?: (taskId: string) => void;
  waitLabel?: string;
  todoStatus?: Record<string, TodoStatus>;
  /** T2b：底下是编码任务的待办卡，标「编码任务」小标签 */
  todoCoding?: Record<string, boolean>;
  onDecideTodo?: (id: string, decision: 'accept' | 'reject') => void;
}) {
  const tasks = tasksOf(m.meta);
  const proposedTodos = proposedOf(m.meta);
  const userTodo = userTodoOf(m.meta);
  const shownContent =
    m.role === 'assistant' && m.status === 'streaming' ? hideSuggestedTodos(m.content) : m.content;
  const memoryUsed = memoryUsedOf(m.meta);
  const projectBrief = projectBriefOf(m.meta);
  const coverage = coverageOf(m.meta);
  const notice = typeof m.meta['notice'] === 'string' ? m.meta['notice'] : '';
  const steps = Array.isArray(m.meta['steps'])
    ? (m.meta['steps'] as Array<{ round: number; tool: string; ok: boolean; detail: string }>)
    : [];
  return (
    <article
      className={`ask-msg ask-msg-${m.role} ask-msg-${m.status}`}
      data-testid="message-item"
      data-role={m.role}
      data-status={m.status}
    >
      <div
        className={m.role === 'assistant' ? 'ask-answer' : undefined}
        data-testid={m.role === 'assistant' ? 'ask-answer' : undefined}
      >
        {m.status === 'streaming' && <Spinner label={waitLabel ?? '正在回答…'} />}
        {m.status === 'failed' && <p className="warn">失败：{m.errorMessage ?? '未知错误'}</p>}
        {m.status === 'cancelled' && <p className="warn">已取消</p>}
        {shownContent ? <pre className="answer-text">{shownContent}</pre> : null}
        {showNotice && notice ? (
          <p className="warn" data-testid="message-notice">
            {notice}
          </p>
        ) : null}
        {m.citations.length > 0 && (
          <div className="citations">
            <h4>引用（{m.citations.length} 条，点击展开原文）</h4>
            <ul data-testid="ask-citations">
              {m.citations.map((c) => (
                <li key={c.ref}>
                  <button type="button" className="citation-ref" onClick={() => onToggleRef(c.ref)}>
                    [{c.ref}] {c.sourceTitle}
                    {c.isUserCorrection ? '（用户纠正）' : ''}
                  </button>
                  {expandedRef === c.ref && (
                    <pre className="segment-text segment-focus">{c.excerpt}</pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {m.role === 'assistant' && m.status !== 'streaming' && memoryUsed.length > 0 && (
          <MemoryUsedList items={memoryUsed} />
        )}
        {m.role === 'assistant' && m.status !== 'streaming' && projectBrief && (
          <p className="muted" data-testid="ask-project-brief">
            本轮给模型看了项目近况：{projectBrief.commits} 条提交、{projectBrief.sessions} 个会话、
            {projectBrief.tasks} 个任务
          </p>
        )}
        {proposedTodos.length > 0 && (
          <div className="ask-todo-cards">
            <h4>建议待办</h4>
            {proposedTodos.map((t) => {
              const status = todoStatus?.[t.id] ?? 'proposed';
              return (
                <div key={t.id} className="card ask-todo-card" data-testid={`todo-card-${t.id}`}>
                  <span>
                    {t.title}
                    {todoCoding?.[t.id] && <span className="badge">编码任务</span>}
                  </span>
                  {status === 'proposed' ? (
                    <>
                      <Button
                        kind="primary"
                        testId={`todo-card-accept-${t.id}`}
                        onClick={() => onDecideTodo?.(t.id, 'accept')}
                      >
                        要做
                      </Button>
                      <Button
                        kind="ghost"
                        testId={`todo-card-reject-${t.id}`}
                        onClick={() => onDecideTodo?.(t.id, 'reject')}
                      >
                        不做
                      </Button>
                    </>
                  ) : (
                    <span className="muted">{RESULT[status]}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {userTodo && (
          <p className="muted" data-testid="user-todo-note">
            已加到待办：{userTodo.title}
          </p>
        )}
        {tasks.length > 0 && (
          <div className="proposed-tasks">
            <h4>行动批准卡（Agent 提议的受控编码任务）</h4>
            {tasks.map((t) => (
              <div key={t.id} className="card ask-task-card">
                <strong>目标：{t.goal}</strong>
                <p className="muted">
                  任务 ID: {t.id} · 文件范围: {t.scope.join(', ') || '受限'} · 状态: {t.status}
                </p>
                {t.status === 'draft' && <span className="muted">到待办页处理</span>}
                {t.status === 'queued' && <span className="badge">已排队执行</span>}
              </div>
            ))}
          </div>
        )}
        {m.role === 'assistant' && m.status !== 'streaming' && (
          // 摘要行常显：本轮走的是哪个引擎必须一眼可见，不能把 Core 兜底
          // 冒充成 Hermes。细节（用量、覆盖、说明、步骤）收进折叠区。
          <details className="ask-msg-details">
            <summary className="muted">
              引擎 {m.engine ?? 'ask'} · 模型 {m.modelName ?? '—'}
            </summary>
            <p className="muted">
              {typeof m.meta['usedChars'] === 'number'
                ? `使用 ${String(m.meta['usedChars'])} 字符资料`
                : '未记录资料用量'}
              {coverage
                ? ` · 覆盖项目 ${coverage.includedProjects.join('、') || '无'} · 未分析来源 ${coverage.unanalyzedSources}`
                : ''}
            </p>
            {!showNotice && notice ? <p className="muted">{notice}</p> : null}
            {steps.length > 0 && (
              <ul className="muted" data-testid="ask-steps">
                {steps.map((s) => (
                  <li key={`${s.round}-${s.tool}`}>
                    第 {s.round} 步 {s.tool}
                    {s.ok ? '' : '（失败）'}：{s.detail.slice(0, 160)}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </div>
    </article>
  );
}
