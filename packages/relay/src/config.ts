/** 配置检查（第 3 条）：不许「跳过所有权限」的开关；cwd 不许是共用检出目录、也不许不存在；cwd 不许包着数据目录。 */
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { relayDir } from './datadir.js';
import { git } from './git.js';
import type { RelayConfig, Role, RoleConfig } from './types.js';

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
  // L4 契约第 3 条：模型在自己的 cwd 里能写，所以 cwd 不许把调度器的数据目录包在里面（state/config/feishu 都在那儿）。
  const dataDir = relayDir();
  for (const role of ['integrator', 'developer'] as Array<'integrator' | 'developer'>) {
    const rc = config.roles[role];
    const bad = FORBIDDEN_SWITCHES.find((sw) => rc.argv.some((a) => a.includes(sw)));
    if (bad) return { ok: false, reason: `${role} 的命令行里有不允许的开关：${bad}` };
    // L19 契约第 5 条：有这个字段就必须是字符串数组（没有 = 和原来一样）；空数组、空串都是合法值。
    if (
      rc.weeklyQuotaPatterns !== undefined &&
      !(
        Array.isArray(rc.weeklyQuotaPatterns) &&
        rc.weeklyQuotaPatterns.every((p) => typeof p === 'string')
      )
    ) {
      return { ok: false, reason: `${role} 的 weeklyQuotaPatterns 必须是字符串数组` };
    }
    if (!existsSync(rc.cwd)) return { ok: false, reason: `${role}.cwd 不存在：${rc.cwd}` };
    if (isInside(rc.cwd, shared)) return { ok: false, reason: `${role}.cwd 是共用检出：${rc.cwd}` };
    if (isInside(dataDir, rc.cwd)) {
      return {
        ok: false,
        reason: `${role}.cwd 把数据目录包在里面了：${rc.cwd}（数据目录 ${dataDir}）`,
      };
    }
  }
  // L9 契约第 2 条：有这个字段就必须是 0 或正整数（0 只是关掉规划，不是配置错误）。
  const perDay = config.planPerDay;
  if (
    perDay !== undefined &&
    !(typeof perDay === 'number' && Number.isInteger(perDay) && perDay >= 0)
  ) {
    return { ok: false, reason: `planPerDay 必须是 0 或正整数：${JSON.stringify(perDay)}` };
  }
  // K9b 契约第 1 条：替补整合方是可选的；写了就必须是能起的样子（argv 非空字符串数组、有 label）。
  const sub = config.roles.integratorSubstitute;
  if (sub !== undefined) {
    if (
      !Array.isArray(sub.argv) ||
      sub.argv.length === 0 ||
      sub.argv.some((a) => !a || typeof a !== 'string')
    ) {
      return { ok: false, reason: 'integratorSubstitute.argv 必须是非空的字符串数组' };
    }
    if (typeof sub.label !== 'string' || !sub.label.trim()) {
      return { ok: false, reason: 'integratorSubstitute.label 必须是非空字符串' };
    }
    const bad = FORBIDDEN_SWITCHES.find((sw) => sub.argv.some((a) => a.includes(sw)));
    if (bad) return { ok: false, reason: `integratorSubstitute 的命令行里有不允许的开关：${bad}` };
  }
  return { ok: true };
}

/**
 * K9b 契约第 1 条：把可选的 `roles.integratorSubstitute` 变成能起的一棒的角色配置。
 * - 没配、或者写得不对（不是非空字符串数组 / 没有 label）→ `null`，行为和没配一样；
 * - 替补是 DSH 那一类（和开发同一种命令行），所以额度字样、歇多久、超时都照开发那一份；
 * - 工作目录用整合方那个（要在它里面读 main、提交文档；代码只许推 integrate-sub/）；
 * - 推送由调度器替它做（K9b「要什么」第 3 条：推 main 只许改 docs/委派/，代码推 integrate-sub/）。
 */
export function substituteConfig(config: RelayConfig): RoleConfig | null {
  const sub = config.roles.integratorSubstitute;
  if (!sub) return null;
  if (
    !Array.isArray(sub.argv) ||
    sub.argv.length === 0 ||
    sub.argv.some((a) => !a || typeof a !== 'string')
  ) {
    return null;
  }
  if (typeof sub.label !== 'string' || !sub.label.trim()) return null;
  const dev = config.roles.developer;
  return {
    argv: sub.argv,
    cwd: config.roles.integrator.cwd,
    timeoutMinutes: dev.timeoutMinutes,
    quotaPatterns: dev.quotaPatterns,
    quotaPauseMinutes: dev.quotaPauseMinutes,
    ...(dev.weeklyQuotaPatterns ? { weeklyQuotaPatterns: dev.weeklyQuotaPatterns } : {}),
    pushByRelay: true,
    label: sub.label,
  };
}

/** K9b：按角色取这一棒要起的那份配置；替补从 `roles.integratorSubstitute` 现算。 */
export function roleConfigFor(config: RelayConfig, role: Role): RoleConfig {
  if (role === 'integrator-substitute') {
    const sub = substituteConfig(config);
    // 调度器不会在不配替补时派替补；真到了这里就报出来，不静默退回整合方（那会拿错的 argv 起棒）。
    if (!sub) throw new Error('派了替补整合方的棒，但配置里没有可用的 roles.integratorSubstitute');
    return sub;
  }
  return config.roles[role];
}
