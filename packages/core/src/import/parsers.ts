import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { sha256 } from '../vault.js';

/** 片段角色。 */
export type SegmentRole = 'user' | 'assistant' | 'system' | 'document';

/** 解析后的来源（未入库）。 */
export interface ParsedSegment {
  sequence: number;
  role: SegmentRole;
  externalNodeId: string | null;
  externalParentId: string | null;
  isActiveBranch: boolean;
  occurredAt: string | null;
  text: string;
  metadata: Record<string, unknown>;
}

export interface ParsedSource {
  kind: 'conversation' | 'document' | 'project_snapshot';
  provider: 'chatgpt_export' | 'local_file' | 'project';
  /** 用户自命名的本地账户命名空间；默认 local。不读取密码/Cookie。 */
  accountNamespace: string;
  externalId: string;
  title: string;
  /** 来源级内容指纹（用于幂等去重） */
  contentHash: string;
  capturedAt: string | null;
  /** 导入方式：一次性历史导出 / 当前可见对话增量 / 本地文件 / 项目快照 */
  importMethod: 'history_export' | 'live_capture' | 'local_file' | 'project_snapshot';
  segments: ParsedSegment[];
  metadata: Record<string, unknown>;
}

/** 规范化导入元数据（S2）：所有平台同一结构。缺失字段显式标记，不凭标题合并。 */
export interface CanonicalImportMeta {
  platform: string;
  account_namespace: string;
  conversation_id: string;
  import_method: ParsedSource['importMethod'];
  missing_fields: string[];
  unparsed_attachments: number;
}

export const DEFAULT_ACCOUNT_NAMESPACE = 'local';

export function normalizeAccountNamespace(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  return t.length > 0 ? t.slice(0, 80) : DEFAULT_ACCOUNT_NAMESPACE;
}

// ---------------------------------------------------------------------------
// Markdown / TXT / JSON 普通文档
// ---------------------------------------------------------------------------

/**
 * Markdown/TXT 按标题与段落拆成可引用 segment（修复 P1-10）：
 * - Markdown 标题行起一个新 segment；
 * - 标题下的连续非空行聚合为同一段（空行 = 段落边界）；
 * - 超长段（> 6000 字符）继续按安全字符边界拆分（段落/句子/标点优先），
 *   保证单段不会撑爆提取块预算；
 * - Vault 中的原始文件逐字不变（拆分只影响 segments 结构化表达）。
 */
const MAX_DOC_SEGMENT_CHARS = 6000;

function chunkLongText(text: string): string[] {
  if (text.length <= MAX_DOC_SEGMENT_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  let guard = 0;
  while (rest.length > MAX_DOC_SEGMENT_CHARS && guard++ < 100_000) {
    const window = rest.slice(0, MAX_DOC_SEGMENT_CHARS);
    let cut = -1;
    for (const re of [/[。！？!?]/g, /[；;：:]/g, /[，、,]/g, /\s/g]) {
      const matches = [...window.matchAll(re)];
      if (matches.length > 0) {
        const last = matches[matches.length - 1]!.index! + 1;
        if (last >= MAX_DOC_SEGMENT_CHARS / 2) {
          cut = last;
          break;
        }
      }
    }
    if (cut < 0) cut = MAX_DOC_SEGMENT_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

function splitDocToSegments(
  text: string,
  format: 'markdown' | 'text',
): Array<{ text: string; heading: string | null }> {
  const lines = text.split('\n');
  const collected: Array<{ text: string; heading: string | null; buffer: string[] }> = [];
  let current: { text: string; heading: string | null; buffer: string[] } | null = null;
  const flush = () => {
    if (current && current.buffer.join('\n').trim().length > 0) collected.push(current);
    current = null;
  };
  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (format === 'markdown' && headingMatch) {
      flush();
      current = { text: '', heading: headingMatch[2]!.trim(), buffer: [line] };
      continue;
    }
    // 空行 = 段落边界（text 格式也按空行分段）
    if (line.trim().length === 0 && current) {
      flush();
      continue;
    }
    if (!current) current = { text: '', heading: null, buffer: [] };
    current.buffer.push(line);
  }
  flush();

  // 展开超长段
  const expanded: Array<{ text: string; heading: string | null }> = [];
  for (const seg of collected) {
    const joined = seg.buffer.join('\n').trim();
    if (joined.length === 0) continue;
    for (const part of chunkLongText(joined)) {
      expanded.push({ text: part, heading: seg.heading });
    }
  }
  return expanded;
}

function buildDocumentSegments(
  content: string,
  format: 'markdown' | 'text',
  opts: { title: string; externalId: string; capturedAt?: string | null },
): ParsedSource {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, '文档为空');
  }
  const pieces = splitDocToSegments(text, format);
  const segments: ParsedSegment[] = pieces.map((p, i) => ({
    sequence: i,
    role: 'document',
    externalNodeId: p.heading ? `h:${i}` : null,
    externalParentId: null,
    isActiveBranch: true,
    occurredAt: opts.capturedAt ?? null,
    text: p.text,
    metadata: p.heading ? { format, heading: p.heading } : { format },
  }));
  return {
    kind: 'document',
    provider: 'local_file',
    accountNamespace: DEFAULT_ACCOUNT_NAMESPACE,
    externalId: opts.externalId,
    title: opts.title,
    contentHash: sha256(text),
    capturedAt: opts.capturedAt ?? null,
    importMethod: 'local_file',
    segments,
    metadata: {
      format,
      chars: text.length,
      segments: segments.length,
      headings: pieces.filter((p) => p.heading).length,
      platform: 'local_file',
      account_namespace: DEFAULT_ACCOUNT_NAMESPACE,
      import_method: 'local_file',
      missing_fields: ['conversation_id', 'message_id', 'parent_id', 'occurred_at'],
      unparsed_attachments: 0,
    },
  };
}

