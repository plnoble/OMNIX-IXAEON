/** popup：状态展示 + 配对输入 + 当前对话暂停/继续。 */

function setText(id: string, text: string, cls?: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) el.className = cls;
}

const BASE_URL = 'http://127.0.0.1:43191';

/** 当前对话 ID（popup 与 background 通信获得激活标签页的 externalId）。 */
let currentExternalId: string | null = null;
let currentPaused = false;

async function refresh(): Promise<void> {
  const stored = (await chrome.storage.local.get(['token', 'lastSyncAt', 'lastError'])) as {
    token: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  };
  if (!stored.token) {
    setText('status-connected', '未配对', 'bad');
    setText('status-capture', '—', 'muted');
    setText('status-current', '—', 'muted');
    setText('status-sync', '—', 'muted');
    setText('status-error', '—', 'muted');
    const area = document.getElementById('pair-area');
    if (area) area.hidden = false;
    return;
  }
  try {
    const res = await fetch(`${BASE_URL}/api/extension/status`, {
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

  // 当前对话暂停状态（向 background 查询激活标签页所在对话）
  await refreshCurrentConversation();
}

/** 查询激活标签页的对话 externalId 与暂停状态（background 持有 content script 连接）。 */
async function refreshCurrentConversation(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: 'ixaeon:current-conversation',
  })) as { externalId: string | null; paused: boolean } | undefined;
  currentExternalId = response?.externalId ?? null;
  currentPaused = response?.paused ?? false;
  renderCurrentConversation();
}

function renderCurrentConversation(): void {
  const btn = document.getElementById('pause-current') as HTMLButtonElement | null;
  const statusEl = document.getElementById('status-current');
  if (!btn || !statusEl) return;
  if (!currentExternalId) {
    statusEl.textContent = '非对话页';
    statusEl.className = 'muted';
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (currentPaused) {
    statusEl.textContent = '已暂停';
    statusEl.className = 'bad';
    btn.textContent = '继续当前对话';
  } else {
    statusEl.textContent = '采集中';
    statusEl.className = 'ok';
    btn.textContent = '暂停当前对话';
  }
}

/** 切换当前对话暂停状态（本地即时生效；同时同步到桌面端）。 */
async function togglePauseCurrent(): Promise<void> {
  if (!currentExternalId) return;
  const next = !currentPaused;
  // 本地立即生效（content script 停止提交；不等网络）
  await chrome.runtime.sendMessage({
    type: 'ixaeon:set-conversation-paused',
    externalId: currentExternalId,
    paused: next,
  });
  currentPaused = next;
  renderCurrentConversation();
  // 同步到桌面端（服务端也强制拒绝该对话的批次）
  const stored = (await chrome.storage.local.get(['token'])) as { token: string | null };
  if (stored.token) {
    void fetch(`${BASE_URL}/api/extension/pause-conversation`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${stored.token}`,
      },
      body: JSON.stringify({ externalId: currentExternalId, paused: next }),
    }).catch(() => {
      // 桌面端离线时本地暂停仍然有效；下次连接时用户可在桌面端管理
    });
  }
}

document.getElementById('pause-current')?.addEventListener('click', () => {
  void togglePauseCurrent();
});

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
