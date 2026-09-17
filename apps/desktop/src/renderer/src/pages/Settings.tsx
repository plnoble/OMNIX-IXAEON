import { useCallback, useEffect, useState } from 'react';
import {
  api,
  errMsg,
  type AuditEvent,
  type ExportResult,
  type RestorePreview,
  type SettingsView,
  type UpdateStatusView,
} from '../api.js';
import { Button, Card, ErrorBanner, Field, Spinner } from '../ui.js';

/** 恢复预览状态（含所选 ZIP 路径）。 */
type RestorePreviewState = RestorePreview & { zipPath: string };

/**
 * 应用更新卡片（GitHub 发版）：检查新版本、显示下载状态、
 * 下载完成后由用户点击安装（不自动重启）。开发运行时能力不存在 → 不显示。
 */
function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    const updates = window.ixaeonUpdates;
    if (!updates) return; // 开发运行（preload 未暴露更新能力）
    const off = updates.onStatus((s) => setStatus(s));
    void updates
      .get()
      .then(setStatus)
      .catch(() => undefined);
    return () => {
      off();
    };
  }, []);

  const check = async () => {
    const updates = window.ixaeonUpdates;
    if (!updates) return;
    setChecking(true);
    setUpdateError(null);
    try {
      setStatus(await updates.check());
    } catch (err) {
      setUpdateError(errMsg(err));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    const updates = window.ixaeonUpdates;
    if (!updates) return;
    try {
      const result = await updates.install();
      if (!result.ok) setUpdateError('更新尚未下载完成，请稍后再试');
    } catch (err) {
      setUpdateError(errMsg(err));
    }
  };

  // 生产构建但能力缺失（异常情形）或用户明确无需更新提示时不渲染主体
  return (
    <Card title="应用更新" testId="settings-update">
      <p className="note">
        通过 GitHub Releases 检查与下载更新（plnoble/OMNIX-IXAEON）。
        下载完成后需你点击安装；不会自动重启应用。
      </p>
      {updateError && <p className="warn">{updateError}</p>}
      {status?.state === 'ready' && status.version && (
        <p className="ok-banner" data-testid="update-ready">
          新版本 {status.version} 已下载完成。
          <Button kind="primary" onClick={install} testId="update-install">
            重启并安装
          </Button>
        </p>
      )}
      {status?.state === 'downloading' && status.version && (
        <p className="note" data-testid="update-downloading">
          正在下载新版本 {status.version}
          {status.downloadPercent != null ? `（${status.downloadPercent}%）` : '…'}
          ，可继续使用，下载完成后再安装
        </p>
      )}
      {status?.state === 'error' && (
        <p className="warn" data-testid="update-error">
          更新检查失败：{status.error ?? '未知错误'}（不影响当前使用，可稍后重试）
        </p>
      )}
      {status?.state === 'none' && (
        <p className="note" data-testid="update-none">
          当前已是最新版本。
        </p>
      )}
      <div className="wizard-nav">
        <Button disabled={checking} onClick={check} testId="update-check">
          {checking ? '检查中…' : '检查更新'}
        </Button>
      </div>
    </Card>
  );
}

/**
 * P4：Door 子设备管理卡片。
 * - 配对：桌面端录入静态规格，颁发设备令牌（原文只显示一次，由用户转交设备）；
 * - 设备自身经本机 HTTP /api/door/heartbeat 上报低负载遥测与实测结果；
 * - 撤销后立即拒绝心跳与派发（持久化，重启保持）。
 */
