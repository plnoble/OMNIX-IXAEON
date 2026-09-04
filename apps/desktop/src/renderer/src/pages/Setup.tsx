import { useState } from 'react';
import { api, errMsg, type AppState } from '../api.js';
import { Button, Card, ErrorBanner, Field } from '../ui.js';

/**
 * 首次设置向导：数据目录 → 模型 → 第一个项目。
 * 自定义目录模式下完成设置会把全部数据写入新目录并要求重启（主进程原子切换）。
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
  const [busy, setBusy] = useState(false);
  const [restartNotice, setRestartNotice] = useState<string | null>(null);

  const [useCustomDir, setUseCustomDir] = useState(false);
  const [customDir, setCustomDir] = useState('');
  const [modelName, setModelName] = useState('gpt-5.2');
  const [apiKey, setApiKey] = useState('');
  const [projectName, setProjectName] = useState('我的项目');
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectRootTicket, setProjectRootTicket] = useState<string | null>(null);

  const envOverride = state.dataDir.length > 0; // e2e 环境注入数据目录

  const pickDir = async () => {
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

  const finish = async () => {
    if (projectName.trim().length === 0) {
      setError('项目名不能为空');
      return;
    }
    setBusy(true);
    try {
      const result = await api.completeSetup({
        dataDir: useCustomDir && customDir.trim().length > 0 ? customDir.trim() : null,
        modelName: modelName.trim() || 'gpt-5.2',
        apiKey,
        projectName: projectName.trim(),
        projectRootPath: projectRoot,
      });
      if (result.restartRequired) {
        // 自定义目录：数据已写入新目录，重启后从新目录启动
        setRestartNotice('设置已保存到新数据目录。请关闭并重新打开 IXAEON，之后将直接进入主界面。');
        return;
      }
      // 默认目录：目录票据已在向导持有 → 登记项目目录（folder 授权走主进程）
      if (projectRootTicket) {
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

  return (
    <div className="setup" data-testid="setup-wizard">
      <header className="app-header">
        <h1>
          IXAEON <span className="cn">析衍</span>
        </h1>
        <p className="tagline">本地项目记忆与编码 AI 背景服务 · 首次设置</p>
      </header>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {restartNotice && (
        <Card title="设置完成 — 需要重启" testId="setup-restart-notice">
          <p className="note">{restartNotice}</p>
        </Card>
      )}

      <Card title={`步骤 ${step + 1} / 3 — 数据目录`} testId="setup-step-dir">
        <p className="note">
          所有数据保存在你的电脑本地，不联网上传。当前数据目录：
          <code>{state.dataDir || '（默认 %LOCALAPPDATA%\\OMNIX\\IXAEON）'}</code>
        </p>
        <div className="field-row">
          <label className="check">
            <input
              type="checkbox"
              checked={useCustomDir}
              disabled={envOverride}
              onChange={(e) => setUseCustomDir(e.target.checked)}
              data-testid="setup-custom-dir-check"
            />
            <span>自定义数据目录（重启应用后生效）</span>
          </label>
        </div>
        {useCustomDir && (
          <Field label="目录" hint="例如 D:\IXAEON-Data">
            <input
              value={customDir}
              onChange={(e) => setCustomDir(e.target.value)}
              data-testid="setup-custom-dir-input"
            />
          </Field>
        )}
        <div className="wizard-nav">
          <Button kind="primary" onClick={() => setStep(1)} testId="setup-next-1">
            下一步
          </Button>
        </div>
      </Card>

      {step >= 1 && (
        <Card title={`步骤 2 / 3 — 模型接入`} testId="setup-step-model">
          <p className="note">
            提取与问答需要一个 OpenAI
            兼容模型。密钥仅保存在本机（系统加密存储），可稍后在设置中填写。
          </p>
          <Field label="模型名称">
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              data-testid="setup-model-name"
            />
          </Field>
          <Field label="API Key（可选）" hint="留空表示稍后配置；格式 sk-…">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              data-testid="setup-api-key"
            />
          </Field>
          <div className="wizard-nav">
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button kind="primary" onClick={() => setStep(2)} testId="setup-next-2">
              下一步
            </Button>
          </div>
        </Card>
      )}

      {step >= 2 && (
        <Card title={`步骤 3 / 3 — 第一个项目`} testId="setup-step-project">
          <Field label="项目名称">
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              data-testid="setup-project-name"
            />
          </Field>
          <Field label="项目根目录（可选）" hint="用于项目目录登记导入与 MCP 检索范围">
            <div className="inline-controls">
              <input
                value={projectRoot ?? ''}
                readOnly
                placeholder="未选择"
                data-testid="setup-project-root"
              />
              <Button onClick={pickDir} testId="setup-pick-root">
                选择目录
              </Button>
            </div>
          </Field>
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
