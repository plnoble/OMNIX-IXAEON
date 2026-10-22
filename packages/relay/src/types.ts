/** L1 接力调度器核心：类型（规格契约第 3、4、5、8 条），L2 又加了用量与拉不下来。 */
export type Role = 'integrator' | 'developer';
export type TurnKind = 'integrator-review' | 'developer-claim' | 'developer-continue';
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
}
export interface RelayConfig {
  roles: Record<Role, RoleConfig>;
  idleSeconds: number;
  localUserCheck?: string[];
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
}
export type Violation =
  | 'b-tier-merged-by-developer'
  | 'b-tier-lock-changed-by-developer'
  | 'local-user'
  /** L2：核对时拉不下来 origin/main，这一棒没法核对。 */
  | 'verify-fetch-failed';
