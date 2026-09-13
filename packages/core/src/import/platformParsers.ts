import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { sha256 } from '../vault.js';
import {
  type ParsedSegment,
  type ParsedSource,
  normalizeAccountNamespace,
  type SegmentRole,
} from './parsers.js';

/**
 * 三平台导入器（B5，口径 2026-09-13）：按公开导出格式实现，
 * 合成数据验证；真实数据由用户日后随用随填。
 *
 * 格式依据（导入器必须可版本化——上游可能变格式）：
 * - Claude（Settings → Privacy → Export Data，conversations.json）：
 *   顶层数组；对话 {uuid,name,created_at,updated_at,chat_messages[]}；
 *   消息 {uuid,sender(human|assistant),text,content[],attachments[],files[],
 *   created_at,parent_message_uuid}；对话线性（无分支树）。
 *   交叉核对：eudoxia0/claude-export notebook、shannon models.go、
 *   portable-ai-memory.org/providers/anthropic。
 * - Grok（grok.com → 设置 → 数据 → Export Data，prod-grok-backend.json）：
 *   顶层对象含 conversations 数组；条目 {conversation:{...}, responses:[{response:{...}}]}；
 *   response 有 _id/parent_response_id（DAG，同 ChatGPT mapping 语义）、
 *   sender（human/assistant/ASSISTANT/模型名，大小写不敏感归一）、message（正文）、
 *   create_time（BSON {"$date":{"$numberLong": ms}}）。
 * - Gemini（takeout.google.com → My Activity → Gemini Apps → JSON，
 *   MyActivity.json）：活动日志非对话存档；按 titleUrl 的 /app/c/<id> 分组、
 *   按 time 排序重建；变体 A details[{name:'Request'|'Response', value}] 与
 *   变体 B userInteractions[{userInteraction:{request,response}}] 可同文件混存；
 *   响应可能截断/缺失（如实在 metadata 标注，不冒充完整）。
 */

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

function toIsoOrNull(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const t = raw.trim();
    const date = new Date(t);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 秒或毫秒时间戳
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** Grok BSON 时间戳：{"$date":{"$numberLong":"1690000000000"}} 或直接数值。 */
function bsonToIso(raw: unknown): string | null {
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as { $date?: unknown };
    const inner = obj.$date;
    if (inner !== null && typeof inner === 'object') {
      const num = (inner as { $numberLong?: unknown }).$numberLong;
      if (typeof num === 'string' && /^\d+$/.test(num)) {
        return new Date(Number(num)).toISOString();
      }
      if (typeof num === 'number') return toIsoOrNull(num);
    }
    if (typeof inner === 'number') return toIsoOrNull(inner);
    return null;
  }
  return toIsoOrNull(raw);
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude conversations.json
// ---------------------------------------------------------------------------

interface RawClaudeMessage {
  uuid?: unknown;
  sender?: unknown;
  text?: unknown;
  content?: unknown;
  attachments?: unknown;
  files?: unknown;
  created_at?: unknown;
  parent_message_uuid?: unknown;
}

interface RawClaudeConversation {
  uuid?: unknown;
  name?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  chat_messages?: unknown;
}

/** Claude content[] 块 → 文本（text/thinking 提文本，其余记数量不冒充理解）。 */
function claudeBlocksToText(content: unknown): { text: string; otherBlocks: number } {
  if (!Array.isArray(content)) return { text: '', otherBlocks: 0 };
  let text = '';
  let otherBlocks = 0;
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      text += (text.length > 0 ? '\n' : '') + rec.text;
    } else if (rec.type === 'thinking' && typeof rec.thinking === 'string') {
      // 思维链不是用户原话，也不是最终回答正文：不计入正文，
      // 数量如实记录（提取阶段可按需回看原文）。
      otherBlocks += 1;
    } else {
      otherBlocks += 1;
    }
  }
  return { text, otherBlocks };
}

function claudeRole(sender: unknown): SegmentRole | null {
  const s = typeof sender === 'string' ? sender.toLowerCase() : '';
  if (s === 'human') return 'user';
  if (s === 'assistant') return 'assistant';
  return null;
}

/**
 * 解析 Claude 官方导出（conversations.json）。
 * 对话线性：按 chat_messages 顺序编号；attachments 提取文本入 segment
 * （服务器提取文本常是文档唯一可检索痕迹），files 只记名。
 */
