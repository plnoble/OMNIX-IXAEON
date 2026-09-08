import { useRef, useState } from 'react';
import { api, errMsg, type AppState } from '../api.js';
import { Button, Card, ErrorBanner, Field } from '../ui.js';

/**
 * 首次设置向导：数据目录 → 模型 → 第一个项目（可跳过）。
 * - 数据目录用系统原生对话框选择（不再手输路径）；
 * - 模型接入：API 地址 + Key → 「获取可用模型」从上游拉取列表选择；
 * - 自定义目录模式下完成设置把全部数据写入新目录并要求重启（主进程原子切换）；
 * - 完成后的反馈（成功/需重启/Key 保存失败）直接显示在按钮下方并滚动可见，
 *   不再只出现在页面顶部（修复「点了没反应」）。
 */
export function SetupWizard({
  state,
  onDone,
}: {
  state: AppState;
  onDone: (restartRequired: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<'ok' | 'warn' | 'info'>('ok');
  const [busy, setBusy] = useState(false);

  const [dataDir, setDataDir] = useState<string | null>(null); // null=默认目录
  const [apiBaseUrl, setApiBaseUrl] = useState('https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [models, setModels] = useState<Array<{ id: string }> | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectRootTicket, setProjectRootTicket] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  // 修复 R9：主进程明确返回 envOverride（数据目录被环境变量覆盖才禁用自定义目录），
  // 不能用「目录字符串非空」推断 —— 正常启动也有非空默认目录
  const envOverride = state.envOverride === true;

  const showNotice = (text: string, kind: 'ok' | 'warn' | 'info' = 'ok') => {
    setNotice(text);
    setNoticeKind(kind);
    // 反馈必须在当前视口内立即可见（修复：提示渲染在滚动区外用户看不到）
    requestAnimationFrame(() => noticeRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  const pickDataDir = async () => {
    try {
      const picked = await api.pickFiles('directory');
      if (picked && picked.paths[0]) setDataDir(picked.paths[0]);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const pickProjectRoot = async () => {
    try {
      const picked = await api.pickFiles('directory');
      if (picked && picked.paths[0]) {
        setProjectRoot(picked.paths[0]);
        setProjectRootTicket(picked.ticket);
      }
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const fetchModels = async () => {
    if (apiKey.trim().length === 0) {
      setError('请先填写 API Key，再获取可用模型');
      return;
    }
    setFetchingModels(true);
    setError(null);
    try {
      const result = await api.listAvailableModels({
        apiBaseUrl: apiBaseUrl.trim(),
        apiKey: apiKey.trim(),
      });
      if (result.models.length === 0) {
        showNotice('上游返回了空模型列表，请检查 API 地址是否正确', 'warn');
      } else {
        setModels(result.models);
        showNotice(`获取到 ${result.models.length} 个可用模型，请在下拉框中选择`, 'ok');
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setFetchingModels(false);
    }
  };

  const finish = async () => {
    if (modelName.trim().length === 0) {
      setError('请选择或填写模型名称（可先「获取可用模型」）');
      setStep(1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.completeSetup({
        dataDir,
        modelName: modelName.trim(),
        apiBaseUrl: apiBaseUrl.trim(),
        apiKey: apiKey.trim(),
        projectName: projectName.trim(),
        projectRootPath: projectRoot,
      });
      // Key 保存失败：设置已完成，但必须明确告知（不再静默丢失）
      if (result.apiKeyWarning) {
        showNotice(result.apiKeyWarning + '。其余设置已保存，可稍后在设置页重试。', 'warn');
        setBusy(false);
        if (!result.restartRequired) {
          // 默认目录：警告展示后仍进入主界面（延迟让用户看到）
          setTimeout(() => onDone(false), 3500);
        }
        return;
      }
      if (result.restartRequired) {
        showNotice(
          '设置已保存到新数据目录。请关闭并重新打开 IXAEON，之后将直接进入主界面。',
          'info',
        );
        setBusy(false);
        return;
      }
      // 默认目录：目录票据已在向导持有 → 登记项目目录（folder 授权走主进程）
      if (projectRootTicket && projectName.trim().length > 0) {
        try {
          const projects = await api.listProjects();
          const mine = projects.find(
            (p) => p.name.toLowerCase() === projectName.trim().toLowerCase(),
          );
          if (mine) {
            await api.registerProjectDirectory({ ticket: projectRootTicket, projectId: mine.id });
          }
        } catch {
          // 目录登记失败不阻塞首次设置完成
        }
      }
      onDone(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const nextFromModel = () => {
    if (modelName.trim().length === 0) {
      setError('请先选择或填写模型名称，再进入下一步');
      return;
    }
    setError(null);
    setStep(2);
  };

  return (
    <div className="setup" data-testid="setup-wizard">
      <header className="app-header">
        <h1>
          IXAEON <span className="cn">析衍</span>
        </h1>
        <p className="tagline">本地项目记忆与编码 AI 背景服务 · 首次设置</p>
      </header>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card title={`步骤 ${step + 1} / 3 — 数据目录`} testId="setup-step-dir">
        <p className="note">
          所有数据保存在你的电脑本地，不联网上传。点击按钮选择目录；不选择则使用默认位置。
        </p>
        <Field label="数据目录" hint="数据库名 ixaeon.db · 原文仓库 vault/ · 日志 logs/">
          <div className="inline-controls">
            <input
              value={dataDir ?? state.dataDir ?? '（默认 %LOCALAPPDATA%\OMNIX\IXAEON）'}
              readOnly
              data-testid="setup-dir-display"
            />
            <Button
              onClick={dataDir ? () => setDataDir(null) : pickDataDir}
              disabled={envOverride}
              testId="setup-pick-dir"
            >
              {dataDir ? '改回默认' : '选择目录'}
            </Button>
          </div>
        </Field>
        <div className="wizard-nav">
          <Button kind="primary" onClick={() => setStep(1)} testId="setup-next-1">
            下一步
          </Button>
        </div>
      </Card>

      {step >= 1 && (
        <Card title="步骤 2 / 3 — 模型接入" testId="setup-step-model">
          <p className="note">
            提取与问答需要一个 OpenAI 兼容模型。填写 API 地址与 Key
            后可拉取可用模型列表；密钥仅保存在本机（系统加密存储）。
          </p>
          <Field label="API 地址" hint="OpenAI 兼容端点，如 https://api.deepseek.com/v1">
            <input
              value={apiBaseUrl}
              onChange={(e) => {
                setApiBaseUrl(e.target.value);
                setModels(null); // 换地址后旧列表失效
              }}
              placeholder="https://api.deepseek.com/v1"
              data-testid="setup-api-base"
            />
          </Field>
          <Field label="API Key" hint="仅保存在本机；可稍后在设置中填写">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              data-testid="setup-api-key"
            />
          </Field>
          <Field label="模型">
            {models ? (
              <select
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                data-testid="setup-model-select"
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
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="可先获取列表选择，或直接填写模型名"
                data-testid="setup-model-name"
              />
            )}
          </Field>
          <div className="wizard-nav">
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button disabled={fetchingModels} onClick={fetchModels} testId="setup-fetch-models">
              {fetchingModels ? '获取中…' : '获取可用模型'}
            </Button>
            <Button kind="primary" onClick={nextFromModel} testId="setup-next-2">
              下一步
            </Button>
          </div>
        </Card>
      )}

      {step >= 2 && (
        <Card title="步骤 3 / 3 — 第一个项目（可跳过）" testId="setup-step-project">
          <p className="note">
            项目是资料与编码 AI 上下文的隔离边界（简报/检索/问答默认只返回所选项目的资料）。
            现在可以不建，进入主界面后在「项目」页随时创建。
          </p>
          <Field label="项目名称（留空跳过）">
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="例如：IXAEON"
              data-testid="setup-project-name"
            />
          </Field>
          {projectName.trim().length > 0 && (
            <Field label="项目根目录（可选）" hint="用于项目目录登记导入与 MCP 检索范围">
              <div className="inline-controls">
                <input
                  value={projectRoot ?? ''}
                  readOnly
                  placeholder="未选择"
                  data-testid="setup-project-root"
                />
                <Button onClick={pickProjectRoot} testId="setup-pick-root">
                  选择目录
                </Button>
              </div>
            </Field>
          )}
          {/* 完成反馈固定渲染在操作区内（视口内立即可见） */}
          <div ref={noticeRef}>
            {notice && (
              <p
                className={
                  noticeKind === 'warn' ? 'warn' : noticeKind === 'info' ? 'note' : 'ok-banner'
                }
                data-testid="setup-finish-notice"
                style={{ marginTop: 8 }}
              >
                {notice}
              </p>
            )}
          </div>
          <div className="wizard-nav">
            <Button onClick={() => setStep(1)}>上一步</Button>
            <Button kind="primary" disabled={busy} onClick={finish} testId="setup-finish">
              {busy ? '保存中…' : '完成设置'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
