import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'streaming' | 'complete' | 'failed' | 'cancelled';

export interface MessageCitation {
  ref: string;
  segmentId: string;
  sourceTitle: string;
  role: string;
  excerpt: string;
  isUserCorrection: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** 最近一次使用的引擎。会话本身是进程内的，重启后 engineSessionId 被清空。 */
  engine: string | null;
  engineSessionId: string | null;
  /** 本对话派生出的 ask_session 来源（D5 追加式写入，不是每轮一条）。 */
  sourceId: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
  updatedAt: string;
  runId: string | null;
  engine: string | null;
  modelName: string | null;
  citations: MessageCitation[];
  meta: Record<string, unknown>;
  errorMessage: string | null;
}

export interface ConversationSummary extends Conversation {
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

const DEFAULT_TITLE = '新对话';
const TITLE_MAX = 40;
const PREVIEW_MAX = 80;

function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    projectId: (row['project_id'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    archivedAt: (row['archived_at'] as string | null) ?? null,
    engine: (row['engine'] as string | null) ?? null,
    engineSessionId: (row['engine_session_id'] as string | null) ?? null,
    sourceId: (row['source_id'] as string | null) ?? null,
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 损坏的 JSON 不能让整段对话打不开：退回默认值，正文仍然可读。
    return fallback;
  }
}

function toMessage(row: Record<string, unknown>): Message {
  return {
    id: row['id'] as string,
    conversationId: row['conversation_id'] as string,
    seq: row['seq'] as number,
    role: row['role'] as MessageRole,
    content: row['content'] as string,
    status: row['status'] as MessageStatus,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    runId: (row['run_id'] as string | null) ?? null,
    engine: (row['engine'] as string | null) ?? null,
    modelName: (row['model_name'] as string | null) ?? null,
    citations: parseJson<MessageCitation[]>(row['citations_json'], []),
    meta: parseJson<Record<string, unknown>>(row['meta_json'], {}),
    errorMessage: (row['error_message'] as string | null) ?? null,
  };
}

/** 取首条用户消息的开头作为标题；空白时保留默认标题。 */
function titleFromContent(content: string): string | null {
  const line = content.trim().split('\n')[0]?.trim() ?? '';
  if (line.length === 0) return null;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

function preview(text: string | null): string | null {
  if (text === null) return null;
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

/**
 * 对话与消息存储（三周任务单 D2，迁移 26）。
 *
 * messages 是对话的权威记录：界面渲染、重启后续聊、派生 ask_session 来源
 * 都以它为准。引擎侧的会话是进程内的，重启后 engineSessionId 必须清空
 * （见 clearEngineSessions），否则会拿着一个早就不存在的会话 id 去续问。
 */
export class ConversationStore {
  constructor(private readonly db: CoreDatabase) {}

  create(input: { title?: string; projectId?: string | null } = {}): Conversation {
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = input.title?.trim() || DEFAULT_TITLE;
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, input.projectId ?? null, now, now);
    return this.get(id);
  }

  get(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `对话不存在: ${id}`);
    return toConversation(row);
  }

  /** 列表按最近活动排序；默认不含已归档。 */
  list(opts: { includeArchived?: boolean; limit?: number } = {}): ConversationSummary[] {
    const limit = opts.limit ?? 100;
    const where = opts.includeArchived === true ? '' : 'WHERE c.archived_at IS NULL';
    const rows = this.db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at,
                (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                  ORDER BY m.seq DESC LIMIT 1) AS last_message
         FROM conversations c
         ${where}
         ORDER BY c.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...toConversation(row),
      messageCount: row['message_count'] as number,
      lastMessageAt: (row['last_message_at'] as string | null) ?? null,
      lastMessagePreview: preview((row['last_message'] as string | null) ?? null),
    }));
  }

  rename(id: string, title: string): Conversation {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '对话标题不能为空');
    }
    this.get(id);
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, new Date().toISOString(), id);
    return this.get(id);
  }

  archive(id: string): Conversation {
    this.get(id);
    this.db
      .prepare('UPDATE conversations SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  unarchive(id: string): Conversation {
    this.get(id);
    this.db.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?').run(id);
    return this.get(id);
  }

  /** 删除对话；消息随外键级联删除。派生的 ask_session 来源不删（原文只增不改）。 */
  delete(id: string): void {
    this.get(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  // ---- 消息 ----

  /**
   * 追加一条消息。seq 在事务内取 MAX+1，配合 UNIQUE(conversation_id, seq)
   * 保证并发追加不会错位或重号。首条用户消息顺带把默认标题换成问题开头。
   */
  appendMessage(
    conversationId: string,
    input: {
      role: MessageRole;
      content: string;
      status?: MessageStatus;
      runId?: string | null;
      engine?: string | null;
      modelName?: string | null;
      citations?: MessageCitation[];
      meta?: Record<string, unknown>;
      errorMessage?: string | null;
    },
  ): Message {
    const conversation = this.get(conversationId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const insert = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { max_seq: number };
      this.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, seq, role, content, status, created_at, updated_at,
              run_id, engine, model_name, citations_json, meta_json, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          conversationId,
          row.max_seq + 1,
          input.role,
          input.content,
          input.status ?? 'complete',
          now,
          now,
          input.runId ?? null,
          input.engine ?? null,
          input.modelName ?? null,
          JSON.stringify(input.citations ?? []),
          JSON.stringify(input.meta ?? {}),
          input.errorMessage ?? null,
        );
      const nextTitle =
        conversation.title === DEFAULT_TITLE && input.role === 'user'
          ? titleFromContent(input.content)
          : null;
      if (nextTitle !== null) {
        this.db
          .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
          .run(nextTitle, now, conversationId);
      } else {
        this.db
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(now, conversationId);
      }
    });
    insert();
    return this.getMessage(id);
  }

  getMessage(id: string): Message {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `消息不存在: ${id}`);
    return toMessage(row);
  }

  messages(conversationId: string): Message[] {
    this.get(conversationId);
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  /**
   * 取最近若干轮用于喂给引擎（D3/D4）。一轮 = 一问一答，按消息条数取
   * maxTurns * 2 后按时间正序返回。只取已完成的消息：流式中、失败和已取消
   * 的半截内容不作为下一轮的背景。
   */
  recentTurns(conversationId: string, maxTurns = 8): Message[] {
    this.get(conversationId);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND status = 'complete' AND content != ''
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, Math.max(1, maxTurns) * 2) as Array<Record<string, unknown>>;
    return rows.map(toMessage).reverse();
  }

  /**
   * 流式追加正文（S1/S2）。只动 content 与 updated_at。
   * 已是终态的消息不再接收迟到分片（取消后引擎可能还在吐字）：静默丢弃，
   * 既不写入也不报错打断界面。
   */
  appendContent(messageId: string, chunk: string): void {
    if (chunk.length === 0) return;
    this.db
      .prepare(
        `UPDATE messages SET content = content || ?, updated_at = ?
         WHERE id = ? AND status = 'streaming'`,
      )
      .run(chunk, new Date().toISOString(), messageId);
  }

  /** 收尾一条消息：设置终态与本轮元数据。 */
  finishMessage(
    messageId: string,
    patch: {
      status: Exclude<MessageStatus, 'streaming'>;
      content?: string;
      runId?: string | null;
      engine?: string | null;
      modelName?: string | null;
      citations?: MessageCitation[];
      meta?: Record<string, unknown>;
      errorMessage?: string | null;
    },
  ): Message {
    const current = this.getMessage(messageId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE messages SET status = ?, content = ?, updated_at = ?,
                run_id = ?, engine = ?, model_name = ?,
                citations_json = ?, meta_json = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.content ?? current.content,
        now,
        patch.runId !== undefined ? patch.runId : current.runId,
        patch.engine !== undefined ? patch.engine : current.engine,
        patch.modelName !== undefined ? patch.modelName : current.modelName,
        JSON.stringify(patch.citations ?? current.citations),
        JSON.stringify(patch.meta ?? current.meta),
        patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage,
        messageId,
      );
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now, current.conversationId);
    return this.getMessage(messageId);
  }

  // ---- 引擎会话与派生来源 ----

  setEngineSession(conversationId: string, engine: string | null, sessionId: string | null): void {
    this.get(conversationId);
    this.db
      .prepare('UPDATE conversations SET engine = ?, engine_session_id = ? WHERE id = ?')
      .run(engine, sessionId, conversationId);
  }

  /**
   * 启动时清空全部引擎会话 id。引擎会话活在引擎进程里，应用重启后那些
   * session_id 已经不存在；留着会导致「续一个不存在的会话」。
   */
  clearEngineSessions(): number {
    const result = this.db
      .prepare(
        'UPDATE conversations SET engine_session_id = NULL WHERE engine_session_id IS NOT NULL',
      )
      .run();
    return result.changes;
  }

  /**
   * 启动时把上次运行遗留的 streaming 消息收尾为 failed。
   * 回答开始前会先建一条 streaming 占位；应用在回答途中退出（崩溃、强关、
   * 断电）时它会停在 streaming。新进程里不可能有回答正在进行，留着就是一个
   * 永远在转圈的空气泡，而且会让人以为还在等。
   */
  failInterruptedMessages(reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE messages SET status = 'failed', error_message = ?, updated_at = ?
         WHERE status = 'streaming'`,
      )
      .run(reason, new Date().toISOString());
    return result.changes;
  }

  setSourceId(conversationId: string, sourceId: string | null): void {
    this.get(conversationId);
    this.db
      .prepare('UPDATE conversations SET source_id = ? WHERE id = ?')
      .run(sourceId, conversationId);
  }
}
