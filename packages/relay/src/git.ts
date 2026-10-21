import { spawnSync } from 'node:child_process';
/** 只读地跑一条 git（调度器不改仓库：不 checkout、不 pull）。 */
export function git(cwd: string, args: string[], timeout = 120_000): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim() };
}
