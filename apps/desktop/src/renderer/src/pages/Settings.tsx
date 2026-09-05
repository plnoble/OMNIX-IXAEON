import { useCallback, useEffect, useState } from 'react';
import {
  api,
  errMsg,
  type AuditEvent,
  type ExportResult,
  type RestorePreview,
  type SettingsView,
} from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';

/** 恢复预览状态（含所选 ZIP 路径）。 */
type RestorePreviewState = RestorePreview & { zipPath: string };

/** 设置页：模型接入、采集开关、扩展配对、MCP 接入片段、导出恢复、最近操作。 */
export function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ modelName: '', apiKey: '' });
  const [restorePreview, setRestorePreview] = useState<RestorePreviewState | null>(null);

  const reload = useCallback(async () => {
    try {
      const [v, e] = await Promise.all([api.getSettings(), api.listAuditEvents(20)]);
      setView(v);
      setEvents(e);
      setForm({ modelName: v.config.modelName, apiKey: '' });
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveModel = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveModelSettings({
        modelName: form.modelName.trim() || 'gpt-5.2',
        apiKey: form.apiKey.trim() || undefined,
      });
      setNotice('模型设置已保存');
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleCapture = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.setCaptureEnabled(enabled);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoAnalyze = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.setAutoAnalyze(enabled);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // --- 导出 / 恢复（M5；票据制：目标与来源都来自原生对话框） ---

  const doExport = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const picked = await api.pickSaveZip('ixaeon-export.zip');
      if (!picked || picked.paths.length === 0) return;
      const result: ExportResult = await api.exportData({ ticket: picked.ticket });
      setNotice(
        `已导出 ${result.fileCount} 个文件（${result.totalChars} 字符）到 ${result.zipPath}`,
      );
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const doPreviewRestore = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setRestorePreview(null);
    try {
      const picked = await api.pickRestoreZip();
      if (!picked || picked.paths.length === 0) return;
      const preview = await api.previewRestore({ ticket: picked.ticket });
      setRestorePreview({ ...preview, zipPath: picked.paths[0]! });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    if (!restorePreview) return;
    setBusy(true);
    setError(null);
    try {
      // 恢复必须携带预览凭证（主进程一次性消费；未预览直接恢复会被拒绝）
      await api.restoreData({ previewToken: restorePreview.previewToken });
      setRestorePreview(null);
      setNotice('恢复完成。请重启应用以加载恢复的数据（旧数据已自动备份）。');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (view === null) {
    return (
      <div data-testid="page-settings">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <Spinner />
      </div>
    );
  }

  return (
    <div data-testid="page-settings">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <div className="ok-banner">{notice}</div>}

      <Card title="模型接入" testId="settings-model">
        <Field label="模型名称">
          <input
            value={form.modelName}
            onChange={(e) => setForm({ ...form, modelName: e.target.value })}
            data-testid="settings-model-name"
          />
        </Field>
        <Field label="API Key" hint={view.config.apiKeyPresent ? '已保存（不回显）' : '未配置'}>
          <input
            type="password"
            value={form.apiKey}
            placeholder="sk-…（留空保持不变）"
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            data-testid="settings-api-key"
          />
        </Field>
        <div className="wizard-nav">
          <Button kind="primary" disabled={busy} onClick={saveModel} testId="settings-model-save">
            保存
          </Button>
        </div>
      </Card>

      <Card title="网页采集（ChatGPT 扩展）" testId="settings-capture">
        <p className="note">
          {view.config.extensionPaired
            ? `扩展已配对。最近同步：${view.config.extensionLastSyncAt?.slice(0, 19).replace('T', ' ') ?? '无'}`
            : '扩展未配对。安装浏览器扩展后，在弹窗中输入配对码。'}
        </p>
        <p className="note">
          边界说明：已经发出的模型请求无法撤回；关闭开关或暂停对话只阻止后续调用。
          暂停的对话会保留「待分析」状态，恢复后处理最新内容。
        </p>
        <div className="field-row">
          <label className="check">
            <input
              type="checkbox"
              checked={view.config.captureEnabled}
              disabled={busy}
              onChange={(e) => void toggleCapture(e.target.checked)}
              data-testid="settings-capture-toggle"
            />
            <span>启用采集（总开关）</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={view.config.autoAnalyze}
              disabled={busy}
              onChange={(e) => void toggleAutoAnalyze(e.target.checked)}
              data-testid="settings-autoanalyze-toggle"
            />
            <span>采集后自动提交提取</span>
          </label>
        </div>
      </Card>

      <Card title="MCP 接入（编码 AI）" testId="settings-mcp">
        <p className="note">
          把下面的片段加入 Codex / Claude Code / Cursor 配置即可接入本机服务。
          令牌已内嵌（仅本机有效；泄露不会暴露文件系统，但可读写工作记录）。
        </p>
        <pre className="code-block" data-testid="settings-mcp-snippet">
          {view.mcp.snippet}
        </pre>
        <p className="note">
          本地令牌：<code data-testid="settings-mcp-token">{view.mcp.localToken ?? '未生成'}</code>
        </p>
      </Card>

      <Card title="本地数据" testId="settings-data">
        <p className="note">
          数据目录：<code>{view.dataDir}</code>
        </p>
        <p className="warn">{view.encryptionNotice}</p>
        <div className="field-row">
          <Button onClick={() => void api.openLogsFolder()} testId="settings-open-logs">
            打开日志目录
          </Button>
          <Button
            kind="primary"
            disabled={busy}
            onClick={() => void doExport()}
            testId="settings-export"
          >
            导出全部数据（ZIP）
          </Button>
          <Button
            disabled={busy}
            onClick={() => void doPreviewRestore()}
            testId="settings-restore-pick"
          >
            从导出包恢复…
          </Button>
        </div>

        {restorePreview && (
          <div className="restore-preview" data-testid="settings-restore-preview">
            <h4>恢复预览</h4>
            <ul>
              <li>
                导出时间：<code>{restorePreview.exportedAt.slice(0, 19).replace('T', ' ')}</code>
                （应用版本 {restorePreview.appVersion || '未知'}）
              </li>
              <li>
                包含：{restorePreview.counts.projects ?? 0} 项目 /{' '}
                {restorePreview.counts.sources ?? 0} 来源 / {restorePreview.counts.items ?? 0}{' '}
                条结论
              </li>
              {restorePreview.projects.length > 0 && (
                <li>项目：{restorePreview.projects.map((p) => p.name).join('、')}</li>
              )}
              {restorePreview.warnings.map((w) => (
                <li key={w} className="warn">
                  ⚠ {w}
                </li>
              ))}
            </ul>
            <div className="wizard-nav">
              <Button
                kind="danger"
                disabled={busy}
                onClick={() => void doRestore()}
                testId="settings-restore-confirm"
              >
                确认恢复（替换当前全部数据）
              </Button>
              <Button onClick={() => setRestorePreview(null)}>取消</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="最近操作（审计）" testId="settings-audit">
        {events === null || events.length === 0 ? (
          <p className="empty">暂无记录。</p>
        ) : (
          <ul className="audit-list" data-testid="audit-list">
            {events.map((e) => (
              <li key={e.id}>
                <span className="muted">{e.created_at.slice(0, 19).replace('T', ' ')}</span>
                <code>{e.kind}</code>
                <span className="muted audit-detail">{e.detail_json}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
