import { useCallback, useEffect, useState } from 'react';
import {
  api,
  errMsg,
  type Project,
  type Segment,
  type Source,
  type SourceListItem,
} from '../api.js';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  providerLabel,
  roleLabel,
  sourceKindLabel,
  Spinner,
} from '../ui.js';

const PAGE_SIZE = 50;

/**
 * M1.2：把来源的真实状态数据翻译成普通人能读懂的文案。
 * 依据：版本差（content > analyzed = 还有内容未分析）、最近任务状态、授权状态。
 */
export function analysisStatus(
  item: SourceListItem,
  capture: { enabled: boolean; autoAnalyze: boolean },
): { text: string; detail?: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  const a = item.analysis;
  if (item.permissionStatus === 'revoked') {
    return { text: '授权已撤销', detail: '不再读取原文；已导入的理解保留', tone: 'bad' };
  }
  if (item.source.archived_at) {
    return {
      text: '已归档（过往工作）',
      detail: item.source.archive_summary ?? '原文可查，不当现行目标',
      tone: 'muted',
    };
  }
  if (a.lastJobStatus === 'running') return { text: '正在分析…', tone: 'muted' };
  if (a.lastJobStatus === 'queued') {
    return {
      text: a.analyzedRevision > 0 ? '有新内容排队等待分析' : '已收到，等待分析',
      tone: 'muted',
    };
  }
  if (a.lastJobStatus === 'failed') {
    return {
      text: '这次没改理解，可以重新分析',
      detail: a.lastJobError ? a.lastJobError.slice(0, 280) : undefined,
      tone: 'bad',
    };
  }
  if (a.contentRevision > a.analyzedRevision) {
    const pending =
      item.source.provider === 'chatgpt_web' && (!capture.enabled || !capture.autoAnalyze)
        ? '自动分析已关闭，开启后处理'
        : undefined;
    if (a.analyzedRevision === 0) {
      return { text: '已收到，等待分析', detail: pending, tone: 'muted' };
    }
    return { text: '有新内容尚未分析，当前显示旧理解', detail: pending, tone: 'warn' };
  }
  if (a.analyzedRevision > 0) return { text: '已分析最新内容', tone: 'ok' };
  return { text: '已收到', tone: 'muted' };
}

