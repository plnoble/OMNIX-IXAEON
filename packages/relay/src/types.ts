/** L1 接力调度器核心：类型（规格契约第 3、4、5、8 条）。 */
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
export interface RelayState {
  stoppedReason?: string | null;
  pausedUntil: Partial<Record<Role, string>>;
  turns: number;
  mainShaAtTurnStart?: string | null;
}
export type Violation =
  'b-tier-merged-by-developer' | 'b-tier-lock-changed-by-developer' | 'local-user';
