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
            <p className="muted">
              模型 {answer.modelName} · 使用 {answer.usedChars} 字符资料
              {answer.coverage
                ? ` · 覆盖项目 ${answer.coverage.includedProjects.join('、') || '无'} · 未分析来源 ${answer.coverage.unanalyzedSources}`
                : ''}
            </p>
          </div>
        )}
        {!busy && !answer && !error && (
          <Empty>例如：正式系统名是什么？为什么否决了手机方案？</Empty>
        )}
      </Card>
    </div>
  );
}
