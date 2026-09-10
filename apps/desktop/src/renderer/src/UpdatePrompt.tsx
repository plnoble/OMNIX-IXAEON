import { useEffect, useState } from 'react';
import type { UpdateStatusView } from '@ixaeon/contracts';
import { Button } from './ui.js';
import { errMsg } from './api.js';

/**
 * 启动后发现新版本时的全局弹窗。下载自动开始；装完由用户点安装，不自动重启。
 * 开发运行没有 ixaeonUpdates 时不渲染。
 */
export function UpdatePrompt() {
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const updates = window.ixaeonUpdates;
    if (!updates) return;
    const off = updates.onStatus((s) => {
      setStatus(s);
      if (s.state === 'downloading' || s.state === 'ready') setDismissed(false);
    });
    void updates
      .get()
      .then(setStatus)
      .catch(() => undefined);
    return () => {
      off();
    };
  }, []);

  const install = async () => {
    const updates = window.ixaeonUpdates;
    if (!updates) return;
    try {
      const result = await updates.install();
      if (!result.ok) setError('更新尚未下载完成，请稍后再试');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  if (!status) return null;
  if (dismissed) return null;
  if (status.state !== 'downloading' && status.state !== 'ready') return null;

  const percent = status.downloadPercent;
  const notes = status.releaseNotes?.trim();

  return (
    <div className="modal-backdrop" data-testid="update-prompt" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h2>{status.state === 'ready' ? '更新已下载' : '发现新版本'}</h2>
        <p>
          {status.version
            ? `IXAEON ${status.version} ${status.state === 'ready' ? '已下载完成。' : '正在下载。'}`
            : '正在下载新版本。'}
        </p>
        {status.state === 'downloading' && (
          <div className="update-progress" data-testid="update-progress">
            <div className="update-progress-track">
              <div
                className="update-progress-bar"
                style={{ width: `${percent ?? 0}%` }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? 0}
              />
            </div>
            <span className="muted">{percent == null ? '准备中…' : `${percent}%`}</span>
          </div>
        )}
        {notes && (
          <pre className="update-notes" data-testid="update-notes">
            {notes}
          </pre>
        )}
        {error && <p className="warn">{error}</p>}
        <p className="note">不会自动重启。下载完成后由你决定是否安装。</p>
        <div className="wizard-nav">
          {status.state === 'ready' ? (
            <Button kind="primary" onClick={() => void install()} testId="update-prompt-install">
              重启并安装
            </Button>
          ) : (
            <Button kind="ghost" onClick={() => setDismissed(true)} testId="update-prompt-later">
              后台下载
            </Button>
          )}
          {status.state === 'ready' && (
            <Button kind="ghost" onClick={() => setDismissed(true)} testId="update-prompt-dismiss">
              稍后
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
