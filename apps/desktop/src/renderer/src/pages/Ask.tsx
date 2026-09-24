import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AskPhase,
  ConversationMessage,
  ConversationSummary,
  TodoStatus,
} from '@ixaeon/contracts';
import { api, errMsg, type Project } from '../api.js';
import { Button, Empty, ErrorBanner } from '../ui.js';
import { AskMessage } from './AskMessage.js';

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
export function AskPage({
  projects,
  openConversationId,
}: {
  projects: Project[];
  openConversationId?: string | null;
}) {
  const [projectId, setProjectId] = useState('');
  /** G06：当前对话有消息后项目下拉框锁定（换项目请开新对话）。 */
  const [projectLocked, setProjectLocked] = useState(false);
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
  // S2：正在等的那一轮。pendingId 是本地占位气泡的临时 id，第一段分段到达后换成真实 messageId。
  const waiting = useRef<{
    conversationId: string;
    pendingId: string;
    cancelled: boolean;
    /** P2：这一轮第一条进度事件带来的助手消息 id；之后只认它 */
    messageId?: string;
  } | null>(null);
  // 当前显示的对话。分段只写进它：切到别的对话时不往那边塞，切回来时从库里重新加载。
  const shownId = useRef<string | null>(null);
  const [askPhase, setAskPhase] = useState<AskPhase | null>(null);
  const [todoStatus, setTodoStatus] = useState<Record<string, TodoStatus>>({});
  const [todoCoding, setTodoCoding] = useState<Record<string, boolean>>({});
  const [waitSeconds, setWaitSeconds] = useState(0);
  const waitStarted = useRef<number | null>(null);
  const noticeShown = useMemo(() => noticeVisibility(messages), [messages]);

  const reloadList = useCallback(async () => {
    setList(await api.listConversations());
  }, []);

  const reloadTodoStatus = useCallback(async () => {
    if (!api.listTodos) return;
    const rows = await api.listTodos();
    const next: Record<string, TodoStatus> = {};
    const coding: Record<string, boolean> = {};
    for (const t of rows) {
      next[t.id] = t.status;
      coding[t.id] = t.linked_kind === 'coding_task';
    }
    setTodoStatus(next);
    setTodoCoding(coding);
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      const data = await api.getConversation(id);
      setActiveId(id);
      setMessages(data.messages);
      // G06：对话的项目固定。打开对话把下拉框切到它自己的项目；
      // 锁不锁看这个对话里有没有消息（不是看有没有打开）：
      // 空对话（刚点「新对话」还没发第一句）仍可改选，第一问以所选项目为准。
      const convProject = data.conversation.projectId;
      setProjectId(convProject ?? '');
      setProjectLocked(data.messages.length > 0);
      stick.current = true;
      await reloadTodoStatus();
    },
    [reloadTodoStatus],
  );

  useEffect(() => {
    if (!openConversationId) return;
    void openConversation(openConversationId).catch((err) => setError(errMsg(err)));
  }, [openConversationId, openConversation]);

  useEffect(() => {
    void reloadList().catch((err) => setError(errMsg(err)));
  }, [reloadList]);

  // P1：一打开问答页（或换了项目）就让主进程在后台建好 Hermes 会话，新对话第一问
  // 省掉 5–9 秒的组装空等。失败无所谓，提问时照常冷启动。
  useEffect(() => {
    void api
      .prewarmChat?.({ projectId: projectId.length > 0 ? projectId : null })
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    shownId.current = activeId;
  }, [activeId]);

  useEffect(() => {
    if (askPhase === null) {
      waitStarted.current = null;
      return;
    }
    if (waitStarted.current == null) waitStarted.current = Date.now();
    const timer = setInterval(() => {
      const started = waitStarted.current;
      if (started == null) return;
      setWaitSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [askPhase]);

  useEffect(() => {
    if (!api.onAskProgress) return;
    const off = api.onAskProgress((e) => {
      const w = waiting.current;
      if (!w || w.cancelled || e.conversationId !== w.conversationId) return;
      if (shownId.current !== e.conversationId) return;
      // 只认这一轮：第一条进度事件定下助手消息 id，别的消息的迟到事件不算
      if (w.messageId !== undefined && e.messageId !== w.messageId) return;
      w.messageId = e.messageId;
      setAskPhase((prev) => {
        if (prev === 'answering') return prev;
        if (e.phase === 'thinking' && prev === 'thinking') return prev;
        return e.phase;
      });
    });
    return () => off();
  }, []);

  useEffect(() => {
    if (!api.onAskDelta) return;
    const off = api.onAskDelta((e) => {
      const w = waiting.current;
      if (!w || w.cancelled || e.conversationId !== w.conversationId) return;
      if (shownId.current !== e.conversationId) return;
      setMessages((prev) => {
        // 按 id 认这一轮的那条消息，不按「最后一个在转圈的」去猜
        const idx = prev.findIndex((m) => m.id === e.messageId || m.id === w.pendingId);
        if (idx < 0) return prev;
        const target = prev[idx]!;
        const next = [...prev];
        next[idx] = {
          ...target,
          id: e.messageId,
          conversationId: e.conversationId,
          content: target.content + e.delta,
        };
        return next;
      });
    });
    return () => off();
  }, []);

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
    waitStarted.current = Date.now();
    setWaitSeconds(0);
    setAskPhase('preparing');
    let conversationId = activeId;
    try {
      // 先建对话再发：分段到来时要知道属于哪个对话（新对话的 id 原本要等回答结束才拿得到）。
      if (!conversationId) {
        const created = await api.createConversation({
          projectId: projectId.length > 0 ? projectId : null,
        });
        conversationId = created.id;
        shownId.current = created.id;
        setActiveId(created.id);
      }
      waiting.current = { conversationId, pendingId: pendingAnswer.id, cancelled: false };
      // G06：第一句发出去，这个对话的项目就定下来了（发的是下拉框当前所选）。
      setProjectLocked(true);
      const result = await api.askQuestion({
        conversationId,
        projectId: projectId.length > 0 ? projectId : null,
        question: text,
      });
      waiting.current = null;
      setAskPhase(null);
      await openConversation(result.conversationId);
      await reloadList();
    } catch (err) {
      const message = errMsg(err);
      setError(message);
      waiting.current = null;
      setAskPhase(null);
      if (conversationId) {
        try {
          // 后端已把这一轮收尾为 failed（已答出的半截也在），从库里重新拉就能看到
          await openConversation(conversationId);
        } catch {
          /* 重载失败不覆盖提问错误 */
        }
      } else {
        // 连对话都没建成：本地把转圈改成失败，别让气泡一直转
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingAnswer.id ? { ...m, status: 'failed', errorMessage: message } : m,
          ),
        );
      }
      try {
        await reloadList();
      } catch {
        /* 列表刷新失败不覆盖提问错误 */
      }
    } finally {
      setBusy(false);
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
        // 打开的对话被删了或归档了：没有对话了，项目下拉框不再锁着
        setProjectLocked(false);
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
                      <span className="muted">
                        {projects.find((p) => p.id === c.projectId)?.name ?? '全部项目'}
                        {'｜'}
                        {c.lastMessagePreview ?? '（空对话）'}
                      </span>
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
                  todoStatus={todoStatus}
                  todoCoding={todoCoding}
                  onDecideTodo={(id, decision) => {
                    void (async () => {
                      try {
                        if (decision === 'accept') await api.acceptTodo(id);
                        else await api.rejectTodo(id);
                        await reloadTodoStatus();
                      } catch (err) {
                        setError(errMsg(err));
                      }
                    })();
                  }}
                  waitLabel={
                    // askPhase 为空 = 这一页没有在等的提问（如重开时库里还在写的一轮）：
                    // 不知道阶段，也不知道等了多久，沿用「正在回答…」，不显示停住的秒数
                    m.status !== 'streaming' || askPhase === null
                      ? undefined
                      : askPhase === 'answering'
                        ? '正在回答…'
                        : askPhase === 'thinking'
                          ? `正在思考…（${waitSeconds} 秒）`
                          : `正在准备…（${waitSeconds} 秒）`
                  }
                />
              ))
            )}
          </div>
          <div className="ask-composer">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={projectLocked}
              data-testid="ask-project-select"
            >
              <option value="">个人视角（不选项目）</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {projectLocked && (
              <span className="muted" data-testid="ask-project-locked">
                换项目请开新对话
              </span>
            )}
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
                  if (waiting.current) waiting.current.cancelled = true;
                  setAskPhase(null);
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
