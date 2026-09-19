import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { TodoView } from '@ixaeon/contracts';
import { api, errMsg } from '../api.js';
import { Card, Empty, ErrorBanner } from '../ui.js';

const LINKED: Record<string, string> = {
  draft: '草稿',
  waiting_approval: '等批准',
  queued: '排队中',
  running: '进行中',
  pending_verify: '等验证',
  pending_accept: '等你验收',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态不明',
};

function Row({
  t,
  onOpen,
  children,
}: {
  t: TodoView;
  onOpen: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="item-row" data-testid={`todo-${t.id}`}>
      <p className="item-statement">{t.title}</p>
      <div className="item-actions">
        <span className="badge">{t.origin === 'agent' ? 'AI 提的' : '你加的'}</span>
        {t.conversation_id && (
          <button
            type="button"
            className="btn btn-ghost"
            data-testid={`todo-open-${t.id}`}
            onClick={() => onOpen(t.conversation_id!)}
          >
            从对话来
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function TodosPage({
  onOpenConversation: onOpen,
}: {
  onOpenConversation: (conversationId: string) => void;
}) {
  const [rows, setRows] = useState<TodoView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const reload = useCallback(async () => {
    try {
      setRows(await api.listTodos());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const add = (): void => {
    const text = title.trim();
    if (!text) return;
    setTitle('');
    void run(() => api.addTodo({ title: text }));
  };

  const proposed = (rows ?? []).filter((t) => t.status === 'proposed');
  const accepted = (rows ?? []).filter((t) => t.status === 'accepted');
  const done = (rows ?? []).filter((t) => t.status === 'done').slice(0, 30);

  return (
    <div className="page">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="待办">
        <div className="field-row">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder="加一条自己要做的事"
            style={{ flex: 1 }}
            data-testid="todo-add-input"
          />
          <button type="button" className="btn" data-testid="todo-add" onClick={add}>
            加一条
          </button>
        </div>
        <div className="item-group" data-testid="todo-section-proposed">
          <h3>等你拍板</h3>
          {proposed.length === 0 ? (
            <Empty>没有等你拍板的事</Empty>
          ) : (
            proposed.map((t) => (
              <Row key={t.id} t={t} onOpen={onOpen}>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid={`todo-accept-${t.id}`}
                  onClick={() => void run(() => api.acceptTodo(t.id))}
                >
                  要做
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid={`todo-reject-${t.id}`}
                  onClick={() => void run(() => api.rejectTodo(t.id))}
                >
                  不做
                </button>
              </Row>
            ))
          )}
        </div>
        <div className="item-group" data-testid="todo-section-accepted">
          <h3>要做</h3>
          {accepted.length === 0 ? (
            <Empty>没有要做的事</Empty>
          ) : (
            accepted.map((t) => (
              <Row key={t.id} t={t} onOpen={onOpen}>
                {t.linked_kind === 'coding_task' && (
                  <span className="badge" data-testid={`todo-linked-${t.id}`}>
                    编码任务：{LINKED[t.linkedStatus ?? 'unknown'] ?? '状态不明'}
                  </span>
                )}
                {/* 底下是编码任务的，完成跟着任务走（T2b）；其余的自己点完成 */}
                {t.linked_kind !== 'coding_task' && (
                  <button
                    type="button"
                    className="btn"
                    data-testid={`todo-complete-${t.id}`}
                    onClick={() => void run(() => api.completeTodo(t.id))}
                  >
                    做完了
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-testid={`todo-reject-${t.id}`}
                  onClick={() => void run(() => api.rejectTodo(t.id))}
                >
                  不做
                </button>
              </Row>
            ))
          )}
        </div>
        <div className="item-group" data-testid="todo-section-done">
          <h3>已完成</h3>
          {done.length === 0 ? (
            <Empty>还没有做完的事</Empty>
          ) : (
            done.map((t) => <Row key={t.id} t={t} onOpen={onOpen} />)
          )}
        </div>
      </Card>
    </div>
  );
}
