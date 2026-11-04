import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  errMsg,
  type AuditEvent,
  type ExportResult,
  type RestorePreview,
  type SettingsView,
  type UpdateStatusView,
} from '../api.js';
import { Button, Card, ErrorBanner, Field } from '../ui.js';
import { MODEL_EXECUTOR_SENDS, executorLabel } from '@ixaeon/contracts';
import type { ModelProviderView } from '@ixaeon/contracts';

/** 恢复预览状态（含所选 ZIP 路径）。 */
type RestorePreviewState = RestorePreview & { zipPath: string };

/** SUB1：本机 magpie 的固定地址与 Key（magpie 本机网关的默认值，用户也可手改）。 */

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

/** 记忆桥（三周任务单 F1）：让聊天里的 Hermes 能查 IXAEON 记忆。默认关闭。 */
function HermesBridgeCard() {
  const [status, setStatus] = useState<{ enabled: boolean; blockedReason: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'note' | 'warn'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getHermesBridgeStatus());
    } catch (err) {
      setError(errMsg(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const r = await api.setHermesBridge(enabled);
      setMessage(
        r.warning
          ? { tone: 'warn', text: r.warning }
          : {
              tone: 'note',
              text: enabled
                ? '记忆桥已开启，下一次提问时生效（会开一个新的引擎会话）。'
                : '记忆桥已关闭，Hermes 查不到你的记忆了。',
            },
      );
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="记忆桥（让 Hermes 查你的记忆）" testId="settings-bridge">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <p className="muted">
        开启后，聊天里的 Hermes 可以主动查你的 IXAEON
        记忆，也能把你让它记住的事记下来（记成待你确认的记录，
        不会直接当成你的目标）。它能看到的范围和聊天时自动附带的记忆一样：含你允许给模型看的个人结论，
        不含个人聊天原文。编码工具（如 Codex）拿不到这个权限。
      </p>
      <p className="muted">
        开启时会在 Hermes 的 config.yaml 里登记 ixaeon（改之前先备份），通行令牌不写进配置文件。
        要求 Hermes 的模型网关是 HTTPS——否则查到的记忆会随对话明文发出去。
      </p>
      {status && (
        <p
          className={status.enabled ? 'note' : status.blockedReason ? 'warn' : 'muted'}
          data-testid="settings-bridge-status"
        >
          {status.enabled
            ? '当前：已开启'
            : status.blockedReason
              ? `当前：关闭。暂时不能开启——${status.blockedReason}`
              : '当前：关闭'}
        </p>
      )}
      {message && (
        <p className={message.tone} data-testid="settings-bridge-message">
          {message.text}
        </p>
      )}
      <div className="wizard-nav">
        {status?.enabled ? (
          <Button disabled={busy} onClick={() => void toggle(false)} testId="settings-bridge-off">
            {busy ? '处理中…' : '关闭记忆桥'}
          </Button>
        ) : (
          <Button
            kind="primary"
            disabled={busy || status === null || status.blockedReason !== null}
            onClick={() => void toggle(true)}
            testId="settings-bridge-on"
          >
            {busy ? '处理中…' : '开启记忆桥'}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * E6：个人记忆给聊天用（用户 2026-09-18：不想导入一份资料就逐句审核）。
 * 一次决定，代替逐条「分享给模型」。
 */
function PersonalMemoryCard() {
  const [status, setStatus] = useState<{ enabled: boolean; personalItems: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getPersonalMemoryToChat()
      .then(setStatus)
      .catch((err) => setError(errMsg(err)));
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setPersonalMemoryToChat(enabled));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="个人记忆给聊天用" testId="settings-personal-memory">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <p className="muted">
        没归到项目下的记忆（多来自你导入的个人聊天）默认不进聊天。打开后，IXAEON
        自己的聊天就能用上它们——会随提问经你的模型网关发给你选的云端模型。 Codex、Claude
        等编码工具照样拿不到。
      </p>
      {status && (
        <p className={status.enabled ? 'note' : 'muted'} data-testid="settings-personal-status">
          {status.enabled
            ? `当前：已打开（${status.personalItems} 条个人记忆可以进聊天）`
            : `当前：关闭（${status.personalItems} 条个人记忆进不了聊天）`}
        </p>
      )}
      <div className="wizard-nav">
        {status?.enabled ? (
          <Button disabled={busy} onClick={() => void toggle(false)} testId="settings-personal-off">
            {busy ? '处理中…' : '关闭'}
          </Button>
        ) : (
          <Button
            kind="primary"
            disabled={busy || status === null}
            onClick={() => void toggle(true)}
            testId="settings-personal-on"
          >
            {busy ? '处理中…' : '打开'}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** R2：本机语义检索的索引状态与重建（设置页）。 */
function SemanticIndexCard() {
  const [status, setStatus] = useState<{
    enabled: boolean;
    model: string | null;
    indexed: number;
    total: number;
    lastError: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setStatus(await api.getSemanticIndexStatus());
  }, []);

  useEffect(() => {
    void reload().catch((err) => setError(errMsg(err)));
  }, [reload]);

  const rebuild = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.rebuildSemanticIndex();
      await reload();
    } catch (err) {
      setError(errMsg(err));
      try {
        await reload();
      } catch {
        /* 重建失败仍尽量刷新状态 */
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="语义检索（本机）" testId="settings-semantic">
      <p className="note">
        {status
          ? status.enabled
            ? `已建 ${status.indexed} / ${status.total} 条${status.model ? ` · ${status.model}` : ''}`
            : '语义检索已关闭（IXAEON_EMBED_MODEL=none）。聊天按关键词选记忆。'
          : '加载中…'}
      </p>
      {status?.lastError && (
        <>
          <p className="warn" data-testid="settings-semantic-error">
            {status.lastError}
          </p>
          <p className="muted">
            本机向量服务没开时，聊天会退回按关键词选记忆。开着 Ollama 后点重建。
          </p>
        </>
      )}
      {error && <p className="warn">{error}</p>}
      <Button
        kind="default"
        disabled={busy || status?.enabled === false}
        onClick={() => void rebuild()}
        testId="settings-semantic-rebuild"
      >
        {busy ? '正在重建…' : '重建'}
      </Button>
    </Card>
  );
}

/** 设置页：模型接入、采集开关、扩展配对、MCP 接入片段、导出恢复、最近操作。 */
/** 已保存的「编码任务交给谁」。选过的模型已不在已保存清单里就当成没选。 */
function savedCodingOf(v: SettingsView | null): { executor: 'codex' | 'model'; modelName: string } {
  const name = v?.config.codingModelName ?? '';
  return {
    executor: v?.config.codingExecutor ?? 'codex',
    modelName: (v?.config.savedModels ?? []).includes(name) ? name : '',
  };
}

/**
 * MP2b：设置读出来之前先用这份占位渲染骨架——「模型接入搬走了」「编码任务的模型下拉」
 * 这些静态内容不该等设置读完才出现。
 */
const EMPTY_SETTINGS_VIEW = {
  config: {
    modelName: '',
    chatModelName: '',
    apiBaseUrl: '',
    apiKeyPresent: false,
    savedModels: [],
    modelsCheckedAt: null,
    codingExecutor: 'codex',
    codingModelName: '',
    captureEnabled: false,
    autoAnalyze: false,
    extensionPaired: false,
    extensionLastSyncAt: null,
    webSearchProvider: 'none',
    webSearchKeyPresent: false,
    uses: {},
  },
  dataDir: '',
  cockpit: { magpieUrl: '' },
  mcp: { snippet: '', localToken: null },
} as unknown as SettingsView;

/** 设置页里「读一次接口就渲染」的小卡：接口缺方法时别把整页弄空白。 */
class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    // 哪一块没加载出来，留个痕迹方便排查（不弹窗、不打断）
    console.warn('设置页某一块没加载出来：', error);
  }
  override render(): ReactNode {
    if (this.state.failed) return <p className="warn">这一块没加载出来，刷新页面再试。</p>;
    return this.props.children;
  }
}

export function SettingsPage({
  focus,
  onOpenModels,
}: {
  /** CF0：从聊天里点「去设置」时滚到「模型接入」。at 让同一处再点一次也能触发。 */
  focus?: { section: 'model'; at: number } | null;
  /** MP2b：模型接入与额度搬到了「模型」页；设置页只留一个跳过去的按钮。 */
  onOpenModels?: () => void;
} = {}) {
  const [loadedView, setView] = useState<SettingsView | null>(null);
  const view: SettingsView = loadedView ?? EMPTY_SETTINGS_VIEW;
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // M2：勾选保存的模型清单（初始=已保存的；检测不重置勾选，只有保存写盘）
  /** M3：这次保存因换地址把已保存的 Key 清掉了（且现在确实没 Key）→ 卡片里提示。 */
  /** SUB1：「用本机 magpie」没连上时的提示；连上了或用户改了地址就清掉。 */
  // D7b：编码任务交给谁（照 getSettings 回传的两项初始化）
  const [codingExec, setCodingExec] = useState<'codex' | 'model'>('codex');
  const [codingModel, setCodingModel] = useState('');
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
  // K3：驾驶舱读队列用的 IXAEON 仓库路径
  const [repoPath, setRepoPath] = useState('');
  // K5：手机只读页（默认关，端口 43192）
  const [mobileEnabled, setMobileEnabled] = useState(false);
  const [mobilePort, setMobilePort] = useState('43192');
  // CF0：同一次「去设置」只滚一次；之后保存别的设置重读 view 不再把页面拽回模型接入。
  const appliedFocusAt = useRef<number | null>(null);

  const reload = useCallback(async (): Promise<SettingsView | null> => {
    try {
      const v = await api.getSettings();
      // 审计列表读不到不该挡住整页设置（它只是「最近操作」那一块）
      let e: AuditEvent[] = [];
      try {
        e = await api.listAuditEvents(20);
      } catch {
        e = [];
      }
      setView(v);
      setEvents(e);
      const coding = savedCodingOf(v);
      setCodingExec(coding.executor);
      setCodingModel(coding.modelName);
      setSearchForm({
        provider: v.config.webSearchProvider ?? 'none',
        apiKey: '',
      });
      setRepoPath(v.cockpit?.ixaeonRepo ?? '');
      setMobileEnabled(v.cockpit?.mobileEnabled ?? false);
      setMobilePort(String(v.cockpit?.mobilePort ?? 43192));
      return v;
    } catch (err) {
      setError(errMsg(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // CF0：从聊天里点「去设置」过来时，等设置读出来、卡片在页面上，再滚到「模型接入」。
  useEffect(() => {
    if (!focus || focus.section !== 'model' || view === null) return;
    if (appliedFocusAt.current === focus.at) return;
    appliedFocusAt.current = focus.at;
    const card = document.querySelector('[data-testid="settings-model"]');
    (card as HTMLElement | null)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focus, view]);

  /** K3：只保存仓库路径；留空 = 驾驶舱不读队列。 */
  const saveCockpitRepo = async () => {
    try {
      const value = repoPath.trim();
      await api.saveCockpitSettings({ ixaeonRepo: value });
      setRepoPath(value);
      setNotice('IXAEON 仓库路径已保存。');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  /** K5：保存手机查看的开关与端口；端口不合法时由主进程拒绝。 */
  const saveMobile = async () => {
    try {
      const port = Number(mobilePort);
      await api.saveMobileSettings({ enabled: mobileEnabled, port });
      setMobilePort(String(port));
      setNotice('手机查看设置已保存。');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  // M2：勾选清单与下拉框的计算状态
  const savedSet = useMemo(() => new Set(view?.config.savedModels ?? []), [view]);
  // MP2b：编码任务的模型下拉框显示「供应商名 · 模型」
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  useEffect(() => {
    void api
      .listModelProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);
  const codingChoices = useMemo(() => {
    const rows = providers.flatMap((p) =>
      p.savedModels.map((m) => ({ value: m, label: `${p.name} · ${m}` })),
    );
    return rows.length > 0 ? rows : [...savedSet].map((id) => ({ value: id, label: id }));
  }, [providers, savedSet]);
  const savedCoding = useMemo(() => savedCodingOf(view), [view]);
  // 用户「取消勾选但还没保存」的意图：重检重建勾选时不能把刚取消的项又勾回来
  //（契约 5：重检只更新标记，不撤销用户尚未保存的选择）。保存成功后清空。
  // 勾选清单的全部行（未按名字筛选）：检测后 = 上游全部 + 已保存但上游没有的
  //（标「上游已没有」，不自动删）；没检测过时只显示已保存的。
  // 下拉框：只从已保存清单选；当前在用的不在清单里就补上并标注（契约 4）

  // 检测会跨网络、可能很慢：每次发起检测代次 +1，保存（改 Key/地址）也让在途
  // 检测作废——迟到的旧响应（旧凭据对应的清单）不能盖到新配置上。

  /**
   * SUB1：用本机 magpie 一键预设。走现有检测通道（`listAvailableModels`），不另开写配置的
   * IPC；检测用的是预设的地址与 Key，**连上了才把预设填进表单**——连不上时表单不动，
   * 只在按钮下面说清怎么把 magpie 打开。
   */

  const saveCoding = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveCodingSettings({ executor: codingExec, modelName: codingModel });
      setNotice('编码任务交给谁已保存');
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

  // MP2b：这块是静态内容，读取设置失败/还没读完时也要能看到入口
  const jumpToModelsCard = (
    <Card title="模型接入" testId="settings-model-moved">
      <p className="muted">
        模型和额度搬到了左边的「模型」页：那里可以接多家供应商、获取并勾选模型、决定每个用途用哪家的哪个模型。
      </p>
      <Button kind="default" testId="settings-model-jump" onClick={() => onOpenModels?.()}>
        去「模型」页
      </Button>
    </Card>
  );

  return (
    <div data-testid="page-settings">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <div className="ok-banner">{notice}</div>}
      {jumpToModelsCard}

      <Card title="编码任务交给谁" testId="settings-coding">
        <p className="muted">选「我的模型」后：{MODEL_EXECUTOR_SENDS}</p>
        {/* U2：写明现在生效的是哪个——下拉框改了不点「保存」是不算数的 */}
        <p className="note" data-testid="settings-coding-current">
          现在生效的：
          {savedCoding.executor === 'codex'
            ? 'Codex'
            : savedCoding.modelName
              ? executorLabel(`model:${savedCoding.modelName}`)
              : '我的模型（还没选模型，编码任务会停在排队里）'}
        </p>
        <Field label="执行器">
          <select
            value={codingExec}
            onChange={(e) => {
              setCodingExec(e.target.value as 'codex' | 'model');
              if (e.target.value === 'codex') setCodingModel('');
            }}
            data-testid="settings-coding-executor"
          >
            <option value="codex">Codex（本机装了才能用）</option>
            <option value="model">我的模型</option>
          </select>
        </Field>
        {/* MP2b：有可选的供应商模型、或本来就用「我的模型」时才出现（默认 Codex 时不该看到它） */}
        {(codingExec === 'model' ||
          (Array.isArray(providers) && providers.some((p) => p.savedModels.length > 0))) && (
          <Field label="模型">
            <select
              value={codingModel}
              onChange={(e) => setCodingModel(e.target.value)}
              data-testid="settings-coding-model"
            >
              <option value="">请选择</option>
              {codingChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {(codingExec !== savedCoding.executor ||
          (codingExec === 'model' && codingModel !== savedCoding.modelName)) && (
          <p className="warn" data-testid="settings-coding-unsaved">
            改了还没保存：点下面的「保存」才生效。
          </p>
        )}
        <div className="wizard-nav">
          <Button
            kind="primary"
            disabled={busy}
            onClick={() => void saveCoding()}
            testId="settings-coding-save"
          >
            保存
          </Button>
        </div>
      </Card>
      <CardBoundary>
        <UpdateCard />

        <Card title="驾驶舱" testId="settings-cockpit">
          <Field
            label="IXAEON 仓库路径"
            hint="驾驶舱从这里读队列；留空表示不读队列（只记路径，不读别的文件）"
          >
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="D:\\…\\IXAEON"
              data-testid="settings-cockpit-repo"
            />
          </Field>
          <Button
            kind="primary"
            onClick={() => void saveCockpitRepo()}
            testId="settings-cockpit-save"
          >
            保存
          </Button>
        </Card>

        <Card title="手机查看" testId="settings-mobile">
          <p className="muted" data-testid="settings-mobile-scope">
            在手机上只读查看驾驶舱。默认关闭；打开后本机另起一个只绑 127.0.0.1 的只读端口，
            桌面上能看什么，手机上就只看得到什么，不能做任何操作。
          </p>
          <Field label="打开手机查看（只读）">
            <input
              type="checkbox"
              checked={mobileEnabled}
              onChange={(e) => setMobileEnabled(e.target.checked)}
              data-testid="settings-mobile-enabled"
            />
          </Field>
          <Field label="端口" hint="默认 43192；改完保存才生效">
            <input
              type="number"
              min={1}
              max={65535}
              value={mobilePort}
              onChange={(e) => setMobilePort(e.target.value)}
              data-testid="settings-mobile-port"
            />
          </Field>
          {mobileEnabled && (
            <div data-testid="settings-mobile-command">
              <p className="muted">
                这条命令由你自己在电脑上执行一次（IXAEON 不改 Tailscale
                配置），把这个端口发布到自己的 tailnet：
              </p>
              <code>tailscale serve --bg {mobilePort}</code>
            </div>
          )}
          {mobileEnabled && (
            <div className="muted" data-testid="settings-mobile-notes">
              <p>
                怎么关：<code>tailscale serve status</code> 看现在发布了什么；
                <code>tailscale serve reset</code> 会清掉<strong>全部</strong> serve
                配置，别的服务也经 serve 发布时要注意。
              </p>
              <p>
                tailnet 里的所有设备都能打开这个页面；如果把设备共享给了别人，先在 Tailscale
                里限制访问。
              </p>
              <p>不要用 funnel：那是把服务暴露到公网。</p>
            </div>
          )}
          <Button kind="primary" onClick={() => void saveMobile()} testId="settings-mobile-save">
            保存
          </Button>
        </Card>

        <Card title="Agent 运行时（Hermes）" testId="settings-hermes">
          <p className={view.hermesFound ? 'note' : 'warn'} data-testid="settings-hermes-notice">
            {view.hermesNotice || '尚未探测 Hermes。'}
          </p>
          <p className="muted" data-testid="settings-hermes-scope">
            「问答」页的聊天由 Hermes 运行，
            <strong>用哪个模型由下面「模型接入」里的「聊天模型」决定</strong>
            （留空则跟随模型名称），IXAEON 启动 Hermes 时传过去，不改 Hermes 自己的配置文件；
            每条回答下方会显示实际用了哪个模型。聊天时 Hermes 只能联网搜索，以及在记忆桥开着时查
            IXAEON 记忆，不能读写本机文件、不能执行命令。
          </p>
        </Card>

        <PersonalMemoryCard />
        <HermesBridgeCard />

        <SemanticIndexCard />

        <Card title="网页搜索（研究用）" testId="settings-websearch">
          <p className="muted">
            给 B3 研究提供真实 URL 搜索。查询发出前会本地脱敏（邮箱/路径/密钥）； 不配置时
            search_web 诚实失败，不伪造结果。Key 用系统加密保存，不回显。
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

        <Card title="MCP 接入（编码 AI）" testId="settings-mcp">
          <p className="note">
            把下面的片段加入 Codex / Claude Code / Cursor 配置即可接入本机服务。
            令牌已内嵌（仅本机有效；泄露不会暴露文件系统，但可读写工作记录）。
          </p>
          <pre className="code-block" data-testid="settings-mcp-snippet">
            {view.mcp?.snippet ?? ''}
          </pre>
          <p className="note">
            本地令牌：
            <code data-testid="settings-mcp-token">{view.mcp?.localToken ?? '未生成'}</code>
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
      </CardBoundary>
    </div>
  );
}
