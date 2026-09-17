import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMessage, ConversationSummary } from '@ixaeon/contracts';
import { api, errMsg, type Project } from '../api.js';
import { Button, Empty, ErrorBanner } from '../ui.js';
import { AskMessage } from './AskMessage.js';

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

/**
 * 每条回答的说明文字要不要直接露出：和上一条回答的说明不同才露出。
 * 同一对话里每轮说明通常一字不差（走哪个引擎、存档是否生效），
 * 首轮说一次就够；中途变了（存档失败、被停用、引擎切换）才需要再提醒。
 */
function noticeVisibility(messages: ConversationMessage[]): Map<string, boolean> {
  const visible = new Map<string, boolean>();
  let previous: string | null = null;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const notice = typeof m.meta['notice'] === 'string' ? m.meta['notice'] : '';
    visible.set(m.id, notice !== '' && notice !== previous);
    if (notice !== '') previous = notice;
  }
  return visible;
}

/** 发送后、回答回来前先显示的本地消息（回来后整段从库里重新拉取替换）。 */
function pendingMessage(
  role: 'user' | 'assistant',
  content: string,
  seq: number,
): ConversationMessage {
  const now = new Date().toISOString();
  return {
    id: `pending-${role}-${seq}`,
    conversationId: '',
    seq,
    role,
    content,
    status: role === 'user' ? 'complete' : 'streaming',
    createdAt: now,
    updatedAt: now,
    runId: null,
    engine: null,
    modelName: null,
    citations: [],
    meta: {},
    errorMessage: null,
  };
}

