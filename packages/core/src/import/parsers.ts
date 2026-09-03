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
  externalId: string;
  title: string;
  /** 来源级内容指纹（用于幂等去重） */
  contentHash: string;
  capturedAt: string | null;
  segments: ParsedSegment[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Markdown / TXT / JSON 普通文档
// ---------------------------------------------------------------------------

export function parseMarkdownDocument(
  content: string,
  opts: { title: string; externalId: string; capturedAt?: string | null },
): ParsedSource {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, '文档为空');
  }
  return {
    kind: 'document',
    provider: 'local_file',
    externalId: opts.externalId,
    title: opts.title,
    contentHash: sha256(text),
    capturedAt: opts.capturedAt ?? null,
    segments: [
      {
        sequence: 0,
        role: 'document',
        externalNodeId: null,
        externalParentId: null,
        isActiveBranch: true,
        occurredAt: opts.capturedAt ?? null,
        text,
        metadata: { format: 'markdown' },
      },
    ],
    metadata: { format: 'markdown', chars: text.length },
  };
}

export function parseTextDocument(
  content: string,
  opts: { title: string; externalId: string; capturedAt?: string | null },
): ParsedSource {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, '文档为空');
  }
  return {
    kind: 'document',
    provider: 'local_file',
    externalId: opts.externalId,
    title: opts.title,
    contentHash: sha256(text),
    capturedAt: opts.capturedAt ?? null,
    segments: [
      {
        sequence: 0,
        role: 'document',
        externalNodeId: null,
        externalParentId: null,
        isActiveBranch: true,
        occurredAt: opts.capturedAt ?? null,
        text,
        metadata: { format: 'text' },
      },
    ],
    metadata: { format: 'text', chars: text.length },
  };
}

/** 若内容是 ChatGPT conversations.json 数组则返回解析结果，否则 null。 */
export function tryParseChatgptConversations(content: string): ParsedSource[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !isChatgptConversationArray(parsed)) {
    return null;
  }
  return parseChatgptConversations(parsed, { externalId: '' });
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
    externalId: opts.externalId,
    title,
    contentHash: sha256(text),
    capturedAt: opts.capturedAt ?? null,
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
    metadata: { format: 'json', chars: text.length },
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
  opts: { externalId: string },
): ParsedSource[] {
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

    // 从根开始 DFS（父节点先于子节点），按访问顺序编号
    const roots = Object.values(mapping).filter((n) => n.parent === null);
    const segments: ParsedSegment[] = [];
    const visited = new Set<string>();
    let sequence = 0;

    const dfs = (node: RawNode, parentActive: boolean): void => {
      if (visited.has(node.id)) return;
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
          if (nonTextParts > 0) metadata.non_text_parts = nonTextParts;
          segments.push({
            sequence: sequence++,
            role,
            externalNodeId: node.id,
            externalParentId: node.parent,
            isActiveBranch: isActive,
            occurredAt: unixToIso(msg.create_time),
            text,
            metadata,
          });
        }
      }
      for (const childId of node.children) {
        const child = mapping[childId];
        if (child) dfs(child, isActive);
      }
    };
    for (const root of roots) dfs(root, true);

    const externalId =
      typeof conv.conversation_id === 'string' && conv.conversation_id.length > 0
        ? conv.conversation_id
        : `${title}#${conv.create_time ?? 0}`;

    sources.push({
      kind: 'conversation',
      provider: 'chatgpt_export',
      externalId,
      title,
      contentHash: sha256(JSON.stringify(conv)),
      capturedAt: unixToIso(conv.update_time ?? conv.create_time),
      segments,
      metadata: {
        create_time: conv.create_time ?? null,
        update_time: conv.update_time ?? null,
        active_branch_nodes: activeNodes.size,
        total_nodes: Object.keys(mapping).length,
      },
    });
  }
  if (sources.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, 'conversations.json 中没有可解析的对话');
  }
  void opts;
  return sources;
}