export function parseClaudeConversations(
  conversations: unknown[],
  opts: { accountNamespace?: string },
): ParsedSource[] {
  const namespace = normalizeAccountNamespace(opts.accountNamespace);
  const sources: ParsedSource[] = [];
  for (const raw of conversations) {
    const conv = asRecord(raw) as RawClaudeConversation | null;
    if (!conv || !Array.isArray(conv.chat_messages)) continue;
    const title = firstString(conv.name, '未命名对话')!;
    const segments: ParsedSegment[] = [];
    let hashInput = '';
    let unparsedAttachments = 0;
    let missingMessageId = 0;
    let missingTime = 0;
    let seq = 0;

    for (const rawMsg of conv.chat_messages) {
      const msg = asRecord(rawMsg) as RawClaudeMessage | null;
      if (!msg) continue;
      const role = claudeRole(msg.sender);
      if (!role) continue;
      let text = typeof msg.text === 'string' ? msg.text : '';
      let otherBlocks = 0;
      if (text.trim().length === 0 && Array.isArray(msg.content)) {
        const fromBlocks = claudeBlocksToText(msg.content);
        text = fromBlocks.text;
        otherBlocks = fromBlocks.otherBlocks;
      }
      // attachments：服务器提取文本是可检索正文（文档常常只有这里出现）
      if (Array.isArray(msg.attachments)) {
        for (const att of msg.attachments) {
          const rec = asRecord(att);
          if (!rec) continue;
          const extracted = typeof rec.extracted_content === 'string' ? rec.extracted_content : '';
          const fileName = typeof rec.file_name === 'string' ? rec.file_name : '附件';
          if (extracted.trim().length > 0) {
            text += (text.length > 0 ? '\n' : '') + `[附件 ${fileName}]\n${extracted}`;
          } else {
            unparsedAttachments += 1;
          }
        }
      }
      if (Array.isArray(msg.files)) {
        for (const f of msg.files) {
          const rec = asRecord(f);
          if (rec && typeof rec.file_name === 'string') {
            text += `\n[文件 ${rec.file_name}（内容未随导出提供）]`;
            unparsedAttachments += 1;
          }
        }
      }
      if (text.trim().length === 0) continue;

      const msgUuid = typeof msg.uuid === 'string' ? msg.uuid : null;
      const occurredAt = toIsoOrNull(msg.created_at);
      if (!occurredAt) missingTime += 1;
      if (!msgUuid) missingMessageId += 1;
      const metadata: Record<string, unknown> = {
        original_sender: typeof msg.sender === 'string' ? msg.sender : null,
      };
      if (otherBlocks > 0) {
        metadata.non_text_blocks = otherBlocks;
        metadata.unparsed_note = 'thinking/tool_use/tool_result 等块未计入正文，不声称已理解';
      }
      segments.push({
        sequence: seq++,
        role,
        externalNodeId: msgUuid,
        externalParentId:
          typeof msg.parent_message_uuid === 'string' ? msg.parent_message_uuid : null,
        isActiveBranch: true, // Claude 导出对话线性，无分支树
        occurredAt,
        text,
        metadata,
      });
      hashInput += `${msgUuid ?? ''}|${role}|${occurredAt ?? ''}|${text}\n`;
    }

    const convUuid = typeof conv.uuid === 'string' ? conv.uuid : '';
    const hasId = convUuid.length > 0;
    const missingFields: string[] = [];
    if (!hasId) missingFields.push('conversation_id');
    if (missingMessageId > 0) missingFields.push('message_id');
    if (missingTime > 0) missingFields.push('occurred_at');
    if (unparsedAttachments > 0) missingFields.push('attachments_content');
    const externalId = hasId
      ? convUuid
      : `missing-id:${sha256(`${title}|${hashInput}`).slice(0, 24)}`;

    sources.push({
      kind: 'conversation',
      provider: 'claude_export',
      accountNamespace: namespace,
      externalId,
      title,
      contentHash: sha256(
        `${namespace}|claude|${externalId}|${title}|${conv.created_at ?? ''}|${conv.updated_at ?? ''}|${hashInput}`,
      ),
      capturedAt: toIsoOrNull(conv.updated_at ?? conv.created_at),
      importMethod: 'history_export',
      segments,
      metadata: {
        platform: 'claude',
        account_namespace: namespace,
        conversation_id: hasId ? convUuid : null,
        import_method: 'history_export',
        missing_fields: missingFields,
        unparsed_attachments: unparsedAttachments,
      },
    });
  }
  if (sources.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, 'Claude conversations.json 中没有可解析的对话');
  }
  return sources;
}

