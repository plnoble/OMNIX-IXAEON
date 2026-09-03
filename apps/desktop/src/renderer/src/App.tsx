import { useEffect, useState } from 'react';
import type { AppState } from '@ixaeon/contracts';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void window.ixaeon?.getState().then(setState);
  }, []);

  return (
    <div className="app" data-testid="app-root">
      <header className="app-header">
        <h1>
          IXAEON <span className="cn">析衍</span>
        </h1>
        <p className="tagline">本地项目记忆与编码 AI 背景服务 · OMNIX</p>
      </header>
      <main className="app-main">
        <section className="card" data-testid="state-card">
          <h2>系统状态</h2>
          <dl>
            <dt>版本</dt>
            <dd data-testid="state-version">{state?.version ?? '…'}</dd>
            <dt>数据目录</dt>
            <dd data-testid="state-datadir">{state?.dataDir ?? '…'}</dd>
            <dt>首次设置</dt>
            <dd data-testid="state-setup">
              {state ? (state.setupComplete ? '已完成' : '未完成') : '…'}
            </dd>
            <dt>本地服务</dt>
            <dd data-testid="state-server">
              {state ? (state.serverRunning ? `127.0.0.1:${state.serverPort}` : '未运行') : '…'}
            </dd>
          </dl>
        </section>
        <p className="note">工程底座（M0）阶段：界面与服务将在后续里程碑接入。</p>
      </main>
    </div>
  );
}
