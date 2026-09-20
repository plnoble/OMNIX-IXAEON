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

function minutesUntil(iso: string | null): string {
  if (!iso) return '马上';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms < 60_000) return '马上';
  return `${Math.round(ms / 60_000)} 分钟后`;
}

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
    if (a.lastJobRetryCount > 0) {
      const wait = minutesUntil(a.lastJobNextAt);
      return {
        text: `模型网关暂时不通，第 ${a.lastJobRetryCount} 次自动重试，${wait === '马上' ? '马上' : `约 ${wait}`}`,
        tone: 'muted',
      };
    }
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
  if (a.analyzedRevision > 0) {
    // 引用核对不上的结论会被丢掉（其余照常入库）——成功也要把丢了几条说出来
    if (a.lastJobNote)
      return { text: '已分析（部分结论被丢弃）', detail: a.lastJobNote, tone: 'warn' };
    return { text: '已分析最新内容', tone: 'ok' };
  }
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
  const [notice, setNotice] = useState<string | null>(null);
  /** 分析失败、且未归档的来源——「全部重新分析」的对象。 */
  const failedIds = (list ?? [])
    .filter((i) => i.analysis.lastJobStatus === 'failed' && !i.source.archived_at)
    .map((i) => i.source.id);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    source: Source;
    segments: Segment[];
    total: number;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** S3b：编码代理会话选择导入。清单号 → 勾选 → 估算 → 导入。渲染层不接触路径。 */
  const [agentList, setAgentList] = useState<{
    listId: string;
    sessions: Array<{
      id: number;
      tool: 'claude_code' | 'codex';
      title: string;
      cwd: string | null;
      projectId: string | null;
      mtimeMs: number;
      size: number;
      status: 'new' | 'imported' | 'updated';
    }>;
    unrecognizedCount: number;
    subagentCount: number;
  } | null>(null);
  const [agentChecked, setAgentChecked] = useState<Set<number>>(new Set());
  const [agentEstimate, setAgentEstimate] = useState<{
    loading: boolean;
    userChars: number;
    assistantChars: number;
  } | null>(null);
  const [agentResult, setAgentResult] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);

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

  // S3b：选文件夹 → 列出会话（只用 S3a 的三个 IPC；渲染层不接触路径）
  const openAgentSessions = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickFiles('directory');
      if (!picked || picked.paths.length === 0) return;
      const result = await api.listAgentSessions({ ticket: picked.ticket });
      setAgentList(result);
      setAgentChecked(new Set());
      setAgentEstimate(null);
      setAgentResult(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const closeAgentSessions = () => {
    setAgentList(null);
    setAgentChecked(new Set());
    setAgentEstimate(null);
    setAgentResult(null);
  };

  /** 勾选变化后重新估算（一个都没勾就不显示）。 */
  const applyAgentChecks = async (next: Set<number>) => {
    setAgentChecked(next);
    setAgentResult(null);
    if (!agentList) return;
    if (next.size === 0) {
      setAgentEstimate(null);
      return;
    }
    setAgentEstimate({ loading: true, userChars: 0, assistantChars: 0 });
    try {
      const est = await api.estimateAgentSessions({ listId: agentList.listId, ids: [...next] });
      setAgentEstimate({
        loading: false,
        userChars: est.userChars,
        assistantChars: est.assistantChars,
      });
    } catch (err) {
      setAgentEstimate(null);
      setError(errMsg(err));
    }
  };

  const toggleAgentSession = (id: number, checked: boolean) => {
    const next = new Set(agentChecked);
    if (checked) next.add(id);
    else next.delete(id);
    return applyAgentChecks(next);
  };

  const selectNewAgentSessions = () => {
    if (!agentList) return;
    const next = new Set(
      [...agentList.sessions]
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .filter((s) => s.status === 'new' || s.status === 'updated')
        .map((s) => s.id),
    );
    return applyAgentChecks(next);
  };

  const importSelectedAgentSessions = async () => {
    if (!agentList || agentChecked.size === 0) return;
    setAgentBusy(true);
    setError(null);
    try {
      const r = await api.importAgentSessions({
        listId: agentList.listId,
        ids: [...agentChecked],
        projectId,
      });
      const lines = [
        `新导入 ${r.created} 个、没变化 ${r.unchanged} 个、失败 ${r.failed.length} 个`,
      ];
      for (const f of r.failed) lines.push(`${f.id}：${f.message}`);
      setAgentResult(lines.join('；'));
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setAgentBusy(false);
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
    // Electron 渲染进程里 window.prompt 常直接返回空/取消，看起来像没反应。
    const ok = window.confirm(
      `把「${title}」归档为过往工作？会留下一句短经验摘要，原文仍可检索，不再进待讨论。`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.archiveSource({ sourceId: id, summary: null });
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

  /** 一次重跑所有分析失败的来源（真机上 44 条资料里 29 条从没成功过）。 */
  const retryAllFailed = async () => {
    if (failedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.reextractSources(failedIds);
      setNotice(
        r.skipped > 0
          ? `已重新排队 ${r.queued} 条（${r.skipped} 条已归档，跳过）`
          : `已重新排队 ${r.queued} 条，稍后自动分析`,
      );
      await reload(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
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
      {notice && (
        <p className="muted" data-testid="sources-notice">
          {notice}
        </p>
      )}
      {failedIds.length > 0 && (
        <p className="muted" data-testid="sources-failed-summary">
          有 {failedIds.length} 条资料这次没分析成功（原文都在，理解没更新）。
          <Button disabled={busy} onClick={retryAllFailed} testId="sources-retry-all-failed">
            全部重新分析
          </Button>
        </p>
      )}

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
            <Button
              disabled={busy}
              onClick={openAgentSessions}
              testId="sources-import-agent-sessions"
            >
              导入编码代理会话
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
                      <span
                        className={status.tone}
                        data-testid={
                          item.analysis.lastJobStatus === 'queued' &&
                          item.analysis.lastJobRetryCount > 0
                            ? `source-retry-${item.source.id}`
                            : undefined
                        }
                      >
                        {status.text}
                      </span>
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

      {agentList && (
        <Card
          title="编码代理会话"
          testId="agent-sessions-card"
          actions={
            <Button kind="ghost" onClick={closeAgentSessions} testId="agent-sessions-close">
              关掉
            </Button>
          }
        >
          <div data-testid="agent-sessions-list">
            {[...agentList.sessions]
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .map((s) => (
                <div key={s.id} className="item-row" data-testid={`agent-session-${s.id}`}>
                  <input
                    type="checkbox"
                    checked={agentChecked.has(s.id)}
                    onChange={(e) => void toggleAgentSession(s.id, e.target.checked)}
                    aria-label={`选择 ${s.title}`}
                    data-testid={`agent-session-check-${s.id}`}
                  />
                  <span className="badge">
                    {s.tool === 'claude_code' ? 'Claude Code' : 'Codex'}
                  </span>
                  <span>{s.title}</span>
                  <span className="muted">
                    {s.projectId
                      ? (projects.find((p) => p.id === s.projectId)?.name ?? '未归属项目')
                      : '未归属项目'}
                  </span>
                  <span className="muted">
                    {new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                  <span className="muted">
                    {s.size >= 1024 * 1024
                      ? `${(s.size / 1024 / 1024).toFixed(1)} MB`
                      : `${(s.size / 1024).toFixed(1)} KB`}
                  </span>
                  <span className="badge">
                    {s.status === 'new' ? '新' : s.status === 'imported' ? '已导入' : '有更新'}
                  </span>
                </div>
              ))}
          </div>
          {(agentList.subagentCount > 0 || agentList.unrecognizedCount > 0) && (
            <p className="muted" data-testid="agent-sessions-unlisted">
              另有 {agentList.subagentCount} 个 Codex 子代理会话、{agentList.unrecognizedCount}{' '}
              个认不出的文件没列出
            </p>
          )}
          <div className="field-row">
            <Button onClick={selectNewAgentSessions} testId="agent-sessions-select-new">
              全选有更新的和新的
            </Button>
            <Button
              disabled={agentChecked.size === 0 || agentBusy}
              onClick={importSelectedAgentSessions}
              testId="agent-sessions-import"
            >
              导入选中的 {agentChecked.size} 个
            </Button>
            {agentEstimate && (
              <span className="muted" data-testid="agent-sessions-estimate">
                {agentEstimate.loading
                  ? '正在估算…'
                  : `将发给模型分析：约 ${Math.round(
                      (agentEstimate.userChars + agentEstimate.assistantChars) / 10000,
                    )} 万字（你说的 ${Math.round(agentEstimate.userChars / 10000)} 万、AI 回答 ${Math.round(
                      agentEstimate.assistantChars / 10000,
                    )} 万）`}
              </span>
            )}
          </div>
          {agentResult && <p data-testid="agent-sessions-result">{agentResult}</p>}
        </Card>
      )}

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
