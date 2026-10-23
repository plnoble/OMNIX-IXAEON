/** 同一时间只许一个调度器（第 10 条）：数据目录里的锁文件写进程号。 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lockFile = (dataDir: string) => join(dataDir, 'lock.json');
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // 整合方改：别的用户的进程会报 EPERM——它活着
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** L10 契约第 2 条：`once --under <pid>` 要判断那个进程还在不在（同一个判断照锁文件的用法）。 */
export const pidAlive = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && alive(pid);
export interface LockInfo {
  pid: number;
  startedAt: string;
}

export function readLock(dataDir: string): LockInfo | null {
  try {
    const j = JSON.parse(readFileSync(lockFile(dataDir), 'utf8')) as LockInfo;
    return typeof j.pid === 'number' ? j : null;
  } catch {
    return null;
  }
}

/** 进程号还在 → 拒绝；不在了（或者根本没锁）→ 自己写上锁，放行。 */
export function acquireLock(dataDir: string): { ok: true } | { ok: false; reason: string } {
  const held = readLock(dataDir);
  if (held && alive(held.pid)) {
    return { ok: false, reason: `已经有调度器在转（进程号 ${held.pid}，从 ${held.startedAt} 起）` };
  }
  mkdirSync(dataDir, { recursive: true });
  const lock = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(lockFile(dataDir), `${JSON.stringify(lock)}\n`, 'utf8');
  return { ok: true };
}

export function releaseLock(dataDir: string): void {
  rmSync(lockFile(dataDir), { force: true });
}
