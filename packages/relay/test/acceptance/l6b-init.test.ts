/**
 * L6b 验收测试（三）：`relay init` 给开发建它自己的仓库（规格条件 5，契约第 4 条）。
 *
 * 逐条对应：开发的 `cwd` 是 `<IXAEON_WORKTREES>/dsh`；`<IXAEON_WORKTREES>/dsh/repo` 是一个 git 仓库、`.git` 在它里面
 * （`--git-common-dir` 在它下面）、`origin` 地址和本仓库的一样；第二次跑（配置已经在）不动配置。
 *
 * 整合方写（2026-10-23）。全用临时目录（IXAEON_RELAY_DIR / IXAEON_WORKTREES / APPDATA），不碰用户本机的数据目录。
 * `relay init` 会在真仓库里加一个工作目录（relay-int，L5）、本地克隆一份本仓库（dsh/repo，克隆、不是工作目录）：
 * 收尾先 `git worktree remove --force` + `prune`，再删临时目录。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const trees: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const t of trees.splice(0)) {
    spawnSync('git', ['worktree', 'remove', '--force', join(t, 'relay-int')], {
      cwd: REPO,
      windowsHide: true,
    });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO, windowsHide: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) =>
  (spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout ?? '').trim();
const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const sameUrl = (a: string) =>
  a
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();

const runInit = (relayDir: string, worktrees: string, appdata: string) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k];
  env.IXAEON_RELAY_DIR = relayDir;
  env.IXAEON_WORKTREES = worktrees;
  env.APPDATA = appdata;
  return spawnSync(process.execPath, [CLI, 'init'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    env,
  });
};
const fakeClaude = (appdata: string) => {
  const p = join(
    appdata,
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'stub\n', 'utf8');
};

describe('条件 5：relay init 给开发建它自己的仓库', () => {
  it('开发 cwd 是 <工作目录根>/dsh；dsh/repo 是独立的 git 仓库、origin 和本仓库的一样；第二次不动配置', () => {
    const worktrees = mkTmp('ixa-l6b-trees-');
    trees.push(worktrees);
    const relayDir = mkTmp('ixa-l6b-relay-');
    const appdata = mkTmp('ixa-l6b-appdata-');
    fakeClaude(appdata);

    const r = runInit(relayDir, worktrees, appdata);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const file = join(relayDir, 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as {
      roles: { developer: { cwd: string; pushByRelay?: boolean } };
    };
    const dshRoot = join(worktrees, 'dsh');
    expect(norm(config.roles.developer.cwd)).toBe(norm(dshRoot));
    expect(config.roles.developer.pushByRelay).toBe(true);

    const repo = join(dshRoot, 'repo');
    expect(existsSync(repo)).toBe(true);
    // .git 在它自己里面：--git-common-dir 在 repo 下面（不是本仓库的那个）
    const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    expect(common).not.toBe('');
    expect(norm(common).startsWith(norm(repo))).toBe(true);
    const mine = git(REPO, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    expect(norm(common)).not.toBe(norm(mine));
    // origin 和本仓库的一样
    expect(sameUrl(git(repo, ['remote', 'get-url', 'origin']))).toBe(
      sameUrl(git(REPO, ['remote', 'get-url', 'origin'])),
    );

    // 第二次跑：配置已经在 → 不动
    const before = readFileSync(file);
    const r2 = runInit(relayDir, worktrees, appdata);
    expect(r2.status, r2.stderr || r2.stdout).toBe(0);
    expect(r2.stdout).toContain('已经有配置了，没改');
    expect(readFileSync(file)).toEqual(before);
  }, 300_000);
});
