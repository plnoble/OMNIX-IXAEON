/**
 * L10 验收测试（五）：配置里的命令可以写 `{relay_root}`（规格条件 6，对应契约第 5 条）。
 *
 * 逐条对应：
 * - 替身把自己收到的参数写下来，配置里写 `{relay_root}/x` → 收到的是 `<IXAEON_RELAY_CODE 那个目录>/x`；
 * - `relay init` 生成的开发命令第二项是 `{relay_root}/packages/relay/bin/dsh.mjs`。
 *
 * 不调真模型、不连 GitHub；`relay init` 全在临时目录里，收尾摘掉它建的 relay-int。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, REPO, type World } from './l10-harness.js';

const dirs: string[] = [];
const trees: string[] = [];
const worlds: World[] = [];
const tmp = (prefix: string): string => {
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
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('条件 6：{relay_root}', () => {
  it('配置里写 {relay_root}/x → 替身收到的是 <IXAEON_RELAY_CODE>/x', async () => {
    const dump = join(tmp('ixa-l10-argv-'), 'argv.json');
    const w = makeWorld({ devExtraArgs: ['--dump-argv', dump, '{relay_root}/x'] });
    worlds.push(w);

    const r = await w.run(['once'], { IXAEON_RELAY_CODE: REPO });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const seen = JSON.parse(readFileSync(dump, 'utf8')) as string[];
    expect(seen).toContain(`${REPO}/x`);
    expect(w.ledger()).toHaveLength(1);
  }, 120_000);

  it('relay init 生成的开发命令第二项是 {relay_root}/packages/relay/bin/dsh.mjs', () => {
    const worktrees = tmp('ixa-l10-trees-');
    trees.push(worktrees);
    const relayDir = tmp('ixa-l10-relay-');
    const appdata = tmp('ixa-l10-appdata-');
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
    for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k];
    env.IXAEON_RELAY_DIR = relayDir;
    env.IXAEON_WORKTREES = worktrees;
    env.APPDATA = appdata;
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'packages', 'relay', 'bin', 'relay.mjs'), 'init'],
      {
        cwd: REPO,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300_000,
        env,
      },
    );
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const file = join(relayDir, 'config.json');
    expect(existsSync(file)).toBe(true);
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as {
      roles: { developer: { argv: string[]; cwd: string } };
    };
    expect(cfg.roles.developer.argv[1]).toBe('{relay_root}/packages/relay/bin/dsh.mjs');
  }, 300_000);
});