/** 内容嗅探：Claude 导出（数组且元素带 chat_messages）。 */
export function looksLikeClaudeExport(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  for (const raw of parsed) {
    const rec = asRecord(raw);
    if (rec && Array.isArray(rec.chat_messages)) return true;
    if (rec && !Array.isArray(rec.chat_messages) && !rec.mapping) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grok prod-grok-backend.json
// ---------------------------------------------------------------------------

interface RawGrokResponse {
  _id?: unknown;
  parent_response_id?: unknown;
  sender?: unknown;
  message?: unknown;
  create_time?: unknown;
  model?: unknown;
}

interface RawGrokConversation {
  conversation?: unknown;
  responses?: unknown;
}

/** Grok message 字段兼容：字符串 / {content:{text}} / {text} / {content:[块]}。 */
function grokMessageText(message: unknown): string {
  if (typeof message === 'string') return message;
  const rec = asRecord(message);
  if (!rec) return '';
  if (typeof rec.text === 'string') return rec.text;
  const content = asRecord(rec.content);
  if (content && typeof content.text === 'string') return content.text;
  if (Array.isArray(rec.content)) {
    // 兼容消息块数组（取 text 块拼接）
    let text = '';
    for (const b of rec.content) {
      const br = asRecord(b);
      if (br && typeof br.text === 'string') text += (text ? '\n' : '') + br.text;
    }
    return text;
  }
  if (typeof rec.content === 'string') return rec.content;
  return '';
}

/** sender 归一：非 human（大小写不敏感）一律 assistant（官方映射口径）。 */
function grokRole(sender: unknown): SegmentRole {
  const s = typeof sender === 'string' ? sender.toLowerCase() : '';
  return s === 'human' ? 'user' : 'assistant';
}

/**
 * 解析 Grok 官方导出（prod-grok-backend.json 的 conversations 数组）。
 * parent_response_id 构成 DAG：同 ChatGPT mapping 语义——全部保留、
 * 无活跃分支标记（导出未提供游标），isActiveBranch 全 true 表示
 * 按导出顺序全量可见，分支拓扑记入 metadata 供提取阶段甄别。
 */
export function parseGrokConversations(
  entries: unknown[],
  opts: { accountNamespace?: string },
): ParsedSource[] {
  const namespace = normalizeAccountNamespace(opts.accountNamespace);
  const sources: ParsedSource[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw) as RawGrokConversation | null;
    if (!entry) continue;
    const conv = asRecord(entry.conversation);
    if (!conv) continue;
    const responses = Array.isArray(entry.responses) ? entry.responses : [];
    const title = firstString(conv.title, `未命名对话`) ?? '未命名对话';

    const segments: ParsedSegment[] = [];
    let hashInput = '';
    let missingMessageId = 0;
    let missingTime = 0;
    let seq = 0;
    for (const rawResp of responses) {
      const wrap = asRecord(rawResp);
      const resp = (asRecord(wrap?.response) ?? asRecord(rawResp)) as RawGrokResponse | null;
      if (!resp) continue;
      const text = grokMessageText(resp.message);
      if (text.trim().length === 0) continue;
      const role = grokRole(resp.sender);
      const id = typeof resp._id === 'string' ? resp._id : null;
      const occurredAt = bsonToIso(resp.create_time);
      if (!id) missingMessageId += 1;
      if (!occurredAt) missingTime += 1;
      const metadata: Record<string, unknown> = {
        original_sender: typeof resp.sender === 'string' ? resp.sender : null,
      };
      if (typeof resp.model === 'string') metadata.model = resp.model;
      segments.push({
        sequence: seq++,
        role,
        externalNodeId: id,
        externalParentId:
          typeof resp.parent_response_id === 'string' ? resp.parent_response_id : null,
        isActiveBranch: true, // 导出未提供活跃游标；拓扑在 metadata
        occurredAt,
        text,
        metadata,
      });
      hashInput += `${id ?? ''}|${role}|${occurredAt ?? ''}|${text}\n`;
    }

    const convId = firstString(conv.id);
    const hasId = convId !== null;
    const missingFields: string[] = [];
    if (!hasId) missingFields.push('conversation_id');
    if (missingMessageId > 0) missingFields.push('message_id');
    if (missingTime > 0) missingFields.push('occurred_at');
    const externalId = hasId
      ? convId!
      : `missing-id:${sha256(`${title}|${hashInput}`).slice(0, 24)}`;
    const parentIdCount = segments.filter((s) => s.externalParentId !== null).length;

    sources.push({
      kind: 'conversation',
      provider: 'grok_export',
      accountNamespace: namespace,
      externalId,
      title,
      contentHash: sha256(`${namespace}|grok|${externalId}|${title}|${hashInput}`),
      capturedAt: toIsoOrNull(conv.modify_time ?? conv.create_time),
      importMethod: 'history_export',
      segments,
      metadata: {
        platform: 'grok',
        account_namespace: namespace,
        conversation_id: hasId ? convId : null,
        import_method: 'history_export',
        missing_fields: missingFields,
        dag_edges: parentIdCount,
        note: 'parent_response_id DAG 已保留；导出无活跃分支游标，全部标记可见，拓扑见 dag_edges',
      },
    });
  }
  if (sources.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, 'Grok 导出中没有可解析的对话');
  }
  return sources;
}