/** 来源页：导入 → 列表 → 详情（片段阅读器 + 上下文查看）。 */
export function SourcesPage({
  projects,
  projectId,
  onProjectChange,
}: {
  projects: Project[];
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
}) {
  const [list, setList] = useState<SourceListItem[] | null>(null);
  const [captureFlags, setCaptureFlags] = useState({ enabled: true, autoAnalyze: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    source: Source;
    segments: Segment[];
    total: number;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(
    async (silent = false) => {
      if (!silent) setList(null);
      try {
        const [list, settings] = await Promise.all([
          api.listSources({ projectId }),
          api.getSettings(),
        ]);
        setList(list);
        setSelected((prev) => {
          const ids = new Set(list.map((item) => item.source.id));
          return new Set([...prev].filter((id) => ids.has(id)));
        });
        setCaptureFlags({
          enabled: settings.config.captureEnabled,
          autoAnalyze: settings.config.autoAnalyze,
        });
        setError(null);
      } catch (err) {
        setError(errMsg(err));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void reload();
    setDetail(null);
  }, [reload]);

  // M1.2：低频轮询刷新状态（不调用模型；页面可见时才刷新）
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [reload]);

  const importDocuments = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickFiles('documents');
      if (!picked || picked.paths.length === 0) return;
      const result = await api.importPaths({ ticket: picked.ticket, projectId });
      if (result.failed.length > 0) {
        setError(result.failed.map((f) => `${f.path}: ${f.message}`).join('\n'));
      }
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // 文件夹导入：递归导入目录内 .md/.txt/.json（跳过 node_modules、密钥类文件）
  const importFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickFiles('directory');
      if (!picked || picked.paths.length === 0) return;
      const result = await api.importFolder({ ticket: picked.ticket, projectId });
      const summary = `文件夹导入完成：${result.scanned} 个文件进入分析队列`;
      if (result.failed.length > 0) {
        setError(
          `${summary}；${result.failed.length} 个文件被跳过：\n` +
            result.failed.map((f) => `${f.path}: ${f.message}`).join('\n'),
        );
      } else {
        setError(null);
      }
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const importChatgptExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickFiles('chatgptExport');
      if (!picked || picked.paths.length === 0) return;
      const result = await api.importPaths({ ticket: picked.ticket, projectId });
      if (result.failed.length > 0) {
        setError(result.failed.map((f) => `${f.path}: ${f.message}`).join('\n'));
      }
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    setError(null);
    try {
      const source = await api.getSource(id);
      if (!source) throw new Error('来源不存在');
      const result = await api.getSourceSegments({ sourceId: id, offset: 0, limit: PAGE_SIZE });
      setDetail({ source, segments: result.segments, total: result.total });
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const loadMore = async () => {
    if (!detail) return;
    const next = await api.getSourceSegments({
      sourceId: detail.source.id,
      offset: detail.segments.length,
      limit: PAGE_SIZE,
    });
    setDetail({ ...detail, segments: detail.segments.concat(next.segments), total: next.total });
  };

  const archiveOne = async (id: string, title: string) => {
    const hint = window.prompt(
      `把「${title}」归档为过往工作？可改一句经验摘要（取消则不归档）。`,
      '',
    );
    if (hint === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.archiveSource({ sourceId: id, summary: hint.trim() || null });
      if (detail?.source.id === id) {
        const source = await api.getSource(id);
        if (source) setDetail({ ...detail, source });
      }
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const unarchiveOne = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.unarchiveSource(id);
      if (detail?.source.id === id) {
        const source = await api.getSource(id);
        if (source) setDetail({ ...detail, source });
      }
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const retryAnalysis = async (id: string) => {
    setError(null);
    try {
      await api.reextractSource(id);
      await reload(true);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const removeSource = async (id: string) => {
    const ok = window.confirm('删除该来源？对话片段和从它抽出的理解会删除，Vault 原文副本保留。');
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteSource(id);
      setDetail(null);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    if (!list) return;
    setSelected(checked ? new Set(list.map((item) => item.source.id)) : new Set());
  };

  const archiveSelected = async () => {
    if (selected.size === 0) return;
    const ok = window.confirm(
      `把选中的 ${selected.size} 个来源归档为过往工作？会留下短经验摘要，原文可查，不再进待讨论。`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    const ids = [...selected];
    const failed: string[] = [];
    try {
      for (const id of ids) {
        try {
          await api.archiveSource({ sourceId: id, summary: null });
        } catch (err) {
          failed.push(`${id}: ${errMsg(err)}`);
        }
      }
      await reload();
      if (failed.length > 0) setError(`部分归档失败：\n${failed.join('\n')}`);
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (selected.size === 0) return;
    const ok = window.confirm(
      `删除选中的 ${selected.size} 个来源？对话片段和从它们抽出的理解会删除，Vault 原文副本保留。`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    const ids = [...selected];
    const failed: string[] = [];
    try {
      for (const id of ids) {
        try {
          await api.deleteSource(id);
        } catch (err) {
          failed.push(`${id}: ${errMsg(err)}`);
        }
      }
      if (detail && ids.includes(detail.source.id)) setDetail(null);
      setSelected(new Set());
      await reload();
      if (failed.length > 0) setError(`部分删除失败：\n${failed.join('\n')}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="page-sources">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card
        title="来源"
        testId="sources-card"
        actions={
          <>
            <select
              value={projectId ?? ''}
              onChange={(e) => onProjectChange(e.target.value || null)}
              data-testid="sources-project-filter"
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button disabled={busy} onClick={importDocuments} testId="sources-import-docs">
              导入文档
            </Button>
            <Button disabled={busy} onClick={importFolder} testId="sources-import-folder">
              导入文件夹
            </Button>
            <Button disabled={busy} onClick={importChatgptExport} testId="sources-import-chatgpt">
              导入 ChatGPT 导出
            </Button>
            {selected.size > 0 && (
              <>
                <Button
                  disabled={busy}
                  onClick={() => void archiveSelected()}
                  testId="sources-archive-selected"
                >
                  归档选中（{selected.size}）
                </Button>
                <Button
                  kind="danger"
                  disabled={busy}
                  onClick={() => void removeSelected()}
                  testId="sources-delete-selected"
                >
                  删除选中（{selected.size}）
                </Button>
              </>
            )}
          </>
        }
      >
        <p className="note">
          原文导入后永久保留、只读。导入相同内容会自动去重。授权只覆盖你在对话框中明确选择的文件。
          ChatGPT 历史导出是一次性导入；浏览器扩展只采集当前打开且可见的对话，不是后台读取整个账号。
          过往工作请「归档」：留下一句经验摘要，原文可检索，不当现行目标、不进待讨论。无营养问答可直接删除。
          Gemini / Grok / Claude 历史导入需脱敏导出样本后才能接入，本版未伪称已支持。
        </p>
        {list === null ? (
          <Spinner />
        ) : list.length === 0 ? (
          <Empty testId="sources-empty">还没有来源。点击“导入文档”开始。</Empty>
        ) : (
          <table className="table" data-testid="sources-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    checked={list.length > 0 && selected.size === list.length}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                    aria-label="全选当前列表"
                    data-testid="sources-select-all"
                  />
                </th>
                <th>标题</th>
                <th>所属项目</th>
                <th>类型</th>
                <th>状态</th>
                <th>片段</th>
                <th>条目</th>
                <th>最近收到内容</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => {
                const status = analysisStatus(item, captureFlags);
                const checked = selected.has(item.source.id);
                return (
                  <tr
                    key={item.source.id}
                    onClick={() => void openDetail(item.source.id)}
                    className="row-click"
                    data-testid={`source-row-${item.source.id}`}
                  >
                    <td className="col-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleSelected(item.source.id, e.target.checked)}
                        aria-label={`选择 ${item.source.title}`}
                        data-testid={`source-select-${item.source.id}`}
                      />
                    </td>
                    <td>{item.source.title}</td>
                    <td>{item.projectName ?? '未归属'}</td>
                    <td>{sourceKindLabel(item.source.kind)}</td>
                    <td data-testid={`source-status-${item.source.id}`}>
                      <span className={status.tone}>{status.text}</span>
                      {status.detail && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {status.detail}
                        </div>
                      )}
                      {item.source.archived_at ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            void unarchiveOne(item.source.id);
                          }}
                        >
                          恢复活跃
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            void archiveOne(item.source.id, item.source.title);
                          }}
                        >
                          归档
                        </button>
                      )}
                      {item.analysis.lastJobStatus === 'failed' && !item.source.archived_at && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            void retryAnalysis(item.source.id);
                          }}
                        >
                          重试
                        </button>
                      )}
                    </td>
                    <td>{item.segmentCount}</td>
                    <td>{item.itemCount}</td>
                    <td>{item.source.imported_at.slice(0, 19).replace('T', ' ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {detail && (
        <SourceDetail
          detail={detail}
          projects={projects}
          onClose={() => setDetail(null)}
          onLoadMore={loadMore}
          onDelete={() => removeSource(detail.source.id)}
          onArchive={() => void archiveOne(detail.source.id, detail.source.title)}
          onUnarchive={() => void unarchiveOne(detail.source.id)}
          onReanalyze={async () => {
            await retryAnalysis(detail.source.id);
            // 重进详情拿最新状态（分析任务状态由轮询更新列表）
            const source = await api.getSource(detail.source.id);
            if (source) setDetail({ ...detail, source });
          }}
          onProjectBound={async (projectId) => {
            await api.bindSourceProject({ sourceId: detail.source.id, projectId });
            await reload();
            const source = await api.getSource(detail.source.id);
            if (source) setDetail({ ...detail, source });
          }}
        />
      )}
    </div>
  );
}

function SourceDetail({
  detail,
  projects,
  onClose,
  onLoadMore,
  onDelete,
  onArchive,
  onUnarchive,
  onReanalyze,
  onProjectBound,
}: {
  detail: { source: Source; segments: Segment[]; total: number };
  projects: Project[];
  onClose: () => void;
  onLoadMore: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  /** P3：详情内直接触发重新分析（不止失败态可重试） */
  onReanalyze: () => Promise<void>;
  onProjectBound: (projectId: string | null) => Promise<void>;
}) {
  const { source, segments, total } = detail;
  const [context, setContext] = useState<{
    segment: Segment;
    before: string;
    after: string;
    sourceTitle: string;
  } | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);

  const showContext = async (segment: Segment) => {
    setCtxError(null);
    try {
      const result = await api.getSegmentContext({
        segmentId: segment.id,
        beforeChars: 600,
        afterChars: 600,
      });
      setContext(result);
    } catch (err) {
      setCtxError(errMsg(err));
    }
  };

  return (
    <Card
      title={
        <>
          <span data-testid="source-detail-title">{source.title}</span>
          <span className="badge">{sourceKindLabel(source.kind)}</span>
          <span className="badge">{providerLabel(source.provider)}</span>
        </>
      }
      testId="source-detail"
      actions={
        <>
          {source.archived_at ? (
            <Button onClick={onUnarchive} testId="source-unarchive">
              恢复活跃
            </Button>
          ) : (
            <Button onClick={onArchive} testId="source-archive">
              归档为过往工作
            </Button>
          )}
          <Button
            onClick={() => void onReanalyze()}
            testId="source-reanalyze"
            disabled={Boolean(source.archived_at)}
          >
            重新分析
          </Button>
          <Button kind="danger" onClick={onDelete} testId="source-delete">
            删除来源
          </Button>
          <Button kind="ghost" onClick={onClose} testId="source-detail-close">
            关闭
          </Button>
        </>
      }
    >
      {ctxError && <ErrorBanner message={ctxError} onDismiss={() => setCtxError(null)} />}
      <div className="field-row">
        <label className="muted">所属项目（一次归属，后续新增内容继承）</label>
        <select
          value={source.project_id ?? ''}
          onChange={(e) => void onProjectBound(e.target.value || null)}
          data-testid="source-project-select"
        >
          <option value="">未归属</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {source.archived_at && (
        <p className="note" data-testid="source-archive-summary">
          已归档。经验摘要：{source.archive_summary ?? '（无）'}
          原文仍可检索；不当现行目标，不进待讨论。
        </p>
      )}
      <p className="note">
        共 {total} 个片段；显示 {segments.length} 个。点击“上下文”查看该片段前后原文（证据核验）。
        「重新分析」把当前片段重新交给模型提取（人工确认/纠正的内容受保护，不会被覆盖）。
      </p>
      <div className="segment-list" data-testid="segment-list">
        {segments.map((seg) => (
          <article key={seg.id} className={`segment role-${seg.role}`}>
            <header>
              <span className="role-tag">{roleLabel(seg.role)}</span>
              {seg.occurred_at && (
                <span className="muted">{seg.occurred_at.slice(0, 19).replace('T', ' ')}</span>
              )}
              {!seg.is_active_branch && <span className="badge badge-muted">非活动分支</span>}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void showContext(seg)}
                data-testid={`segment-context-${seg.id}`}
              >
                上下文
              </button>
            </header>
            <pre className="segment-text">{seg.text}</pre>
          </article>
        ))}
      </div>
      {segments.length < total && (
        <div className="wizard-nav">
          <Button onClick={onLoadMore} testId="source-load-more">
            加载更多（{segments.length}/{total}）
          </Button>
        </div>
      )}
      {context && (
        <div className="context-panel" data-testid="context-panel">
          <header>
            <h3>上下文核验 — {context.sourceTitle}</h3>
            <Button kind="ghost" onClick={() => setContext(null)}>
              关闭
            </Button>
          </header>
          <pre className="segment-text">{context.before}</pre>
          <pre className="segment-text segment-focus">{context.segment.text}</pre>
          <pre className="segment-text">{context.after}</pre>
        </div>
      )}
    </Card>
  );
}
