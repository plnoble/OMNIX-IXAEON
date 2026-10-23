/**
 * L6b 验收测试（一）：启动器给 DSH 设 IXAEON_WORKTREES（规格 docs/委派/L6b-DSH自己的仓库.md 条件 1，契约第 1 条）。
 *
 * 逐条对应：
 * - 环境里没有 `IXAEON_WORKTREES` → 起 DSH 时它等于启动器起它时的当前目录（调度器起开发时的 cwd）；
 * - 原来设了 `X` → 还是 `X`。
 *
 * 整合方写（2026-10-23）。不起真的 DSH：照 L4–L6 的假安装目录 + 替身，替身把收到的环境和当前目录打出来。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const LAUNCHER = join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs');
let root = '';
let install = '';
let work = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ixa-l6b-launcher-'));
  install = join(root, 'install');
  work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const cli = join(
    install,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  mkdirSync(join(cli, '..'), { recursive: true });
  copyFileSync(process.execPath, join(install, 'DeepSeek Harness.exe'));
  if (process.platform !== 'win32') chmodSync(join(install, 'DeepSeek Harness.exe'), 0o755);
  writeFileSync(
    cli,
    'process.stdout.write(JSON.stringify({ trees: process.env.IXAEON_WORKTREES ?? null, cwd: process.cwd() }));\n',
    'utf8',
  );
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const run = (extra: Record<string, string | undefined>) => {
  const env: Record<string, string | undefined> = { ...process.env, IXAEON_DSH_INSTALL: install };
  delete env.IXAEON_WORKTREES;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [LAUNCHER, '--version'], {
    cwd: work,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });
  return { r, seen: JSON.parse(r.stdout || '{}') as { trees: string | null; cwd: string } };
};
const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

describe('条件 1：启动器设 IXAEON_WORKTREES', () => {
  it('没有设 → 等于启动器起它时的当前目录', () => {
    const { r, seen } = run({});
    expect(r.status, r.stderr).toBe(0);
    expect(seen.trees).not.toBeNull();
    expect(norm(seen.trees!)).toBe(norm(work));
  }, 60_000);

  it('原来设了 → 原样不动', () => {
    const mine = join(root, 'mine');
    const { r, seen } = run({ IXAEON_WORKTREES: mine });
    expect(r.status, r.stderr).toBe(0);
    expect(seen.trees).toBe(mine);
  }, 60_000);
});
