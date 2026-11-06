/** T1：整台机器一把 verify 锁的类型声明（实现见 verify-lock.mjs）。 */
export interface VerifyLockHolder {
  pid: number;
  startedAt: string;
}

export function acquireVerifyLock(opts?: {
  path?: string;
  wait?: boolean;
  pollMs?: number;
  maxWaitMs?: number;
  log?: (line: string) => void;
}): Promise<{ release: () => void } | { busy: true; holder: VerifyLockHolder | null }>;
