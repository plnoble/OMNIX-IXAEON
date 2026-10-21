/**
 * L1 验收测试（五）：配置检查（规格条件 10，对应规格第 3 条）。
 *
 * 逐条对应：
 * - 条件 10：argv 里有任何「跳过所有权限」的开关 → 拒绝启动；cwd 是共用检出目录 → 拒绝；cwd 不存在 → 拒绝。
 *
 * 2026-10-21 整合方从开发写的 l1-config-and-lock.test.ts 里拆出来（拆法见规格：配置检查归 L1，
 * 锁和命令归 L1b），并补了：两个角色都查、开关写在别的参数里面也认、共用检出目录的子目录和
 * 换了写法的路径也拒、findSharedCheckout 找的确实是 git 认的主检出。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, findSharedCheckout, type RelayConfig } from '../../src/index.js';

const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l1-cfg-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const goodRole = (cwd: string) => ({
  argv: [process.execPath, '-e', 'process.exit(0)'],
  cwd,
  timeoutMinutes: 60,
  quotaPatterns: [],
  quotaPauseMinutes: 10,
});

const SWITCHES = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
  '--full-auto',
  'bypassPermissions',
];

describe('条件 10：配置检查', () => {
  it('argv 里带任何一个「跳过所有权限」的开关都拒绝启动，并说清是哪一个', () => {
    const cwd = mkTmp();
    for (const sw of SWITCHES) {
      const config: RelayConfig = {
        roles: {
          integrator: goodRole(cwd),
          developer: { ...goodRole(cwd), argv: [process.execPath, sw] },
        },
        idleSeconds: 60,
      };
      const r = checkConfig(config);
      expect(r.ok, `${sw} 应当被拒绝`).toBe(false);
      if (!r.ok) expect(r.reason).toContain(sw);
    }
  });

  it('整合方的命令行带了也拒绝（两个角色都查）', () => {
    const cwd = mkTmp();
    for (const sw of SWITCHES) {
      const config: RelayConfig = {
        roles: {
          integrator: { ...goodRole(cwd), argv: ['claude', '-p', '{prompt_file}', sw] },
          developer: goodRole(cwd),
        },
        idleSeconds: 60,
      };
      const r = checkConfig(config);
      expect(r.ok, `整合方带 ${sw} 应当被拒绝`).toBe(false);
      if (!r.ok) expect(r.reason).toContain(sw);
    }
  });

  it('开关写在别的参数里面（--permission-mode=…、-c sandbox_mode="…"）也认得出来', () => {
    const cwd = mkTmp();
    const cases: Array<[string[], string]> = [
      [
        ['claude', '--permission-mode=bypassPermissions', '-p', '{prompt_file}'],
        'bypassPermissions',
      ],
      [
        ['codex', '-c', 'sandbox_mode="danger-full-access"', 'exec', '{prompt_file}'],
        'danger-full-access',
      ],
      [['codex', 'exec', '--full-auto', '{prompt_file}'], '--full-auto'],
    ];
    for (const [argv, sw] of cases) {
      const r = checkConfig({
        roles: { integrator: goodRole(cwd), developer: { ...goodRole(cwd), argv } },
        idleSeconds: 60,
      });
      expect(r.ok, `${argv.join(' ')} 应当被拒绝`).toBe(false);
      if (!r.ok) expect(r.reason).toContain(sw);
    }
  });

  it('findSharedCheckout 找的就是 git 认的主检出（git worktree list 的第一条）', () => {
    const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    });
    const first = /^worktree (.+)$/m.exec(r.stdout ?? '')?.[1]?.trim();
    expect(first, 'git worktree list 没给出主检出').toBeTruthy();
    const norm = (p: string) =>
      process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
    expect(norm(findSharedCheckout())).toBe(norm(first!));
  });

  it('cwd 是共用检出目录 → 拒绝（子目录、末尾带分隔符也一样）', () => {
    const shared = findSharedCheckout();
    const variants = [shared, join(shared, 'docs'), `${shared}${sep}`];
    if (process.platform === 'win32') variants.push(shared.toUpperCase());
    for (const v of variants) {
      const config: RelayConfig = {
        roles: { integrator: goodRole(mkTmp()), developer: goodRole(v) },
        idleSeconds: 60,
      };
      const r = checkConfig(config);
      expect(r.ok, `${v} 应当被拒绝`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/共用|检出|主检出/);
    }
  });

  it('cwd 不存在 → 拒绝；都合规 → 放行', () => {
    const cwd = mkTmp();
    const bad: RelayConfig = {
      roles: {
        integrator: goodRole(join(cwd, '不存在的目录')),
        developer: goodRole(cwd),
      },
      idleSeconds: 60,
    };
    expect(checkConfig(bad).ok).toBe(false);
    const badDev: RelayConfig = {
      roles: { integrator: goodRole(cwd), developer: goodRole(join(cwd, '也不存在')) },
      idleSeconds: 60,
    };
    expect(checkConfig(badDev).ok).toBe(false);

    const good: RelayConfig = {
      roles: { integrator: goodRole(cwd), developer: goodRole(cwd) },
      idleSeconds: 60,
    };
    expect(checkConfig(good)).toEqual({ ok: true });
  });
});
