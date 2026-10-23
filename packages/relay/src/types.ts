/** L1 接力调度器核心：类型（规格契约第 3、4、5、8 条），L2 又加了用量与拉不下来。 */
export type Role = 'integrator' | 'developer';
export type TurnKind =
  | 'integrator-review'
  | 'developer-claim'
  | 'developer-continue'
  /** L9 契约第 1 条：没活时派给整合方的规划棒。 */
  | 'integrator-plan';
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
  /** L6 契约第 2 条：这一棒跑完之后，调度器替它推它写出来的那些分支（开发用）。 */
  pushByRelay?: boolean;
}

/** L6 契约第 4 条：一条替推记录（写进记账的 `pushes`）。 */
export interface PushRecord {
  dir: string;
  local: string;
  remote: string;
  ok: boolean;
}
export interface RelayConfig {
  roles: Record<Role, RoleConfig>;
  idleSeconds: number;
  localUserCheck?: string[];
  /** L9 契约第 2 条：每个北京日最多派几棒规划；没有或 <= 0 就不规划。 */
  planPerDay?: number;
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
  | 'plan-changed-rows';
