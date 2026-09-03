/** popup：状态展示 + 配对输入。 */

function setText(id: string, text: string, cls?: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = cls;
}

async function refresh(): Promise<void> {
  // 向 background 发消息拿状态（service worker 里导出的 queryStatus 无法直接 import 到 popup，
  // 但 popup 与 background 同源，直接 fetch /api/extension/status + storage 读令牌即可）
  const stored = (await chrome.storage.local.get(['token', 'lastSyncAt', 'lastError'])) as {
    token: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  };
  if (!stored.token) {
    setText('status-connected', '未配对', 'bad');
    setText('status-capture', '—', 'muted');
    setText('status-sync', '—', 'muted');
    setText('status-error', '—', 'muted');
    const area = document.getElementById('pair-area');
    if (area) area.hidden = false;
    return;
  }
  try {
    const res = await fetch('http://127.0.0.1:43191/api/extension/status', {
      headers: { authorization: `Bearer ${stored.token}` },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { paired: boolean; captureEnabled: boolean };
    setText('status-connected', '已连接', 'ok');
    setText(
      'status-capture',
      body.captureEnabled ? '开启' : '已暂停（桌面端）',
      body.captureEnabled ? 'ok' : 'bad',
    );
  } catch {
    setText('status-connected', '桌面端未运行', 'bad');
    setText('status-capture', '—', 'muted');
  }
  setText(
    'status-sync',
    stored.lastSyncAt ? stored.lastSyncAt.slice(0, 19).replace('T', ' ') : '无',
    'muted',
  );
  setText('status-error', stored.lastError ?? '无', stored.lastError ? 'bad' : 'muted');
  const area = document.getElementById('pair-area');
  if (area) area.hidden = true;
}

document.getElementById('pair-submit')?.addEventListener('click', () => {
  const input = document.getElementById('pair-code') as HTMLInputElement | null;
  const result = document.getElementById('pair-result');
  if (!input || !result) return;
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) {
    result.textContent = '请输入 6 位数字配对码';
    return;
  }
  result.textContent = '配对中…';
  void chrome.runtime.sendMessage({ type: 'ixaeon:pair', code }).then(() => {
    // 后台异步执行；轮询 storage 直到 token 出现或超时
    const started = Date.now();
    const poll = (): void => {
      void chrome.storage.local.get(['token', 'lastError']).then((s) => {
        const st = s as { token: string | null; lastError: string | null };
        if (st.token) {
          result.textContent = '配对成功';
          void refresh();
        } else if (Date.now() - started > 8000) {
          result.textContent = st.lastError ?? '配对失败（超时）';
        } else {
          setTimeout(poll, 300);
        }
      });
    };
    setTimeout(poll, 300);
  });
});

void refresh();