function DoorCard() {
  type DoorDeviceView = Awaited<ReturnType<typeof api.listDoorDevices>>[number];
  const [devices, setDevices] = useState<DoorDeviceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<{ id: string; rawToken: string } | null>(null);
  const [form, setForm] = useState({
    name: '',
    platform: 'linux' as 'linux' | 'darwin' | 'win32' | 'android' | 'ios',
    capabilities: 'index',
    cpuCores: 8,
    totalRamMb: 16384,
    storageGb: 512,
    availableLocalModels: '',
  });

  const reload = useCallback(async () => {
    try {
      setDevices(await api.listDoorDevices());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pair = async () => {
    if (form.name.trim().length === 0) {
      setError('请先填写设备名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.pairDoorDevice({
        name: form.name.trim(),
        platform: form.platform,
        capabilities: form.capabilities
          .split(/[,，\s]+/)
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
        cpuCores: form.cpuCores,
        totalRamMb: form.totalRamMb,
        storageGb: form.storageGb,
        availableLocalModels: form.availableLocalModels
          .split(/[,，\s]+/)
          .map((m) => m.trim())
          .filter((m) => m.length > 0),
      });
      setNewToken(result);
      setForm({ ...form, name: '' });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api.revokeDoorDevice({ id });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Door 子设备（P4）" testId="settings-door">
      <p className="muted">
        配对后颁发设备令牌（只显示一次，请转交设备端保存）。设备经本机{' '}
        <code>POST /api/door/heartbeat</code>（Bearer 设备令牌）上报低负载状态；主动实测经{' '}
        <code>/api/door/benchmark</code>{' '}
        上报，带生存期，过期后任务评估要求重测。撤销后立即拒绝心跳与派发。
      </p>
      {error && <p className="warn">{error}</p>}
      {newToken && (
        <div className="ok-banner" data-testid="door-new-token">
          设备已配对。
          <br />
          设备令牌（仅此一次显示）：
          <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{newToken.rawToken}</code>
        </div>
      )}
      <Field label="设备名称">
        <input
          value={form.name}
          placeholder="如：我的 NAS / 日常手机"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          data-testid="door-pair-name"
        />
      </Field>
      <Field label="平台">
        <select
          value={form.platform}
          onChange={(e) => setForm({ ...form, platform: e.target.value as typeof form.platform })}
          data-testid="door-pair-platform"
        >
          <option value="linux">Linux（NAS/服务器）</option>
          <option value="win32">Windows</option>
          <option value="darwin">macOS</option>
          <option value="android">Android</option>
          <option value="ios">iOS</option>
        </select>
      </Field>
      <Field label="获准能力（逗号分隔）" hint="如 index, verify, research_read">
        <input
          value={form.capabilities}
          onChange={(e) => setForm({ ...form, capabilities: e.target.value })}
          data-testid="door-pair-capabilities"
        />
      </Field>
      <Field label="本机模型（逗号分隔，可空）">
        <input
          value={form.availableLocalModels}
          placeholder="如 qwen2.5:7b"
          onChange={(e) => setForm({ ...form, availableLocalModels: e.target.value })}
          data-testid="door-pair-models"
        />
      </Field>
      <div className="field-row">
        <Field label="CPU 核数">
          <input
            type="number"
            min={1}
            value={form.cpuCores}
            onChange={(e) => setForm({ ...form, cpuCores: Number(e.target.value) || 1 })}
          />
        </Field>
        <Field label="总内存 (MB)">
          <input
            type="number"
            min={256}
            value={form.totalRamMb}
            onChange={(e) => setForm({ ...form, totalRamMb: Number(e.target.value) || 256 })}
          />
        </Field>
        <Field label="存储 (GB)">
          <input
            type="number"
            min={1}
            value={form.storageGb}
            onChange={(e) => setForm({ ...form, storageGb: Number(e.target.value) || 1 })}
          />
        </Field>
      </div>
      <div className="wizard-nav">
        <Button kind="primary" disabled={busy} onClick={() => void pair()} testId="door-pair-btn">
          {busy ? '配对中…' : '配对新设备'}
        </Button>
      </div>
      {devices === null ? (
        <Spinner />
      ) : devices.length === 0 ? (
        <p className="empty">尚未配对任何子设备。</p>
      ) : (
        <ul className="audit-list" data-testid="door-device-list">
          {devices.map((d) => (
            <li key={d.id}>
              <strong>{d.name}</strong>
              <span className="muted">
                {' '}
                {d.platform} · {d.status} · 心跳 {d.lastHeartbeatAt.slice(0, 19).replace('T', ' ')}
              </span>
              {d.telemetry && (
                <span className="muted">
                  {' '}
                  · 可用内存 {d.telemetry.availableRamMb}MB
                  {d.telemetry.batteryPct !== null ? ` · 电量 ${d.telemetry.batteryPct}%` : ''}
                  {d.benchmarks.length > 0
                    ? ` · 实测 ${d.benchmarks
                        .map(
                          (b) =>
                            `${b.kind}@${new Date(b.expiresAt) > new Date() ? '有效' : '过期'}`,
                        )
                        .join(', ')}`
                    : ''}
                </span>
              )}
              {d.status !== 'revoked' && (
                <Button
                  kind="danger"
                  disabled={busy}
                  onClick={() => void revoke(d.id)}
                  testId={`door-revoke-${d.id.slice(0, 8)}`}
                >
                  撤销
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 设置页：模型接入、采集开关、扩展配对、MCP 接入片段、导出恢复、最近操作。 */
export function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [form, setForm] = useState({ modelName: '', apiBaseUrl: '', apiKey: '' });
  const [models, setModels] = useState<Array<{ id: string }> | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreviewState | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [searchForm, setSearchForm] = useState<{
    provider: 'none' | 'brave' | 'tavily' | 'tinyfish';
    apiKey: string;
  }>({ provider: 'none', apiKey: '' });
  const [searchTest, setSearchTest] = useState<{
    busy: boolean;
    result: string | null;
  }>({ busy: false, result: null });

  const reload = useCallback(async () => {
    try {
      const [v, e] = await Promise.all([api.getSettings(), api.listAuditEvents(20)]);
      setView(v);
      setEvents(e);
      setForm({
        modelName: v.config.modelName,
        apiBaseUrl: v.config.apiBaseUrl,
        apiKey: '',
      });
      setSearchForm({
        provider: v.config.webSearchProvider ?? 'none',
        apiKey: '',
      });
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const fetchModels = async () => {
    // Key 优先用输入框的（明文，仅本次请求）；已保存则可留空用已保存的？
    // —— 已保存的 Key 不回显也不可读，因此拉列表要求输入框里有 Key。
    if (form.apiKey.trim().length === 0) {
      setError('请先在下方输入 API Key，再获取可用模型（已保存的 Key 不可回读）');
      return;
    }
    setFetchingModels(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.listAvailableModels({
        apiBaseUrl: form.apiBaseUrl.trim(),
        apiKey: form.apiKey.trim(),
      });
      setModels(result.models);
      setNotice(`获取到 ${result.models.length} 个可用模型，请在下拉框中选择`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setFetchingModels(false);
    }
  };

  const saveModel = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveModelSettings({
        modelName: form.modelName.trim() || 'gpt-5.2',
        apiBaseUrl: form.apiBaseUrl,
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

  const saveWebSearch = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveWebSearchSettings({
        provider: searchForm.provider,
        apiKey: searchForm.apiKey.trim() || undefined,
      });
      setNotice('搜索设置已保存');
      setSearchTest({ busy: false, result: null });
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const testWebSearch = async () => {
    setSearchTest({ busy: true, result: null });
    setError(null);
    try {
      const result = await api.testWebSearch({
        query: '今天上海天气 公开信息',
        apiKey: searchForm.apiKey.trim() || undefined,
      });
      const first = result.hits[0];
      setSearchTest({
        busy: false,
        result:
          result.hits.length === 0
            ? `${result.provider} 连通成功，但该查询无结果（Key 有效）`
            : `${result.provider} 连通成功：${result.hits.length} 条结果，如「${first?.title?.slice(0, 40) ?? ''}」`,
      });
    } catch (err) {
      setSearchTest({ busy: false, result: null });
      setError(errMsg(err));
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

  const toggleAskCapture = async (enable: boolean) => {
    setBusy(true);
    try {
      if (enable) {
        await api.enableAskCapture();
      } else {
        await api.disableAskCapture();
      }
      await reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // --- 导出 / 恢复（M5；票据制：目标与来源都来自原生对话框） ---

  const showPairingCode = async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await api.generatePairingCode());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

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

      <UpdateCard />

      <Card title="Agent 运行时（Hermes）" testId="settings-hermes">
        <p className={view.hermesFound ? 'note' : 'warn'} data-testid="settings-hermes-notice">
          {view.hermesNotice || '尚未探测 Hermes。'}
        </p>
        <p className="muted">
          不偷偷安装。需要锁定版本、专属目录和你的批准后，才接 stdio
          会话。当前问答仍是单轮检索，不是完整工具循环。
        </p>
      </Card>

      <Card title="模型接入" testId="settings-model">
        {/* RF08：旧明文密钥被清除时明确提示重新输入（可理解、可恢复，不静默） */}
        {view.apiKeyNeedsReentry && !view.config.apiKeyPresent && (
          <p className="warn" data-testid="settings-apikey-reentry">
            检测到旧版本以可解码格式保存的 API Key：为满足「永不明文落盘」，它已被从磁盘清除。
            请重新输入 API Key；重新输入将在系统加密可用时以加密形式保存。
          </p>
        )}
        <Field label="API 地址" hint="OpenAI 兼容端点；留空表示官方默认">
          <input
            value={form.apiBaseUrl}
            onChange={(e) => {
              setForm({ ...form, apiBaseUrl: e.target.value });
              setModels(null);
            }}
            placeholder="https://api.deepseek.com/v1"
            data-testid="settings-api-base"
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
        <Field label="模型名称">
          {models ? (
            <select
              value={form.modelName}
              onChange={(e) => setForm({ ...form, modelName: e.target.value })}
              data-testid="settings-model-select"
            >
              <option value="">（选择模型）</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={form.modelName}
              onChange={(e) => setForm({ ...form, modelName: e.target.value })}
              data-testid="settings-model-name"
            />
          )}
        </Field>
        <div className="wizard-nav">
          <Button disabled={fetchingModels} onClick={fetchModels} testId="settings-fetch-models">
            {fetchingModels ? '获取中…' : '获取可用模型'}
          </Button>
          <Button kind="primary" disabled={busy} onClick={saveModel} testId="settings-model-save">
            保存
          </Button>
        </div>
      </Card>

      <Card title="网页搜索（研究用）" testId="settings-websearch">
        <p className="muted">
          给 B3 研究提供真实 URL 搜索。查询发出前会本地脱敏（邮箱/路径/密钥）； 不配置时 search_web
          诚实失败，不伪造结果。Key 用系统加密保存，不回显。
        </p>
        <Field label="搜索服务">
          <select
            value={searchForm.provider}
            onChange={(e) => {
              setSearchForm({
                ...searchForm,
                provider: e.target.value as 'none' | 'brave' | 'tavily' | 'tinyfish',
              });
              setSearchTest({ busy: false, result: null });
            }}
            data-testid="settings-websearch-provider"
          >
            <option value="none">不配置（诚实失败）</option>
            <option value="brave">Brave Search API</option>
            <option value="tavily">Tavily API</option>
            <option value="tinyfish">TinyFish API (Web Agent)</option>
          </select>
        </Field>
        {searchForm.provider !== 'none' && (
          <Field
            label="API Key"
            hint={view.config.webSearchKeyPresent ? '已保存（不回显）' : '未配置'}
          >
            <input
              type="password"
              value={searchForm.apiKey}
              placeholder="留空保持不变"
              onChange={(e) => setSearchForm({ ...searchForm, apiKey: e.target.value })}
              data-testid="settings-websearch-key"
            />
          </Field>
        )}
        <div className="wizard-nav">
          {searchForm.provider !== 'none' && (
            <Button
              disabled={searchTest.busy}
              onClick={() => void testWebSearch()}
              testId="settings-websearch-test"
            >
              {searchTest.busy ? '测试中…' : '测试搜索（真实查询一次）'}
            </Button>
          )}
          <Button
            kind="primary"
            disabled={busy}
            onClick={saveWebSearch}
            testId="settings-websearch-save"
          >
            保存
          </Button>
        </div>
        {searchTest.result && (
          <p className="ok-banner" data-testid="settings-websearch-test-result">
            {searchTest.result}
          </p>
        )}
      </Card>

      <Card title="网页采集（ChatGPT 扩展）" testId="settings-capture">
        <p className="note">
          {view.config.extensionPaired
            ? `扩展已配对。最近同步：${view.config.extensionLastSyncAt?.slice(0, 19).replace('T', ' ') ?? '无'}`
            : '扩展未配对。用下面目录加载扩展，再点「显示配对码」。'}
        </p>
        {view.extensionLoadDir ? (
          <p className="note" data-testid="settings-extension-dir">
            Chrome / Edge：打开 <code>chrome://extensions</code> → 开发者模式 →
            加载已解压的扩展程序，选
            <br />
            <code>{view.extensionLoadDir}</code>
            <br />
            只采集当前打开的 chatgpt.com 对话。改完扩展后重启 IXAEON 再刷新扩展。
          </p>
        ) : (
          <p className="warn">
            本包没有找到扩展文件。请用仓库 <code>apps/extension/dist</code> 加载。
          </p>
        )}
        <p className="note">
          边界说明：已经发出的模型请求无法撤回；关闭开关或暂停对话只阻止后续调用。
          暂停的对话会保留「待分析」状态，恢复后处理最新内容。 扩展只采集当前打开且可见的
          chatgpt.com 对话，不是后台读取整个账号；未打开的对话与手机端不同步。
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
        <div className="wizard-nav">
          <Button
            disabled={busy}
            onClick={() => void showPairingCode()}
            testId="settings-pair-code"
          >
            {view.config.extensionPaired ? '重新配对（显示新配对码）' : '显示配对码'}
          </Button>
        </div>
        {pairing && (
          <p className="ok-banner" data-testid="settings-pair-code-value">
            配对码 <strong style={{ fontSize: 22, letterSpacing: 4 }}>{pairing.code}</strong>
            （约 10 分钟内有效）。在浏览器扩展弹窗中输入。
          </p>
        )}
      </Card>

      <Card title="桌面问答存档（Ask Capture）" testId="settings-ask-capture">
        <p className="note">
          {view.askCaptureStatus === 'enabled'
            ? '问答存档已启用：桌面问答对会自动记入 Core 来源库，并生成理解候选。'
            : '问答存档已撤销：桌面提问不再保存为问答来源，停止生成新的理解候选。'}
        </p>
        <p className="muted">
          A03（独立审核 2026-09-13）：撤销问答存档后，重启与后续提问均保持停用状态，
          普通提问不会隐式重新授权。若需重新存档，请点击下方开关显式恢复。
        </p>
        <div className="field-row">
          <label className="check">
            <input
              type="checkbox"
              checked={view.askCaptureStatus === 'enabled'}
              disabled={busy}
              onChange={(e) => void toggleAskCapture(e.target.checked)}
              data-testid="settings-ask-capture-toggle"
            />
            <span>启用桌面问答自动存档与理解提取</span>
          </label>
        </div>
      </Card>

      <DoorCard />

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
