import { sha256 } from '../vault.js';
import { normalizeAccountNamespace, type ParsedSource } from './parsers.js';

const CMD = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-caveat>',
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

/** 有一行带字符串 sessionId 和 type → Claude Code；S2 再加 Codex。 */
export function detectAgentSession(lines: string[]): 'claude_code' | 'codex' | null {
  for (const line of lines) {
    const o = asObj(line);
    if (o && typeof o.sessionId === 'string' && 'type' in o) return 'claude_code';
  }
  return null;
}

function cleanUser(text: string): string | null {
  const t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t || CMD.some((p) => t.trimStart().startsWith(p))) return null;
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
    if (type === 'custom-title') {
      customTitle ??= str(o.customTitle);
      continue;
    }
    if (type === 'ai-title') {
      aiTitle ??= str(o.aiTitle);
      continue;
    }
    if (o.isSidechain === true) continue;
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
