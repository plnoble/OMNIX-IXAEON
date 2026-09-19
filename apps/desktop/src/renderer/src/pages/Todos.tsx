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
    <div data-testid={`todo-${t.id}`}>
      <span>{t.title}</span>
      <span> {t.origin === 'agent' ? 'AI 提的' : '你加的'} </span>
      {t.conversation_id && (
        <button
          type="button"
          data-testid={`todo-open-${t.id}`}
          onClick={() => onOpen(t.conversation_id!)}
        >
          从对话来
        </button>
      )}
      {children}
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
        <div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder="加一条自己要做的事"
            data-testid="todo-add-input"
          />
          <button type="button" data-testid="todo-add" onClick={add}>
            加一条
          </button>
        </div>
        <div data-testid="todo-section-proposed">
          <h3>等你拍板</h3>
          {proposed.length === 0 ? (
            <Empty>没有等你拍板的事</Empty>
          ) : (
            proposed.map((t) => (
              <Row key={t.id} t={t} onOpen={onOpen}>
                <button
                  type="button"
                  data-testid={`todo-accept-${t.id}`}
                  onClick={() => void run(() => api.acceptTodo(t.id))}
                >
                  要做
                </button>
                <button
                  type="button"
                  data-testid={`todo-reject-${t.id}`}
                  onClick={() => void run(() => api.rejectTodo(t.id))}
                >
                  不做
                </button>
              </Row>
            ))
          )}
        </div>
        <div data-testid="todo-section-accepted">
          <h3>要做</h3>
          {accepted.length === 0 ? (
            <Empty>没有要做的事</Empty>
          ) : (
            accepted.map((t) => (
              <Row key={t.id} t={t} onOpen={onOpen}>
                {t.linked_kind === 'coding_task' && (
                  <span data-testid={`todo-linked-${t.id}`}>
                    编码任务：{LINKED[t.linkedStatus ?? 'unknown'] ?? '状态不明'}
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`todo-reject-${t.id}`}
                  onClick={() => void run(() => api.rejectTodo(t.id))}
                >
                  不做
                </button>
                {t.linked_kind === null && (
                  <button
                    type="button"
                    data-testid={`todo-complete-${t.id}`}
                    onClick={() => void run(() => api.completeTodo(t.id))}
                  >
                    做完了
                  </button>
                )}
              </Row>
            ))
          )}
        </div>
        <div data-testid="todo-section-done">
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
