/**
 * IXAEON 内容脚本：观察 chatgpt.com 当前对话页。
 *
 * 规则（计划 5.4）：
 * - 只处理当前页面渲染出的对话消息，不遍历侧栏，不打开其他对话
 * - MutationObserver 监听 DOM 变化；流式回答期间只更新本地草稿
 * - 内容稳定 2 秒后作为完成版本批量提交（经 background 队列）
 * - 以（对话路径 + 角色 + 顺序 + 内容指纹）去重；编辑/重新生成保存为新版本
 */

interface TurnDraft {
  order: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

const STABLE_MS = 2000;
const MIN_TURN_CHARS = 1;

let lastSnapshot: string = '';
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
let lastSubmissionAt = 0;
const SUBMIT_COOLDOWN_MS = 3000;

/** 从 DOM 提取当前可见的对话轮次。 */
export function extractTurns(doc: Document): TurnDraft[] {
  const turns: TurnDraft[] = [];
  // ChatGPT 页面结构：[data-message-author-role] 标记每条消息
  const nodes = doc.querySelectorAll<HTMLElement>('[data-message-author-role]');
  nodes.forEach((node, index) => {
    const role = node.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return;
    const text = extractMessageText(node);
    if (text.trim().length < MIN_TURN_CHARS) return;
    turns.push({ order: index, role, text: text.trim() });
  });
  return turns;
}

/** 提取消息文本（复制按钮等 UI 噪音剥离）。 */
export function extractMessageText(node: HTMLElement): string {
  const clone = node.cloneNode(true) as HTMLElement;
  // 剥离常见 UI 元素
  clone
    .querySelectorAll('button, svg, [data-testid="copy-turn-action"], .action-bar, nav')
    .forEach((el) => el.remove());
  return (clone.textContent ?? '').replace(/\u200b/g, '').trim();
}

/** 会话外键：对话路径（/c/<id>）；无 ID 页面回退到标题哈希。 */
export function conversationExternalId(loc: Location): string {
  const match = /\/c\/([A-Za-z0-9-]{6,})/.exec(loc.pathname);
  if (match) return `/c/${match[1]}`;
  // 无对话 ID（如新对话未保存）：用路径+标题，提交后服务端仍按 external_id 去重
  const fallback = `${loc.pathname}|${document.title}`;
  return `page:${hashText(fallback)}`;
}

export function conversationTitle(): string {
  return (document.title || '未命名对话').slice(0, 500);
}

/** 简易内容指纹（后端仍自行计算全文哈希，不信任扩展端）。 */
export function hashText(text: string): string {
  // FNV-1a 双轮 + 混合 → 4 段 32 位（>>> 0 保证无符号 16 进制）→ 32 hex，
  // pad 到 64 位（contentHash 契约要求 length 64）
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  const part = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return (
    part(h1) +
    part(h2) +
    part(h1 ^ h2) +
    part((h2 ^ 0xdeadbeef) >>> 0) +
    part(h1 >>> 16) +
    part(h2 >>> 16) +
    part(h1 + h2) +
    part(h2 - h1)
  )
    .slice(0, 64)
    .padEnd(64, '0');
}

/** 是否应跳过提交（冷却 / 无新内容）。 */
export function shouldSubmit(turns: TurnDraft[]): boolean {
  if (turns.length === 0) return false;
  const snapshot = JSON.stringify(turns);
  if (snapshot === lastSnapshot) return false;
  if (Date.now() - lastSubmissionAt < SUBMIT_COOLDOWN_MS) return false;
  return true;
}

/** 提交（经 background，带稳定性去抖）。 */
function scheduleSubmit(): void {
  if (stabilityTimer !== null) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(() => {
    stabilityTimer = null;
    const turns = extractTurns(document);
    if (!shouldSubmit(turns)) return;
    lastSnapshot = JSON.stringify(turns);
    lastSubmissionAt = Date.now();
    const batch = {
      conversation: {
        externalId: conversationExternalId(location),
        title: conversationTitle(),
      },
      turns: turns.map((t) => ({
        order: t.order,
        role: t.role,
        text: t.text,
        contentHash: hashText(t.text),
      })),
      clientTimestamp: new Date().toISOString(),
    };
    void chrome.runtime.sendMessage({ type: 'ixaeon:capture', batch });
  }, STABLE_MS);
}

// --- 启动 ---
const observer = new MutationObserver(() => {
  // 页面可见时才观察（不可见标签页不提交）
  if (document.visibilityState === 'visible') scheduleSubmit();
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// 首次加载也排一次（页面加载完成后 2s 稳定期）
if (document.readyState === 'complete') {
  scheduleSubmit();
} else {
  window.addEventListener('load', () => scheduleSubmit(), { once: true });
}

// 离开页面前若还有未提交变化，立即尝试
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && stabilityTimer) {
    clearTimeout(stabilityTimer);
    stabilityTimer = null;
    scheduleSubmit();
  }
});
