import { sha256 } from '../vault.js';
import { normalizeAccountNamespace, type ParsedSource } from './parsers.js';

/** 以这些开头的「用户」行不是你打的字：命令包装、任务通知、停止记录。整行跳过。 */
const NOT_TYPED_BY_USER = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  // 后台任务结束时 Claude Code 塞进来的通知（2026-09 本机会话里 87 条）
  '<task-notification>',
  // 你按了停止，Claude Code 记的一行
  '[Request interrupted by user',
];

function asObj(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 有一行 session_meta → Codex（先判断）；有一行带字符串 sessionId 和 type → Claude Code。 */
export function detectAgentSession(lines: string[]): 'claude_code' | 'codex' | null {
  const parsed = lines.map(asObj);
  if (parsed.some((o) => o?.type === 'session_meta' && obj(o.payload))) return 'codex';
  if (parsed.some((o) => o && typeof o.sessionId === 'string' && 'type' in o)) return 'claude_code';
  return null;
}

/** Codex 自己派出去的子代理（如自动审查）的会话：session_meta 的 source 是带 subagent 的对象。 */
export function isCodexSubagentSession(lines: Iterable<string>): boolean {
  for (const line of lines) {
    const o = asObj(line);
    if (o?.type !== 'session_meta') continue;
    const source = obj(obj(o.payload)?.source);
    return source !== null && 'subagent' in source;
  }
  return false;
}

function cleanUser(text: string): string | null {
  const t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || NOT_TYPED_BY_USER.some((p) => t.trimStart().startsWith(p))) return null;
  return t;
}

/** 用户正文 / skip 打断 / silent 不打断正在累积的回答。 */
function userUtterance(content: unknown): 'silent' | string | null {
  if (typeof content === 'string') return cleanUser(content);
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  let toolOnly = content.length > 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      toolOnly = false;
      texts.push(b.text);
    } else if (b.type !== 'tool_result') toolOnly = false;
  }
  if (toolOnly) return 'silent';
  return cleanUser(texts.join('\n'));
}

type Turn = { role: 'user' | 'assistant'; text: string; uuid: string | null; at: string | null };
type Acc = { uuid: string | null; at: string | null; texts: string[]; tools: string[] };

function flush(acc: Acc | null): Turn | null {
  if (!acc) return null;
  const tools = [...new Set(acc.tools)];
  const body = acc.texts.join('\n\n');
  const toolLine = tools.length > 0 ? `〔工具：${tools.join('、')}〕` : '';
  const text = body ? (toolLine ? `${body}\n\n${toolLine}` : body) : toolLine;
  return text ? { role: 'assistant', text, uuid: acc.uuid, at: acc.at } : null;
}

