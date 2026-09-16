import { useState } from 'react';
import { api, errMsg, type Project, type AskAnswer } from '../api.js';
import { Button, Card, Empty, ErrorBanner, Spinner } from '../ui.js';

/** 问答页：个人视角（不强制选项目）或项目视角；回答带引用可展开核验。 */
export function AskPage({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState<string>('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

  const ask = async () => {
    if (question.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await api.askQuestion({
        projectId: projectId.length > 0 ? projectId : null,
        question: question.trim(),
      });
      setAnswer(result);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="page-ask">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Card title="问答" testId="ask-card">
        <p className="muted">
          提问会先探 Hermes。本机未装或会话未通时，走 Core
          有界工具循环（读记忆、拒绝未配置搜索、编码须你批准）。不会把单轮检索写成 Hermes 已接通。
        </p>
        <div className="search-bar">
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
          <input
            value={question}
            placeholder="问一个关于自己或项目的问题（回答附引用，可核验）"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ask();
            }}
            data-testid="ask-input"
          />
          <Button kind="primary" disabled={busy} onClick={ask} testId="ask-run">
            {busy ? '思考中…' : '提问'}
          </Button>
          {busy && (
            <Button
              kind="ghost"
              onClick={() => {
                void api.cancelAsk();
              }}
              testId="ask-cancel"
            >
              取消
            </Button>
          )}
        </div>

        {busy && <Spinner label="检索资料并生成回答…" />}

        {answer && (
          <div className="ask-answer" data-testid="ask-answer">
            <pre className="answer-text">{answer.answer}</pre>
            {answer.notice && <p className="warn">{answer.notice}</p>}
            {answer.citations.length > 0 && (
              <div className="citations">
                <h4>引用（{answer.citations.length} 条，点击展开原文）</h4>
                <ul data-testid="ask-citations">
                  {answer.citations.map((c) => (
                    <li key={c.ref}>
                      <button
                        type="button"
                        className="citation-ref"
                        onClick={() => setExpandedRef(expandedRef === c.ref ? null : c.ref)}
                      >
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
            {answer.proposedTasks && answer.proposedTasks.length > 0 && (
              <div className="proposed-tasks" style={{ marginTop: 16 }}>
                <h4>行动批准卡（Agent 提议的受控编码任务）</h4>
                {answer.proposedTasks.map((t) => (
                  <div
                    key={t.id}
                    className="card"
                    style={{ margin: '8px 0', border: '1px solid #3b82f6', padding: 12 }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <strong>目标：{t.goal}</strong>
                        <p className="muted" style={{ margin: '4px 0', fontSize: '0.85em' }}>
                          任务 ID: {t.id} · 文件范围: {t.scope.join(', ') || '受限'} · 状态:{' '}
                          {t.status}
                        </p>
                      </div>
                      <div>
                        {t.status === 'draft' && (
                          <Button
                            kind="primary"
                            disabled={busy}
                            onClick={async () => {
                              try {
                                setBusy(true);
                                await api.approveCodingTask(t.id);
                                setAnswer((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        proposedTasks: prev.proposedTasks?.map((item) =>
                                          item.id === t.id ? { ...item, status: 'queued' } : item,
                                        ),
                                      }
                                    : null,
                                );
                              } catch (err) {
                                setError(errMsg(err));
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            批准并排队
                          </Button>
                        )}
                        {t.status === 'queued' && (
                          <span className="badge" style={{ color: '#10b981' }}>
                            已排队执行
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="muted">
              引擎 {answer.engine ?? 'ask'} · 模型 {answer.modelName} · 使用 {answer.usedChars}{' '}
              字符资料
              {answer.coverage
                ? ` · 覆盖项目 ${answer.coverage.includedProjects.join('、') || '无'} · 未分析来源 ${answer.coverage.unanalyzedSources}`
                : ''}
            </p>
            {(answer.steps ?? []).length > 0 && (
              <ul className="muted" data-testid="ask-steps">
                {answer.steps!.map((s) => (
                  <li key={`${s.round}-${s.tool}`}>
                    第 {s.round} 步 {s.tool}
                    {s.ok ? '' : '（失败）'}：{s.detail.slice(0, 160)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!busy && !answer && !error && (
          <Empty>例如：正式系统名是什么？为什么否决了手机方案？</Empty>
        )}
      </Card>
    </div>
  );
}