/** 问答页：连续聊天（D6）。左侧对话列表，右侧消息流；引用/批准卡/引擎信息保留。 */
export function AskPage({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  // 列表里直接改名。不能用 window.prompt：Electron 不支持，调用会直接抛错
  //（9-07 的 ea7c721 因此改掉过归档的 prompt，D6 又把它带了回来，9-17 用户实测改名无反应）。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const renameCancelled = useRef(false);
  const stick = useRef(true);
  const listEl = useRef<HTMLDivElement>(null);
  const noticeShown = useMemo(() => noticeVisibility(messages), [messages]);

  const reloadList = useCallback(async () => {
    setList(await api.listConversations());
  }, []);

  const openConversation = useCallback(async (id: string) => {
    const data = await api.getConversation(id);
    setActiveId(id);
    setMessages(data.messages);
    stick.current = true;
  }, []);

  useEffect(() => {
    void reloadList().catch((err) => setError(errMsg(err)));
  }, [reloadList]);

  useEffect(() => {
    const el = listEl.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const ask = async () => {
    const text = question.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setQuestion('');
    // 回答要等好几秒（真模型可能十几秒）。先把问题和「正在回答」气泡放上去，
    // 否则输入框清空后屏幕上什么都没有，像是发出去就没了。
    const lastSeq = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
    const pendingAnswer = pendingMessage('assistant', '', lastSeq + 2);
    setMessages((prev) => [...prev, pendingMessage('user', text, lastSeq + 1), pendingAnswer]);
    stick.current = true;
    try {
      const result = await api.askQuestion({
        conversationId: activeId,
        projectId: projectId.length > 0 ? projectId : null,
        question: text,
      });
      await openConversation(result.conversationId);
      await reloadList();
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      if (activeId) {
        try {
          // 后端已把这一轮收尾为 failed，从库里重新拉就能看到
          await openConversation(activeId);
        } catch {
          /* 重载失败不覆盖提问错误 */
        }
      } else {
        // 新对话里的第一问就失败：拿不到对话 id，本地把转圈改成失败，
        // 别让气泡一直转；刷新列表后这个对话（含失败记录）会出现在左侧。
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingAnswer.id ? { ...m, status: 'failed', errorMessage: message } : m,
          ),
        );
        try {
          await reloadList();
        } catch {
          /* 同上 */
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = async (taskId: string) => {
    try {
      await api.approveCodingTask(taskId);
      setMessages((prev) =>
        prev.map((m) => {
          const next = tasksOf(m.meta).map((t) =>
            t.id === taskId ? { ...t, status: 'queued' } : t,
          );
          return next.length === 0 ? m : { ...m, meta: { ...m.meta, proposedTasks: next } };
        }),
      );
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const actOnConv = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      const next = await api.listConversations();
      setList(next);
      if (activeId && !next.some((c) => c.id === activeId)) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div data-testid="page-ask">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="ask-layout">
        <aside className="ask-sidebar">
          <Button
            kind="primary"
            disabled={busy}
            testId="conversation-new"
            onClick={() => {
              void actOnConv(async () => {
                const created = await api.createConversation({
                  projectId: projectId.length > 0 ? projectId : null,
                });
                await openConversation(created.id);
              });
            }}
          >
            新对话
          </Button>
          <div className="ask-conv-list" data-testid="conversation-list">
            {list.length === 0 ? (
              <Empty>还没有对话。点「新对话」开始提问。</Empty>
            ) : (
              list.map((c) => (
                <div
                  key={c.id}
                  className={c.id === activeId ? 'ask-conv-item active' : 'ask-conv-item'}
                  data-testid="conversation-item"
                  data-conversation-id={c.id}
                  onClick={() => {
                    if (!busy) void openConversation(c.id).catch((err) => setError(errMsg(err)));
                  }}
                >
                  {renamingId === c.id ? (
                    <input
                      className="ask-conv-rename"
                      data-testid="conversation-rename-input"
                      value={renameText}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') {
                          // 先打标记再失焦：失焦处理读到标记就不保存
                          renameCancelled.current = true;
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={() => {
                        // 失焦即保存（与常见聊天应用一致），Esc 除外
                        const cancelled = renameCancelled.current;
                        renameCancelled.current = false;
                        setRenamingId(null);
                        const title = renameText.trim();
                        if (!cancelled && title.length > 0 && title !== c.title) {
                          void actOnConv(() => api.renameConversation({ id: c.id, title }));
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ask-conv-main"
                      disabled={busy}
                      onClick={() =>
                        void openConversation(c.id).catch((err) => setError(errMsg(err)))
                      }
                    >
                      <strong>{c.title}</strong>
                      <span className="muted">{c.lastMessagePreview ?? '（空对话）'}</span>
                    </button>
                  )}
                  <div className="ask-conv-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-testid="conversation-rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        renameCancelled.current = false;
                        setRenameText(c.title);
                        setRenamingId(c.id);
                      }}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void actOnConv(() => api.archiveConversation(c.id));
                      }}
                    >
                      归档
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`删除对话「${c.title}」？消息会一起删掉。`)) {
                          void actOnConv(() => api.deleteConversation(c.id));
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="ask-main">
          <div
            className="ask-messages"
            data-testid="message-list"
            ref={listEl}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {messages.length === 0 && !busy ? (
              <Empty>像聊天一样直接问。换一个话题时，点左上角「新对话」。</Empty>
            ) : (
              messages.map((m) => (
                <AskMessage
                  key={m.id}
                  message={m}
                  showNotice={noticeShown.get(m.id) ?? false}
                  expandedRef={expandedRef}
                  onToggleRef={(ref) => setExpandedRef(expandedRef === ref ? null : ref)}
                  onApprove={(id) => void approve(id)}
                />
              ))
            )}
          </div>
          <div className="ask-composer">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              data-testid="ask-project-select"
            >
              <option value="">个人视角（不选项目）</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <textarea
              value={question}
              placeholder="问一个关于自己或项目的问题（回答附引用，可核验）"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask();
                }
              }}
              data-testid="ask-input"
              rows={2}
            />
            <Button kind="primary" disabled={busy} onClick={() => void ask()} testId="ask-run">
              {busy ? '思考中…' : '发送'}
            </Button>
            {busy && (
              <Button
                kind="ghost"
                onClick={() => {
                  void api.cancelAsk(activeId);
                }}
                testId="ask-cancel"
              >
                取消
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
