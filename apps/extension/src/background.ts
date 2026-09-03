/**
 * IXAEON background service worker：
 * - 持有扩展令牌（chrome.storage.local）
 * - 配对：输入一次性码 → POST /api/extension/pair
 * - 采集队列：content script 的批次 → POST /api/extension/capture
 *   失败重试（指数退避，最多 5 次）；DISABLED/PERMISSION_REVOKED 停止
 * - 状态查询给 popup
 */

const BASE_URL = 'http://127.0.0.1:43191';

interface StoredState {
  token: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

async function getState(): Promise<StoredState> {
  return (await chrome.storage.local.get(['token', 'lastSyncAt', 'lastError'])) as StoredState;
}

async function patchState(patch: Partial<StoredState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** 配对：一次性 6 位码换令牌。 */
export async function pair(code: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/extension/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      return { ok: false, message: body?.message ?? `配对失败（${res.status}）` };
    }
    const body = (await res.json()) as { token: string };
    await patchState({ token: body.token, lastError: null });
    return { ok: true, message: '配对成功' };
  } catch {
    return {
      ok: false,
      message: '无法连接 IXAEON 桌面端。请确认桌面应用已运行，然后重试。',
    };
  }
}

/** 提交采集批次（带重试）。 */
export async function submitCapture(
  batch: unknown,
  attempt = 0,
): Promise<{ ok: boolean; message?: string }> {
  const { token } = await getState();
  if (!token) return { ok: false, message: '未配对' };
  try {
    const res = await fetch(`${BASE_URL}/api/extension/capture`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(batch),
    });
    if (res.ok) {
      await patchState({ lastSyncAt: new Date().toISOString(), lastError: null });
      return { ok: true };
    }
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    const code = body?.code ?? '';
    // 403 DISABLED（全局暂停）与 401（令牌失效/授权撤销）：不重试
    if (code === 'IXA0022' || code === 'IXA0001' || code === 'IXA0019' || code === 'IXA0021') {
      await patchState({ lastError: body?.message ?? '采集被拒绝' });
      return { ok: false, message: body?.message };
    }
    // 其他错误：指数退避重试（最多 5 次）
    if (attempt < 5) {
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      setTimeout(() => void submitCapture(batch, attempt + 1), delay);
      return { ok: true }; // 已排队重试，不向上层报错
    }
    await patchState({ lastError: body?.message ?? `提交失败（${res.status}）` });
    return { ok: false, message: body?.message };
  } catch {
    if (attempt < 5) {
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      setTimeout(() => void submitCapture(batch, attempt + 1), delay);
      return { ok: true };
    }
    await patchState({ lastError: '无法连接桌面端' });
    return { ok: false, message: '无法连接桌面端' };
  }
}

/** 弹窗状态查询。 */
export async function queryStatus(): Promise<{
  paired: boolean;
  connected: boolean;
  captureEnabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}> {
  const state = await getState();
  if (!state.token) {
    return {
      paired: false,
      connected: false,
      captureEnabled: false,
      lastSyncAt: null,
      lastError: null,
    };
  }
  try {
    const res = await fetch(`${BASE_URL}/api/extension/status`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { paired: boolean; captureEnabled: boolean };
    return {
      paired: true,
      connected: true,
      captureEnabled: body.captureEnabled,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
    };
  } catch {
    return {
      paired: true,
      connected: false,
      captureEnabled: false,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
    };
  }
}

// --- 消息路由（content script ↔ popup ↔ background） ---
chrome.runtime.onMessage.addListener((msg: { type: string; batch?: unknown; code?: string }) => {
  if (msg.type === 'ixaeon:capture' && msg.batch) {
    void submitCapture(msg.batch);
    return false;
  }
  if (msg.type === 'ixaeon:pair' && msg.code) {
    // popup 里 await 不到 listener 的同步返回值（异步），改为端口方式不必要——
    // 直接异步执行，popup 通过 storage 轮询结果。
    void pair(msg.code);
    return false;
  }
  return false;
});
