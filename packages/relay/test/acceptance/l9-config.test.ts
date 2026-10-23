/**
 * L9 验收测试（五）：配置（规格条件 6，对应契约第 2 条）。
 *
 * 逐条对应：
 * - `config.example.json` 里 `planPerDay` 是 `2`；
 * - `relay init` 生成的配置里 `planPerDay` 是 `2`；
 * - `checkConfig`：`planPerDay` 是 `-1`、`1.5`、`"2"` → 不过（不是非负整数）；
 * - 没这个字段、`0`、`2` → 放行（0 只是关掉规划，不是配置错误）。
 *
 * 全用临时目录（`IXAEON_RELAY_DIR` / `IXAEON_WORKTREES` / `APPDATA`），不碰用户本机的数据目录。
 * `relay init` 会在真仓库里加一个工作目录（建在临时目录下）：收尾一定 `git worktree remove` + `prune`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig } from '../../src/index.js';
import type { RelayConfig } from '../../src/index.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const treeRoots: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** 收尾：先把临时目录里建出来的工作目录从真仓库摘掉，再删临时目录（顺序不能反）。 */
afterEach(() => {
  for (const root of treeRoots.splice(0)) {
    spawnSync('git', ['worktree', 'remove', '--force', join(root, 'relay-int')], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const goodRole = (cwd: string) => ({
  argv: [process.execPath, '-e', 'process.exit(0)'],
  cwd,
  timeoutMinutes: 60,
  quotaPatterns: [] as string[],
  quotaPauseMinutes: 10,
});

const configWith = (cwd: string, planPerDay: unknown): RelayConfig => {
  const config = {
    roles: { integrator: goodRole(cwd), developer: goodRole(cwd) },
    idleSeconds: 60,
  };
  if (planPerDay !== undefined) (config as Record<string, unknown>).planPerDay = planPerDay;
  return config as RelayConfig;
};

const readConfig = (relayDir: string) =>
  JSON.parse(readFileSync(join(relayDir, 'config.json'), 'utf8')) as RelayConfig & {
    planPerDay?: unknown;
  };

describe('条件 6：配置里的 planPerDay', () => {
  it('config.example.json 里是 2', () => {
    const example = JSON.parse(
      readFileSync(join(REPO, 'packages', 'relay', 'config.example.json'), 'utf8'),
    ) as { planPerDay?: unknown };
    expect(example.planPerDay).toBe(2);
  });

  it('relay init 生成的配置里是 2', () => {
    const trees = mkTmp('ixa-l9-trees-');
    treeRoots.push(trees);
    const relayDir = mkTmp('ixa-l9-relay-');
    const appdata = mkTmp('ixa-l9-appdata-');
    const claudeExe = join(
      appdata,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    mkdirSync(dirname(claudeExe), { recursive: true });
    writeFileSync(claudeExe, 'stub\n', 'utf8');

    const env: Record<string, string | undefined> = { ...process.env };
    env.IXAEON_RELAY_DIR = relayDir;
    env.IXAEON_WORKTREES = trees;
    env.APPDATA = appdata;
    const r = spawnSync(process.execPath, [CLI, 'init'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env,
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(existsSync(join(relayDir, 'config.json'))).toBe(true);
    expect(readConfig(relayDir).planPerDay).toBe(2);
  }, 120_000);
});

describe('条件 6：checkConfig 怎么认 planPerDay', () => {
  it('-1、1.5、"2" → 不过', () => {
    const cwd = mkTmp('ixa-l9-cfg-');
    for (const bad of [-1, 1.5, '2']) {
      const r = checkConfig(configWith(cwd, bad));
      expect(r.ok, `planPerDay=${JSON.stringify(bad)} 应当被拒绝`).toBe(false);
    }
  });

  it('没这个字段、0、2 → 放行', () => {
    const cwd = mkTmp('ixa-l9-cfg-');
    for (const good of [undefined, 0, 2]) {
      const r = checkConfig(configWith(cwd, good));
      expect(r.ok, `planPerDay=${String(good)} 应当放行`).toBe(true);
    }
  });
});
