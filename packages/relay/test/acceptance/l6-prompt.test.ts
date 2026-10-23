/**
 * L6 验收测试（三）：交代里加那一段、`relay init` 写出 `pushByRelay`（规格条件 2，对应契约第 3 条）。
 *
 * 逐条对应：
 * - `pushByRelay` 为真的角色 → 交代里有契约第 3 条那段原文（替身把收到的交代原样抄出来核对，
 *   不依赖 `buildTurnPrompt` 的签名——传这个标记的方式由实现定）；
 * - 不为真的角色 → 交代里没有那一段；
 * - `relay init` 写出的开发角色 `pushByRelay` 是 `true`。
 *
 * 交代那一段按三句核对（免得被 markdown 的反引号影响），RELAY-PUSH 那一行的格式逐字对。
 * 全用临时目录和替身：不调真模型、不连 GitHub。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, PUSH_PARA, REPO, type World } from './l6-harness.js';

const REPO_ROOT = REPO;
const worlds: World[] = [];
const dirs: string[] = [];
const treeRoots: string[] = [];
const world = (opts: Parameters<typeof makeWorld>[0] = {}) => {
  const w = makeWorld(opts);
  worlds.push(w);
  return w;
};
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const root of treeRoots.splice(0)) {
    spawnSync('git', ['worktree', 'remove', '--force', join(root, 'relay-int')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('条件 2：交代里加那一段', () => {
  it('开发的角色标了 pushByRelay → 交代里有契约第 3 条那段原文', async () => {
    const w = world();
    const copy = join(w.root, 'prompt-copy.txt');
    w.writePlan({ copyPrompt: copy, commits: [] });
    expect((await w.run(['once'])).status).toBe(0);
    const prompt = readFileSync(copy, 'utf8');
    for (const line of PUSH_PARA) expect(prompt).toContain(line);
    // RELAY-PUSH 那一行的格式（三个尖括号占位符）逐字对
    expect(prompt).toContain('RELAY-PUSH <工作目录的绝对路径> <本地分支> <远端分支>');
  }, 120_000);

  it('整合方没标 pushByRelay → 交代里没有那一段', async () => {
    const w = world({ queueStatus: '测试待审（整合方）' });
    const copy = join(w.root, 'prompt-copy.txt');
    w.writePlan({ copyPrompt: copy });
    expect((await w.run(['once'])).status).toBe(0);
    const prompt = readFileSync(copy, 'utf8');
    // 先确认这一棒真的产出了交代（不然「没有那一段」是假绿）
    expect(prompt).toContain('RELAY-DONE 70');
    expect(prompt).not.toContain('RELAY-PUSH');
    expect(prompt).not.toContain('这一棒的推送由调度器替你做');
  }, 120_000);
});

describe('条件 2：relay init 写出 pushByRelay', () => {
  it('生成的配置里开发角色 pushByRelay 是 true，整合方没有这个字段', () => {
    const trees = mkTmp('ixa-l6-trees-');
    treeRoots.push(trees);
    const relayDir = mkTmp('ixa-l6-relay-');
    const appdata = mkTmp('ixa-l6-appdata-');
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
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'packages', 'relay', 'bin', 'relay.mjs'), 'init'],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000, env },
    );
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const file = join(relayDir, 'config.json');
    expect(existsSync(file)).toBe(true);
    const config = JSON.parse(readFileSync(file, 'utf8')) as {
      roles: { integrator: Record<string, unknown>; developer: { pushByRelay?: boolean } };
    };
    expect(config.roles.developer.pushByRelay).toBe(true);
    expect('pushByRelay' in config.roles.integrator).toBe(false);
  }, 120_000);
});
