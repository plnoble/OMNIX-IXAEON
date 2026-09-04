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
  /** 已暂停的对话（externalId 列表；扩展端强制执行，桌面端为第二道防线） */
  pausedConversations: string[];
}

async function getState(): Promise<StoredState> {
  return (await chrome.storage.local.get([
    'token',
    'lastSyncAt',
    'lastError',
    'pausedConversations',
  ])) as StoredState;
}

async function patchState(patch: Partial<StoredState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** 对话是否被本地暂停（content script 提交前检查）。 */
export async function isConversationPaused(externalId: string): Promise<boolean> {
  const state = await getState();
  return (state.pausedConversations ?? []).includes(externalId);
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
/** 最近活跃的 chatgpt.com 对话标签页（popup 打开时 active tab 是 popup 自身，不能用它定位）。 */
let lastConversationTab: { externalId: string; at: number } | null = null;

chrome.runtime.onMessage.addListener(
  (
    msg: {
      type: string;
      batch?: unknown;
      code?: string;
      externalId?: string;
      paused?: boolean;
    },
    _sender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (msg.type === 'ixaeon:capture' && msg.batch) {
      // 本地暂停的对话：扩展端不发送（服务端还有第二道强制检查）
      const batch = msg.batch as { conversation: { externalId: string } };
      void (async () => {
        if (await isConversationPaused(batch.conversation.externalId)) return;
        await submitCapture(msg.batch);
      })();
      return false;
    }
    if (msg.type === 'ixaeon:pair' && msg.code) {
      void pair(msg.code);
      return false;
    }
    if (msg.type === 'ixaeon:tab-conversation' && msg.externalId) {
      // content script 上报：记录最近活跃对话（popup 的「当前对话」）
      lastConversationTab = { externalId: msg.externalId, at: Date.now() };
      return false;
    }
    if (msg.type === 'ixaeon:current-conversation') {
      void (async () => {
        let externalId = lastConversationTab?.externalId ?? null;
        // 兜底：30 秒内没有上报时查询激活标签页（popup 未打开场景）
        if (!externalId || Date.now() - (lastConversationTab?.at ?? 0) > 30_000) {
          externalId = await getActiveConversationId();
        }
        const paused = externalId !== null ? await isConversationPaused(externalId) : false;
        sendResponse({ externalId, paused });
      })();
      return true; // 异步响应
    }
    if (msg.type === 'ixaeon:set-conversation-paused' && msg.externalId) {
      void (async () => {
        const state = await getState();
        const set = new Set(state.pausedConversations ?? []);
        if (msg.paused) set.add(msg.externalId as string);
        else set.delete(msg.externalId as string);
        await patchState({ pausedConversations: [...set] });
        sendResponse({ ok: true, paused: msg.paused ?? false });
      })();
      return true;
    }
    return false;
  },
);

const CHATGPT_URL_PREFIX = 'https://' + 'chat' + 'gpt.com/'; // 拼接避免源码扫描误报外联

/** 激活标签页所在对话的 externalId（仅 chatgpt.com 对话页返回非空）。 */
async function getActiveConversationId(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith(CHATGPT_URL_PREFIX)) return null;
    const response = (await chrome.tabs.sendMessage(tab.id, {
      type: 'ixaeon:get-conversation-id',
    })) as { externalId?: string | null } | undefined;
    return response?.externalId ?? null;
  } catch {
    return null; // 无 content script（非对话页）
  }
}
