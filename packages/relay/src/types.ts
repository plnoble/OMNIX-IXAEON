/** L1 接力调度器核心：类型（规格契约第 3、4、5、8 条），L2 又加了用量与拉不下来。 */
export type Role = 'integrator' | 'developer';
export type TurnKind =
  | 'integrator-review'
  | 'developer-claim'
  | 'developer-continue'
  /** L9 契约第 1 条：没活时派给整合方的规划棒。 */
  | 'integrator-plan'
  /** L16 契约第 6 条：用户在飞书里回了话，先派给整合方的飞书回复棒。 */
  | 'integrator-inbox';
export interface Turn {
  role: Role;
  kind: TurnKind;
  taskId: string;
  task: string;
  status: string;
}
export type Idle = { idle: 'stopped' | 'queue-empty' | 'all-blocked' | 'all-paused' };
export interface RoleConfig {
  argv: string[];
  cwd: string;
  timeoutMinutes: number;
  quotaPatterns: string[];
  quotaPauseMinutes: number;
  /**
   * L19 契约第 1 条：周额度的字样。有任意一条对上 → 歇到下一个北京时间周四 04:00
   * （`nextWeeklyReset`），不再按 `quotaPauseMinutes` 算。没这个字段或空数组 → 和原来一样。
   */
  weeklyQuotaPatterns?: string[];
  /** L6 契约第 2 条：这一棒跑完之后，调度器替它推它写出来的那些分支（开发用）。 */
  pushByRelay?: boolean;
}

/** L6 契约第 4 条：一条替推记录（写进记账的 `pushes`）。 */
export interface PushRecord {
  dir: string;
  local: string;
  remote: string;
  ok: boolean;
  /** L13：推 main 被拒后先 rebase 到最新 origin/main 再推，rebase 成功的这一条写 true（别的没有这个字段）。 */
  rebased?: boolean;
}
export interface RelayConfig {
  roles: Record<Role, RoleConfig>;
  idleSeconds: number;
  localUserCheck?: string[];
  /** L9 契约第 2 条：每个北京日最多派几棒规划；没有或 <= 0 就不规划。 */
  planPerDay?: number;
  /** L15 契约第 5 条：早上 9 点之后发一份早报；没有或 `false` 就不发。 */
  morningReport?: boolean;
}
/** 一棒的用量（L1 第 7 条）：Claude 的 total_cost_usd、Codex 那种 usage 的 token 数。 */
export interface Usage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}
export interface RelayState {
  stoppedReason?: string | null;
  pausedUntil: Partial<Record<Role, string>>;
  turns: number;
  mainShaAtTurnStart?: string | null;
  /** L2b：飞书限频记录（键 → 上次发出去的 ISO 时间），随 state.json 保存。 */
  notify?: { sent: Record<string, string> };
  /** L2b：最近一次发日报的日期，写 `10月21日` 这种。 */
  lastDailyDate?: string;
  /** L9 契约第 3 条：最近一次派规划棒的日子、当天次数、那时队列全文的 sha256。 */
  plan?: { date: string; count: number; queueHash: string };
  /** L16 契约第 6 条：已经交给整合方办过的 inbox 消息 id，只留最近 200 个。 */
  inboxDone?: string[];
  /** L15 契约第 2 条：两种「没活」各自最近一次发出去的北京日子（`10月23日`）。 */
  idleDay?: Partial<Record<'queue-empty' | 'all-blocked', string>>;
  /** L15 契约第 5 条：最近一次发早报的北京日子。 */
  lastMorningDate?: string;
}
export type Violation =
  | 'b-tier-merged-by-developer'
  | 'b-tier-lock-changed-by-developer'
  | 'local-user'
  /** L2：核对时拉不下来 origin/main，这一棒没法核对。 */
  | 'verify-fetch-failed'
  /** L9 契约第 6 条：规划棒改了 `docs/` 以外的文件。 */
  | 'plan-touched-code'
  /** L9 契约第 6 条：规划棒动了主表里已有的行、加超 3 行、或新行状态不对。 */
  | 'plan-changed-rows'
  /** L16 契约第 6 条：飞书回复棒改了 `docs/` 以外的文件。 */
  | 'inbox-touched-code';