/** 解析 Claude Code jsonl。没有任何一段 → null。不导工具输出、思考、子代理。 */
export function parseClaudeCodeSession(
  lines: Iterable<string>,
  opts?: { accountNamespace?: string },
): ParsedSource | null {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  const segs: Turn[] = [];
  let assistant: Acc | null = null;

  for (const line of lines) {
    const o = asObj(line);
    if (!o) continue;
    sessionId ??= str(o.sessionId);
    cwd ??= str(o.cwd);
    gitBranch ??= str(o.gitBranch);
    const type = str(o.type);
    // 标题会反复写、改过名的以最后一次为准
    if (type === 'custom-title') {
      customTitle = str(o.customTitle) ?? customTitle;
      continue;
    }
    if (type === 'ai-title') {
      aiTitle = str(o.aiTitle) ?? aiTitle;
      continue;
    }
    if (o.isSidechain === true) continue;
    // 不是你说的、也不是模型答的：Claude Code 自己注入的（技能展开、命令说明 isMeta）、
    // 上下文压缩后的摘要（isCompactSummary，AI 写的，原话在同一个文件前面）、
    // 接口出错时它合成的一句（isApiErrorMessage）。都不导，也不打断正在累积的回答。
    if (o.isMeta === true || o.isCompactSummary === true || o.isApiErrorMessage === true) continue;
    const uuid = str(o.uuid);
    const at = str(o.timestamp);
    const message =
      o.message && typeof o.message === 'object' ? (o.message as Record<string, unknown>) : null;
    const content = message?.content;
    if (type === 'user') {
      const u = userUtterance(content);
      if (u === 'silent' || u === null) continue;
      const flushed = flush(assistant);
      if (flushed) segs.push(flushed);
      assistant = null;
      segs.push({ role: 'user', text: u, uuid, at });
    } else if (type === 'assistant' && Array.isArray(content)) {
      if (!assistant) assistant = { uuid, at, texts: [], tools: [] };
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown; text?: unknown; name?: unknown };
        if (b.type === 'thinking') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text) assistant.texts.push(b.text);
        if (b.type === 'tool_use' && typeof b.name === 'string' && b.name)
          assistant.tools.push(b.name);
      }
    }
  }
  const last = flush(assistant);
  if (last) segs.push(last);
  if (segs.length === 0 || !sessionId) return null;

  const title = (
    customTitle ??
    aiTitle ??
    segs.find((s) => s.role === 'user')?.text ??
    segs[0]!.text
  ).slice(0, 80);
  const segments = segs.map((s, i) => ({
    sequence: i,
    role: s.role,
    externalNodeId: s.uuid,
    externalParentId: null,
    isActiveBranch: true,
    occurredAt: s.at,
    text: s.text,
    metadata: {},
  }));
  return {
    kind: 'conversation',
    provider: 'coding_agent',
    accountNamespace: normalizeAccountNamespace(opts?.accountNamespace),
    externalId: sessionId,
    title,
    contentHash: sha256(segments.map((s) => `${s.role}: ${s.text}`).join('\n')),
    capturedAt: segs[0]!.at,
    importMethod: 'history_export',
    segments,
    metadata: { tool: 'claude_code', cwd, gitBranch },
  };
}

/**
 * Codex 塞在「用户消息」开头、不是你打的字的标签：环境说明、注入的指令、插件推荐、中断记录、
 * 子代理通知、它自己的目标提示、内置浏览器的状态；问答回复是选项的 JSON，离开问题看不懂。
 * 标签可能带属性。去掉整个标签（到闭合标签为止），后面你的话留下——浏览器状态就是
 * 贴在你的话前面的（2026-09 本机会话）。没有闭合标签的，整段不要。
 */
const CODEX_WRAPPER_TAGS = [
  'environment_context',
  'user_instructions',
  'permissions instructions',
  'recommended_plugins',
  'turn_aborted',
  'subagent_notification',
  'send_user_message_question_reply',
  'codex_internal_context',
  'in-app-browser-context',
  // 2026-09-20 真机检查里新冒出来的一种（界面动作记录）
  'user_action',
];
/** 整段都不是你打的字：注入的 AGENTS.md、图片占位的首尾。 */
const CODEX_INJECTED = ['# AGENTS.md instructions', '<image', '</image>'];
/** 你在界面里带上文件时，Codex 把文件清单写在前面，你的话在这两个标记之一后面。 */
const FILES_MENTIONED = '# Files mentioned by the user';
const MY_REQUEST = ['## My request for Codex:', '## My request:'];

function stripWrapperTag(t: string): string | null {
  for (const tag of CODEX_WRAPPER_TAGS) {
    if (!t.startsWith(`<${tag}>`) && !t.startsWith(`<${tag} `)) continue;
    const close = `</${tag}>`;
    const end = t.indexOf(close);
    return end === -1 ? null : t.slice(end + close.length).trim();
  }
  return t;
}

function codexUserPart(text: string): string | null {
  let t: string | null = text.trim();
  // 可能叠着好几个标签
  for (let prev = ''; t && t !== prev;) {
    prev = t;
    t = stripWrapperTag(t);
  }
  const s = t ?? '';
  if (!s || CODEX_INJECTED.some((p) => s.startsWith(p))) return null;
  // 文件清单在前：你的话在标记后面，没有标记就只是清单。浏览器状态去掉后也是以标记开头
  const startsWithMarker = MY_REQUEST.some((m) => s.startsWith(m));
  if (!s.startsWith(FILES_MENTIONED) && !startsWithMarker) return s;
  for (const marker of MY_REQUEST) {
    const i = s.indexOf(marker);
    if (i !== -1) return s.slice(i + marker.length).trim() || null;
  }
  return null;
}