/** 内容嗅探：Grok 导出（对象带 conversations，或数组元素为 {conversation, responses}）。 */
export function looksLikeGrokExport(parsed: unknown): boolean {
  const root = asRecord(parsed);
  const arr = Array.isArray(parsed)
    ? parsed
    : root && Array.isArray(root.conversations)
      ? root.conversations
      : null;
  if (!arr || arr.length === 0) return false;
  for (const raw of arr) {
    const rec = asRecord(raw);
    if (rec && (rec.conversation !== undefined || rec.responses !== undefined)) return true;
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gemini MyActivity.json（Takeout）
// ---------------------------------------------------------------------------

interface GeminiEntry {
  title?: unknown;
  titleUrl?: unknown;
  time?: unknown;
  details?: unknown;
  userInteractions?: unknown;
}

/** 变体 A：details[{name:'Request'|'Response', value}]。 */
function geminiDetailsToMessages(details: unknown): Array<{ role: SegmentRole; text: string }> {
  if (!Array.isArray(details)) return [];
  const out: Array<{ role: SegmentRole; text: string }> = [];
  for (const d of details) {
    const rec = asRecord(d);
    if (!rec) continue;
    const name = typeof rec.name === 'string' ? rec.name.toLowerCase() : '';
    const value = typeof rec.value === 'string' ? rec.value : '';
    if (value.trim().length === 0) continue;
    if (name === 'request') out.push({ role: 'user', text: value });
    else if (name === 'response') out.push({ role: 'assistant', text: value });
  }
  return out;
}

/** 变体 B：userInteractions[{userInteraction:{request, response}}]（序列化 JSON 字符串）。 */
function geminiInteractionsToMessages(
  interactions: unknown,
): Array<{ role: SegmentRole; text: string }> {
  if (!Array.isArray(interactions)) return [];
  const out: Array<{ role: SegmentRole; text: string }> = [];
  for (const rawUi of interactions) {
    const ui = asRecord(asRecord(rawUi)?.userInteraction);
    if (!ui) continue;
    for (const pair of [['request', 'user'] as const, ['response', 'assistant'] as const]) {
      const rawVal = ui[pair[0]];
      let text = '';
      if (typeof rawVal === 'string') {
        text = rawVal;
        // 序列化 JSON：尝试提取可读文本
        if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
          try {
            const parsedJson = JSON.parse(text) as unknown;
            text = extractTextFromSerialized(parsedJson) ?? text;
          } catch {
            // 保持原样（可能就是正文本身）
          }
        }
      }
      if (text.trim().length > 0) out.push({ role: pair[1], text });
    }
  }
  return out;
}

function extractTextFromSerialized(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    const parts = node.map(extractTextFromSerialized).filter((s): s is string => s !== null);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  const rec = asRecord(node);
  if (rec) {
    for (const key of ['text', 'value', 'content', 'prompt', 'answer']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    for (const v of Object.values(rec)) {
      const nested = extractTextFromSerialized(v);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** 从 titleUrl 提取会话 ID：gemini.google.com 路径 /app/c/<id>。 */
function geminiConversationId(titleUrl: unknown): string | null {
  if (typeof titleUrl !== 'string' || titleUrl.length === 0) return null;
  const m = /\/app\/c\/([A-Za-z0-9_-]+)/.exec(titleUrl);
  return m ? m[1]! : null;
}

/**
 * 解析 Gemini Takeout 导出（MyActivity.json）。
 * 活动日志按会话分组重建：同 titleUrl 会话 ID 的条目按时间排序合并为一个来源；
 * 标题取首条用户消息（title 恒为 "Used Gemini Apps" 无意义）；
 * 响应截断/缺失（Takeout 已知数据损失）如实在 metadata 标注。
 */
export function parseGeminiActivity(
  entries: unknown[],
  opts: { accountNamespace?: string },
): ParsedSource[] {
  const namespace = normalizeAccountNamespace(opts.accountNamespace);
  // 按会话 ID 分组（无 ID 的条目各自独立成组，标 missing conversation_id）
  const groups = new Map<string, { entries: GeminiEntry[]; missingId: boolean }>();
  let noIdSeq = 0;
  for (const raw of entries) {
    const rec = asRecord(raw) as GeminiEntry | null;
    if (!rec) continue;
    const convId = geminiConversationId(rec.titleUrl);
    const key = convId ?? `no-id-${noIdSeq++}`;
    const group = groups.get(key) ?? { entries: [], missingId: convId === null };
    group.entries.push(rec);
    groups.set(key, group);
  }

  const sources: ParsedSource[] = [];
  for (const [key, group] of groups) {
    const sorted = group.entries
      .map((e) => ({ e, t: toIsoOrNull(e.time) }))
      .sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''));
    const segments: ParsedSegment[] = [];
    let hashInput = '';
    let seq = 0;
    let missingResponse = 0;
    for (const { e, t } of sorted) {
      const msgs = [
        ...geminiDetailsToMessages(e.details),
        ...geminiInteractionsToMessages(e.userInteractions),
      ];
      if (msgs.length === 0) continue;
      const hasAssistant = msgs.some((m) => m.role === 'assistant');
      if (!hasAssistant) missingResponse += 1;
      for (const m of msgs) {
        segments.push({
          sequence: seq++,
          role: m.role,
          externalNodeId: null, // Takeout 不提供消息 ID
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: t,
          text: m.text,
          metadata: { variant: Array.isArray(e.details) ? 'details' : 'userInteractions' },
        });
        hashInput += `${m.role}|${t ?? ''}|${m.text}\n`;
      }
    }
    if (segments.length === 0) continue;

    // 标题：首条用户消息截断；无则未命名
    const firstUser = segments.find((s) => s.role === 'user');
    const title = firstUser
      ? firstUser.text.replace(/\s+/g, ' ').slice(0, 80)
      : '未命名 Gemini 会话';
    const missingFields: string[] = [];
    if (group.missingId) missingFields.push('conversation_id');
    missingFields.push('message_id'); // Takeout 恒不提供
    if (missingResponse > 0) missingFields.push('assistant_response');

    sources.push({
      kind: 'conversation',
      provider: 'gemini_export',
      accountNamespace: namespace,
      externalId: group.missingId
        ? `missing-id:${sha256(`${title}|${hashInput}`).slice(0, 24)}`
        : key,
      title,
      contentHash: sha256(`${namespace}|gemini|${key}|${hashInput}`),
      capturedAt: toIsoOrNull(sorted[sorted.length - 1]?.e.time),
      importMethod: 'history_export',
      segments,
      metadata: {
        platform: 'gemini',
        account_namespace: namespace,
        conversation_id: group.missingId ? null : key,
        import_method: 'history_export',
        missing_fields: missingFields,
        truncated_responses: missingResponse,
        note: 'Takeout 为活动日志：按 titleUrl 分组重建；响应可能被官方截断，不冒充完整对话',
      },
    });
  }
  if (sources.length === 0) {
    throw new IxaError(ErrorCodes.PARSE_FAILED, 'Gemini MyActivity.json 中没有可解析的活动');
  }
  return sources;
}

/** 内容嗅探：Gemini Takeout（数组元素带 titleUrl 或 time + details/userInteractions）。 */
export function looksLikeGeminiExport(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  let withUrl = 0;
  for (const raw of parsed) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (typeof rec.titleUrl === 'string') withUrl += 1;
    if (Array.isArray(rec.details) || Array.isArray(rec.userInteractions)) return true;
  }
  return withUrl > 0;
}