export function parseMarkdownDocument(
  content: string,
  opts: { title: string; externalId: string; capturedAt?: string | null },
): ParsedSource {
  return buildDocumentSegments(content, 'markdown', opts);
}

export function parseTextDocument(
  content: string,
  opts: { title: string; externalId: string; capturedAt?: string | null },
): ParsedSource {
  return buildDocumentSegments(content, 'text', opts);
}

/** 若内容是 ChatGPT conversations.json 数组则返回解析结果，否则 null。 */
export function tryParseChatgptConversations(
  content: string,
  opts?: { accountNamespace?: string },
): ParsedSource[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !isChatgptConversationArray(parsed)) {
    return null;
  }
  return parseChatgptConversations(parsed, {
    externalId: '',
    accountNamespace: opts?.accountNamespace,
  });
}

export function parseJsonDocument(
  content: string,
  opts: { title: string; externalId: string; capturedAt?: string | null },
): ParsedSource {
  // 先尝试按 ChatGPT 导出解析；否则按普通 JSON 文档处理
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, `JSON 解析失败: ${String(err)}`);
  }
  if (Array.isArray(parsed) && parsed.length > 0 && isChatgptConversationArray(parsed)) {
    // conversations.json（数组）由导入器统一处理，普通 JSON 文档解析不覆盖该场景
    throw new IxaError(
      ErrorCodes.UNSUPPORTED_FORMAT,
      '该文件是 ChatGPT 对话导出，请使用 ChatGPT 导入入口',
    );
  }
  const text = content.replace(/\r\n/g, '\n').trim();
  let title = opts.title;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const maybeTitle = (parsed as Record<string, unknown>)['docTitle'];
    if (typeof maybeTitle === 'string' && maybeTitle.trim().length > 0) title = maybeTitle.trim();
  }
  return {
    kind: 'document',
    provider: 'local_file',
    accountNamespace: DEFAULT_ACCOUNT_NAMESPACE,
    externalId: opts.externalId,
    title,
    contentHash: sha256(text),
    capturedAt: opts.capturedAt ?? null,
    importMethod: 'local_file',
    segments: [
      {
        sequence: 0,
        role: 'document',
        externalNodeId: null,
        externalParentId: null,
        isActiveBranch: true,
        occurredAt: opts.capturedAt ?? null,
        text,
        metadata: { format: 'json' },
      },
    ],
    metadata: {
      format: 'json',
      chars: text.length,
      platform: 'local_file',
      account_namespace: DEFAULT_ACCOUNT_NAMESPACE,
      import_method: 'local_file',
      missing_fields: ['conversation_id', 'message_id', 'parent_id', 'occurred_at'],
      unparsed_attachments: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// ChatGPT conversations.json
// ---------------------------------------------------------------------------

interface RawMessage {
  id?: string;
  author?: { role?: string };
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[] };
  status?: string;
  metadata?: Record<string, unknown>;
}

interface RawNode {
  id: string;
  message: RawMessage | null;
  parent: string | null;
  children: string[];
}

interface RawConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  conversation_id?: string;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

function isChatgptConversationArray(arr: unknown[]): boolean {
  return arr.every(
    (c) =>
      c !== null &&
      typeof c === 'object' &&
      'mapping' in (c as Record<string, unknown>) &&
      'title' in (c as Record<string, unknown>),
  );
}

function unixToIso(unix: number | null | undefined): string | null {
  if (typeof unix !== 'number' || !Number.isFinite(unix)) return null;
  return new Date(unix * 1000).toISOString();
}

function mapRole(role: string | undefined): SegmentRole | null {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'document';
    default:
      return null;
  }
}

/** 提取消息文本：仅拼接字符串 part；非文本 part 计数入 metadata。 */
function extractText(message: RawMessage): { text: string; nonTextParts: number } {
  const parts = message.content?.parts ?? [];
  const texts: string[] = [];
  let nonText = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      texts.push(part);
    } else if (
      part !== null &&
      typeof part === 'object' &&
      typeof (part as Record<string, unknown>)['text'] === 'string'
    ) {
      texts.push((part as Record<string, unknown>)['text'] as string);
    } else {
      nonText += 1;
    }
  }
  return { text: texts.join('\n').trim(), nonTextParts: nonText };
}