const CODEX_TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

/**
 * 会话文件大部分是工具输出（本机最大 1.5GB），先用字符串筛掉明显不要的行再 JSON.parse。
 * 字符串值里的引号是转义过的，工具输出里的文字不会冒充这几个键值。
 */
function codexLineMayMatter(line: string): boolean {
  return (
    line.includes('"session_meta"') || line.includes('"type":"message"') || line.includes('_call"')
  );
}

/** 解析 Codex rollout jsonl。子代理会话、没有任何一段 → null。不导推理、工具输出、注入的内容。 */
export function parseCodexSession(
  lines: Iterable<string>,
  opts?: { accountNamespace?: string },
): ParsedSource | null {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let metaSeen = false;
  const segs: Turn[] = [];
  let assistant: Acc | null = null;

  for (const line of lines) {
    if (!codexLineMayMatter(line)) continue;
    const o = asObj(line);
    const payload = obj(o?.payload);
    if (!o || !payload) continue;
    const at = str(o.timestamp);
    if (o.type === 'session_meta') {
      // 只认第一行，与导入时在开头判断子代理（isCodexSubagentSession）一致
      if (metaSeen) continue;
      metaSeen = true;
      const source = obj(payload.source);
      if (source && 'subagent' in source) return null;
      sessionId = str(payload.id) ?? str(payload.session_id);
      cwd = str(payload.cwd);
      gitBranch = str(obj(payload.git)?.branch);
      continue;
    }
    if (o.type !== 'response_item') continue;
    const kind = str(payload.type);
    if (kind && CODEX_TOOL_CALLS.has(kind)) {
      const name = str(payload.name) ?? (kind === 'local_shell_call' ? 'shell' : null);
      assistant ??= { uuid: null, at, texts: [], tools: [] };
      if (name) assistant.tools.push(name);
      continue;
    }
    if (kind !== 'message') continue;
    const blocks = Array.isArray(payload.content) ? payload.content.map(obj) : [];
    const texts = (type: string): string[] =>
      blocks.flatMap((b) => (b?.type === type && typeof b.text === 'string' ? [b.text] : []));
    if (payload.role === 'user') {
      const parts = texts('input_text').flatMap((t) => codexUserPart(t) ?? []);
      if (parts.length === 0) continue;
      const flushed = flush(assistant);
      if (flushed) segs.push(flushed);
      assistant = null;
      segs.push({ role: 'user', text: parts.join('\n'), uuid: null, at });
    } else if (payload.role === 'assistant') {
      const text = texts('output_text').join('');
      assistant ??= { uuid: null, at, texts: [], tools: [] };
      if (text) assistant.texts.push(text);
    }
  }
  const last = flush(assistant);
  if (last) segs.push(last);
  if (segs.length === 0 || !sessionId) return null;

  const title = (segs.find((s) => s.role === 'user')?.text ?? segs[0]!.text).slice(0, 80);
  const segments = segs.map((s, i) => ({
    sequence: i,
    role: s.role,
    externalNodeId: null,
    externalParentId: null,
    isActiveBranch: true,
    occurredAt: s.at,
    text: s.text,
    metadata: {},
  }));
  return {
    kind: 'conversation',
    provider: 'coding_agent',
    accountNamespace: normalizeAccountNamespace(opts?.accountNamespace),
    externalId: sessionId,
    title,
    contentHash: sha256(segments.map((s) => `${s.role}: ${s.text}`).join('\n')),
    capturedAt: segs[0]!.at,
    importMethod: 'history_export',
    segments,
    metadata: { tool: 'codex', cwd, gitBranch },
  };
}
