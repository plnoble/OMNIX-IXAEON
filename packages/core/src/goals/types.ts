/**
 * G1（规格草案 docs/委派/G1-GoalEngine-草案.md）：长期目标系统的类型。
 * 行形状照数据库列（snake_case）——测试与界面都按这个读。
 */

export type GoalStatus = 'proposed' | 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';
/** 维度一：谁先提的（不表示是否被确认）。 */
export type GoalOrigin = 'user' | 'agent';
/** 维度二：确认到什么程度；pending = 还没被用户确认。 */
export type GoalConfirmation = 'pending' | 'ui' | 'chat' | 'api';
export type GoalProgressMode = 'manual' | 'weighted';
export type GoalDecidedBy = 'user' | 'agent' | 'system';
export type GoalEventKind =
  | 'created'
  | 'confirmed'
  | 'status'
  | 'progress'
  | 'plan'
  | 'step'
  | 'task_done'
  | 'task_failed'
  | 'watch'
  | 'note';

export interface Goal {
  id: string;
  title: string;
  description: string;
  origin: GoalOrigin;
  origin_conversation_id: string | null;
  confirmation: GoalConfirmation;
  confirmed_by_message_id: string | null;
  confirmed_at: string | null;
  project_id: string | null;
  status: GoalStatus;
  priority: number;
  created_at: string;
  updated_at: string;
  target_date: string | null;
  confidence: number | null;
  parent_goal_id: string | null;
  parent_weight: number | null;
  progress: number;
  progress_mode: GoalProgressMode;
  blocked_reason: string | null;
  /**
   * 以下三列归 **G1b**（用户 2026-10-25 定：G1a 不碰 watch）：
   * 失败信号与复查时间是「目标 ↔ 任务跟踪」这一层的概念，不是 Goal 核心的概念。
   * 建表 SQL 里它们仍在 goals 上（草案 §3.1），由 G1b 的 links.ts 读写。
   */
  next_review_at: string | null;
  watch: number;
  watch_reason: string | null;
}

export interface GoalEvent {
  id: string;
  goal_id: string;
  at: string;
  kind: GoalEventKind;
  decided_by: GoalDecidedBy;
  ref_kind: string | null;
  ref_id: string | null;
  summary: string;
  detail_json: string | null;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  /** 谁先提的；默认 user。 */
  origin?: GoalOrigin;
  /**
   * 怎么确认的；默认 pending（= 还没确认，状态 proposed）。
   * 'ui' / 'api' = 用户明确执行了创建 → 直接 active。
   */
  via?: Exclude<GoalConfirmation, 'chat'>;
  fromConversationId?: string | null;
  projectId?: string | null;
  parentGoalId?: string | null;
  /** 子目标在直接父目标里的权重；默认 1，必须 > 0。根目标是 NULL。 */
  parentWeight?: number | null;
  priority?: number;
  targetDate?: string | null;
  confidence?: number | null;
  progressMode?: GoalProgressMode;
}
