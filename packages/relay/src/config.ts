/** 配置检查（第 3 条）：不许「跳过所有权限」的开关；cwd 不许是共用检出目录、也不许不存在。 */
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { git } from './git.js';
import type { RelayConfig, Role } from './types.js';

/** 规格第 3 条列的一串开关（按子串认，写在别的参数里也算）。 */
export const FORBIDDEN_SWITCHES = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
  '--full-auto',
  'bypassPermissions',
];
const norm = (p: string): string =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

/** 路径在不在某个目录里（Windows 上不分大小写；不用 path.relative——跨盘符会返回绝对路径）。 */
export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** 共用检出目录 = git 认的主检出（`git worktree list` 第一条），不是当前工作目录。 */
export function findSharedCheckout(): string {
  const out = git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  // 整合方改：找不到就返回空，由 checkConfig 拒绝启动（原来退回当前目录，等于没拦）
  return out ? resolve(dirname(out)) : '';
}

export function checkConfig(config: RelayConfig): { ok: true } | { ok: false; reason: string } {
  const shared = findSharedCheckout();
  if (!shared) return { ok: false, reason: '找不到共用检出目录：要在 IXAEON 仓库里启动' };
  for (const role of ['integrator', 'developer'] as Role[]) {
    const rc = config.roles[role];
    const bad = FORBIDDEN_SWITCHES.find((sw) => rc.argv.some((a) => a.includes(sw)));
    if (bad) return { ok: false, reason: `${role} 的命令行里有不允许的开关：${bad}` };
    if (!existsSync(rc.cwd)) return { ok: false, reason: `${role}.cwd 不存在：${rc.cwd}` };
    if (isInside(rc.cwd, shared)) return { ok: false, reason: `${role}.cwd 是共用检出：${rc.cwd}` };
  }
  return { ok: true };
}
