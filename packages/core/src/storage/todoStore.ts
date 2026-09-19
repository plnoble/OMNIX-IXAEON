import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError, type Todo, type TodoStatus, type TodoView } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { recordAudit } from '../audit.js';

/** 标题最长 200 字（与表约束一致）；超出的截断，不因为 AI 写长了就整条丢掉。 */
const MAX_TITLE = 200;

/** 拒绝过的事，AI 再提时相似度达到它就认为是同一件，不再打扰（字符二元组 Jaccard）。 */
const REJECTED_SIMILARITY = 0.6;

export type TodoLink = { kind: 'coding_task' | 'research_topic'; id: string };

/**
 * 待办（三周任务单 T1）。设计决定 3：薄的一层——只存叫什么、什么状态、从哪次对话来，
 * 底下指向已有的编码任务 / 研究主题，不新造任务系统。
 *
 * 状态只进不乱跳：proposed →（接受）accepted →（完成）done；
 * proposed / accepted →（拒绝）rejected。拒绝过的留着，用来认出 AI 重提的同一件事。
 */
export class TodoStore {
  constructor(private readonly db: CoreDatabase) {}

  /**
   * AI 在聊天里提出的待办（等你拍板）。返回 null 表示没有新建：
   * - 同一个底下任务已经有待办 → 返回那一条（同一编码任务不重复出现）；
   * - 还没办完的待办里有同样标题的 → 返回那一条；
   * - 你拒绝过相似的事 → null（拒绝过的不重提）。
   */
  propose(input: {
    title: string;
    conversationId?: string | null;
    messageId?: string | null;
    linked?: TodoLink | null;
  }): Todo | null {
    const title = cleanTitle(input.title);
    if (input.linked) {
      const existing = this.byLink(input.linked);
      if (existing) return existing;
    }
    const open = this.db
      .prepare(`SELECT * FROM todos WHERE status IN ('proposed', 'accepted') AND title = ?`)
      .get(title) as Todo | undefined;
    if (open && !input.linked) return open;
    if (this.rejectedBefore(title)) return null;
    return this.insert({
      title,
      status: 'proposed',
      origin: 'agent',
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      linked: input.linked ?? null,
      audit: 'todo.proposed',
    });
  }

  /** 你自己加的待办：直接算要做（不用再拍板）。 */
  add(input: { title: string; conversationId?: string | null; messageId?: string | null }): Todo {
    return this.insert({
      title: cleanTitle(input.title),
      status: 'accepted',
      origin: 'user',
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      linked: null,
      audit: 'todo.added',
    });
  }

  /** 拍板要做：只有等你拍板的能接受。 */
  accept(id: string): Todo {
    return this.transition(id, ['proposed'], 'accepted', 'todo.accepted');
  }

  /** 不做：等你拍板的、要做的都能拒绝；拒绝过的同一件事 AI 不再提。 */
  reject(id: string): Todo {
    return this.transition(id, ['proposed', 'accepted'], 'rejected', 'todo.rejected');
  }

  /** 做完了：只有要做的能标完成。 */
  complete(id: string): Todo {
    return this.transition(id, ['accepted'], 'done', 'todo.done');
  }

  get(id: string): Todo {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Todo | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `待办不存在: ${id}`);
    return row;
  }

  byLink(link: TodoLink): Todo | null {
    const row = this.db
      .prepare('SELECT * FROM todos WHERE linked_kind = ? AND linked_id = ?')
      .get(link.kind, link.id) as Todo | undefined;
    return row ?? null;
  }

  /**
   * 列表，带底下编码任务的实时状态（以任务表为准，不读消息里的快照——D6 复核发现
   * 批准卡显示的是提问时的快照，批准后重开对话仍显示「批准并排队」）。
   * 排序：等你拍板的、要做的在前，各自按最近更新。
   */
  list(filter: { status?: TodoStatus[] } = {}): TodoView[] {
    const statuses = filter.status ?? ['proposed', 'accepted', 'done', 'rejected'];
    const rows = this.db
      .prepare(
        `SELECT t.*, CASE t.linked_kind WHEN 'coding_task' THEN c.status END AS linkedStatus
         FROM todos t
         LEFT JOIN coding_tasks c ON t.linked_kind = 'coding_task' AND c.id = t.linked_id
         WHERE t.status IN (${statuses.map(() => '?').join(', ')})
         ORDER BY CASE t.status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
                  t.updated_at DESC`,
      )
      .all(...statuses) as TodoView[];
    return rows.map((r) => ({ ...r, linkedStatus: r.linkedStatus ?? null }));
  }

  private rejectedBefore(title: string): boolean {
    const target = bigrams(title);
    const rejected = this.db
      .prepare(`SELECT title FROM todos WHERE status = 'rejected'`)
      .all() as Array<{ title: string }>;
    return rejected.some(
      (r) => r.title === title || jaccard(bigrams(r.title), target) >= REJECTED_SIMILARITY,
    );
  }

  private insert(input: {
    title: string;
    status: TodoStatus;
    origin: Todo['origin'];
    conversationId: string | null;
    messageId: string | null;
    linked: TodoLink | null;
    audit: string;
  }): Todo {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO todos (id, title, status, origin, conversation_id, message_id,
           linked_kind, linked_id, created_at, updated_at, decided_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.title,
        input.status,
        input.origin,
        input.conversationId,
        input.messageId,
        input.linked?.kind ?? null,
        input.linked?.id ?? null,
        now,
        now,
        // 你自己加的，加的那一刻就是拍板
        input.status === 'accepted' ? now : null,
      );
    recordAudit(this.db, input.audit, {
      todoId: id,
      origin: input.origin,
      linked: input.linked ? `${input.linked.kind}:${input.linked.id}` : null,
    });
    return this.get(id);
  }

  private transition(id: string, from: TodoStatus[], to: TodoStatus, audit: string): Todo {
    const todo = this.get(id);
    if (!from.includes(todo.status)) {
      throw new IxaError(
        ErrorCodes.CONFLICT,
        `待办现在是「${STATUS_LABEL[todo.status]}」，不能改成「${STATUS_LABEL[to]}」`,
      );
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE todos SET status = ?, updated_at = ?,
           decided_at = CASE WHEN ? IN ('accepted', 'rejected') THEN ? ELSE decided_at END,
           done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END
         WHERE id = ?`,
      )
      .run(to, now, to, now, to, now, id);
    recordAudit(this.db, audit, { todoId: id, from: todo.status });
    return this.get(id);
  }
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  proposed: '等你拍板',
  accepted: '要做',
  done: '已完成',
  rejected: '不做',
};

function cleanTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length === 0) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '待办不能是空的');
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

function bigrams(text: string): Set<string> {
  const s = text.replace(/[\s，。、；：,.;:!?！？]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