/**
 * 解析 ChatGPT 导出的对话数组。
 * - mapping 是树状结构，必须保留父子关系（externalNodeId / externalParentId）。
 * - current_node 指向活动分支末端；从 current_node 回溯到根的路径为活动分支，
 *   其余兄弟节点标记为非活动分支（默认不参与提取，但原文完整保留）。
 * - 同一对话的每次导出内容变化会产生不同 contentHash（新版本，不覆盖）。
 */
export function parseChatgptConversations(
  conversations: unknown[],
  opts: { externalId: string; accountNamespace?: string },
): ParsedSource[] {
  const namespace = normalizeAccountNamespace(opts.accountNamespace);
  const sources: ParsedSource[] = [];
  for (const raw of conversations) {
    if (raw === null || typeof raw !== 'object') continue;
    const conv = raw as RawConversation;
    const mapping = conv.mapping ?? {};
    const title = (conv.title ?? '未命名对话').trim() || '未命名对话';

    // 活动分支：current_node → 根
    const activeNodes = new Set<string>();
    let cursor: string | null = conv.current_node ?? null;
    while (cursor && mapping[cursor] && !activeNodes.has(cursor)) {
      activeNodes.add(cursor);
      cursor = mapping[cursor]?.parent ?? null;
    }

    // 从根开始遍历（父节点先于子节点），按访问顺序编号。
    // 迭代式（显式栈）：官方导出可含数万消息的长链，递归会栈溢出。
    const roots = Object.values(mapping).filter((n) => n.parent === null);
    const segments: ParsedSegment[] = [];
    const visited = new Set<string>();
    let sequence = 0;
    // contentHash 基于消息内容增量哈希（不整体 JSON.stringify —— 50k 消息时
    // 会把整个对话再复制成一份巨大字符串，违反流式底线）
    let hashInput = '';
    let unparsedAttachments = 0;
    let missingMessageId = 0;
    let missingTime = 0;

    const stack: Array<{ node: RawNode; parentActive: boolean }> = roots.map((r) => ({
      node: r,
      parentActive: true,
    }));
    while (stack.length > 0) {
      const { node, parentActive } = stack.pop()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      const isActive = activeNodes.has(node.id) && parentActive;
      const msg = node.message;
      if (msg) {
        const role = mapRole(msg.author?.role);
        const { text, nonTextParts } = extractText(msg);
        if (role && text.length > 0) {
          const metadata: Record<string, unknown> = {
            content_type: msg.content?.content_type ?? 'text',
            status: msg.status ?? null,
            original_role: msg.author?.role ?? null,
          };
          if (nonTextParts > 0) {
            metadata.non_text_parts = nonTextParts;
            metadata.unparsed_attachment = true;
            metadata.unparsed_note = '附件/图片/音频未解析，不自动拉取 URL，不声称已理解内容';
            unparsedAttachments += nonTextParts;
          }
          const occurredAt = unixToIso(msg.create_time);
          if (!occurredAt) missingTime += 1;
          if (!node.id) missingMessageId += 1;
          segments.push({
            sequence: sequence++,
            role,
            externalNodeId: node.id ?? null,
            externalParentId: node.parent,
            isActiveBranch: isActive,
            occurredAt,
            text,
            metadata,
          });
          hashInput += `${node.id}|${role}|${msg.create_time ?? ''}|${text}\n`;
        }
      }
      // 子节点逆序入栈，保证出栈顺序与原递归 DFS（先序）一致
      const children = node.children
        .map((cid) => mapping[cid])
        .filter((c): c is RawNode => c !== undefined);
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i]!, parentActive: isActive });
      }
    }

    const hasConversationId =
      typeof conv.conversation_id === 'string' && conv.conversation_id.length > 0;
    const externalId = hasConversationId
      ? conv.conversation_id!
      : `missing-id:${sha256(`${title}|${conv.create_time ?? 0}|${hashInput}`).slice(0, 24)}`;
    const missingFields: string[] = [];
    if (!hasConversationId) missingFields.push('conversation_id');
    if (missingMessageId > 0) missingFields.push('message_id');
    if (missingTime > 0) missingFields.push('occurred_at');

    sources.push({
      kind: 'conversation',
      provider: 'chatgpt_export',
      accountNamespace: namespace,
      externalId,
      title,
      contentHash: sha256(
        `${namespace}|${externalId}|${title}|${conv.create_time ?? ''}|${conv.update_time ?? ''}|${hashInput}`,
      ),
      capturedAt: unixToIso(conv.update_time ?? conv.create_time),
      importMethod: 'history_export',
      segments,
      metadata: {
        platform: 'chatgpt',
        account_namespace: namespace,
        conversation_id: hasConversationId ? conv.conversation_id : null,
        import_method: 'history_export',
        create_time: conv.create_time ?? null,
        update_time: conv.update_time ?? null,
        active_branch_nodes: activeNodes.size,
        total_nodes: Object.keys(mapping).length,
        missing_fields: missingFields,
        unparsed_attachments: unparsedAttachments,
      },
    });
  }
  if (sources.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, 'conversations.json 中没有可解析的对话');
  }
  return sources;
}
