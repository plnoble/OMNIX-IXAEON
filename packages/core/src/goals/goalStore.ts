import { randomUUID } from 'node:crypto';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type {
  CreateGoalInput,
  Goal,
  GoalConfirmation,
  GoalDecidedBy,
  GoalEventKind,
  GoalStatus,
} from './types.js';

const ALLOWED: Record<GoalStatus, readonly GoalStatus[]> = {
  proposed: ['abandoned'],
  active: ['paused', 'blocked', 'completed', 'abandoned'],
  paused: ['active', 'completed', 'abandoned'],
  blocked: ['active', 'completed', 'abandoned'],
  completed: [],
  abandoned: [],
};
function invalid(message: string): never {
  throw new IxaError(ErrorCodes.VALIDATION_FAILED, message);
}

/** G1a 内部存储：via/confirm 只供已鉴权的用户动作调用，不是模型可自报的授权凭据。
 * 无自动迁移；整合方安装表结构后启用。G1b 的跟踪与进度计算不在本单内。
 */
export class GoalStore {
  constructor(private readonly db: CoreDatabase) {}

  create(input: CreateGoalInput): Goal {
    return this.db.transaction(() => {
      const origin = input.origin ?? 'user';
      const via = input.via ?? 'pending';
      if (!['user', 'agent'].includes(origin) || !['pending', 'ui', 'api'].includes(via))
        invalid('目标来源或确认方式无效');
      if (!input.title.trim() || input.title.length > 200) invalid('目标标题须为 1..200 字');
      if (
        input.parentWeight != null &&
        (!Number.isFinite(input.parentWeight) || input.parentWeight <= 0)
      )
        invalid('parent_weight 必须大于 0');
      if (input.parentGoalId) this.requireGoal(input.parentGoalId);
      const id = randomUUID();
      const now = new Date().toISOString();
      const status = via === 'pending' ? 'proposed' : 'active';
      this.db
        .prepare(
          `INSERT INTO goals (id, title, description, origin, origin_conversation_id,
        confirmation, confirmed_at, project_id, status, priority, created_at, updated_at, target_date,
        confidence, parent_goal_id, parent_weight, progress_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title.trim(),
          input.description ?? '',
          origin,
          input.fromConversationId ?? null,
          via,
          via === 'pending' ? null : now,
          input.projectId ?? null,
          status,
          input.priority ?? 0,
          now,
          now,
          input.targetDate ?? null,
          input.confidence ?? null,
          input.parentGoalId ?? null,
          input.parentWeight ?? (input.parentGoalId ? 1 : null),
          input.progressMode ?? 'manual',
        );
      this.event(id, 'created', via === 'pending' ? origin : 'user', {
        origin,
        confirmation: via,
        status,
      });
      return this.requireGoal(id);
    })();
  }

  get(id: string): Goal | undefined {
    return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal | undefined;
  }

  childrenOf(parentId: string): Goal[] {
    return this.db
      .prepare('SELECT * FROM goals WHERE parent_goal_id = ? ORDER BY created_at, id')
      .all(parentId) as Goal[];
  }

  list(filter: { status?: GoalStatus } = {}): Goal[] {
    return (
      filter.status
        ? this.db
            .prepare(
              'SELECT * FROM goals WHERE status = ? ORDER BY priority DESC, updated_at DESC, id',
            )
            .all(filter.status)
        : this.db.prepare('SELECT * FROM goals ORDER BY priority DESC, updated_at DESC, id').all()
    ) as Goal[];
  }

  /** 用户明确确认；聊天必须引用真实、已完成的用户消息，不能把 AI 消息当拍板。 */
  confirm(id: string, input: { how: GoalConfirmation; messageId?: string | null }): Goal {
    return this.db.transaction(() => {
      const goal = this.requireGoal(id);
      if (goal.status !== 'proposed')
        throw new IxaError(ErrorCodes.CONFLICT, '只有待确认目标可以确认');
      if (!['ui', 'chat', 'api'].includes(input.how)) invalid('确认方式必须是 ui/chat/api');
      const messageId = input.how === 'chat' ? input.messageId : null;
      if (input.how === 'chat') {
        if (!messageId) invalid('聊天确认要带消息号');
        const message = this.db
          .prepare('SELECT role, status, conversation_id FROM messages WHERE id = ?')
          .get(messageId) as { role: string; status: string; conversation_id: string } | undefined;
        if (!message || message.role !== 'user' || message.status !== 'complete')
          invalid('确认必须引用已完成的用户消息');
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE goals SET confirmation = ?, confirmed_by_message_id = ?, confirmed_at = ?,
        status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(input.how, messageId ?? null, now, now, id);
      this.event(id, 'confirmed', 'user', { how: input.how, messageId: messageId ?? null });
      return this.requireGoal(id);
    })();
  }

  transition(
    id: string,
    to: GoalStatus,
    opts: { decidedBy: GoalDecidedBy; reason?: string | null },
  ): Goal {
    return this.db.transaction(() => {
      const goal = this.requireGoal(id);
      if (!ALLOWED[goal.status].includes(to))
        throw new IxaError(ErrorCodes.CONFLICT, `目标不能从 ${goal.status} 改成 ${to}`);
      if (!['user', 'agent'].includes(opts.decidedBy)) invalid('状态迁移必须由用户或模型判断');
      if (goal.status === 'proposed' && opts.decidedBy !== 'user')
        invalid('否决候选目标必须由用户决定');
      const reason = opts.reason?.trim() || null;
      if (to === 'blocked' && !reason) invalid('blocked 必须带理由');
      this.db
        .prepare(
          `UPDATE goals SET status = ?, updated_at = ?, blocked_reason = ?,
        progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END WHERE id = ?`,
        )
        .run(to, new Date().toISOString(), to === 'blocked' ? reason : null, to, id);
      this.event(id, 'status', opts.decidedBy, { from: goal.status, to, reason });
      return this.requireGoal(id);
    })();
  }

  /** 手工存值，不计算 weighted；G1b 另读真实任务状态。 */
  setProgress(id: string, value: number): Goal {
    return this.db.transaction(() => {
      this.requireGoal(id);
      if (!Number.isInteger(value) || value < 0 || value > 100)
        invalid('progress 须为 0..100 的整数');
      this.db
        .prepare('UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?')
        .run(value, new Date().toISOString(), id);
      this.event(id, 'progress', 'user', { value });
      return this.requireGoal(id);
    })();
  }

  private event(
    goalId: string,
    kind: GoalEventKind,
    decidedBy: GoalDecidedBy,
    detail: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO goal_events (id, goal_id, at, kind, decided_by, summary, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        goalId,
        new Date().toISOString(),
        kind,
        decidedBy,
        kind,
        JSON.stringify(detail),
      );
  }

  private requireGoal(id: string): Goal {
    const goal = this.get(id);
    if (!goal) throw new IxaError(ErrorCodes.NOT_FOUND, `目标不存在: ${id}`);
    return goal;
  }
}
