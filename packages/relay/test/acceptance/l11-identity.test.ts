/**
 * L11 验收条件 3：调度器起角色时设好 git 署名。
 * - `gitIdentity` 有值 → 替身收到的 `GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`、
 *   `GIT_COMMITTER_NAME`、`GIT_COMMITTER_EMAIL` 和配置里那个角色的一样；
 * - 没配 `gitIdentity` → 这几个不设（替身收到的是外面原来的值）。
 *
 * 用替身把收到的四个环境变量写进文件再断言；不起真模型。
 * `runTurn` 的署名还没实现，第一条现在是红的（测试先行）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l10-harness.js';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) {
    if (w.root) rmSync(w.root, { recursive: true, force: true });
  }
});

/** 替身：把自己收到的 GIT_* 四个变量写进 --dump-env 指的文件，然后照常改状态。 */
function envDumpStub(w: World): void {
  const stub = join(w.root, 'stub-env.mjs');
  writeFileSync(
    stub,
    [
      "import { spawnSync } from 'node:child_process';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'const opt = (n) => argv[argv.indexOf(n) + 1];',
      'const role = opt("--role");',
      'const clone = opt("--clone");',
      'const dump = opt("--dump-env");',
      'writeFileSync(dump, JSON.stringify({',
      '  authorName: process.env.GIT_AUTHOR_NAME ?? null,',
      '  authorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,',
      '  committerName: process.env.GIT_COMMITTER_NAME ?? null,',
      '  committerEmail: process.env.GIT_COMMITTER_EMAIL ?? null,',
      '}), "utf8");',
      'const g = (...a) => {',
      '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
      '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
      '};',
      'g("pull", "--ff-only", "-q", "origin", "main");',
      'const q = clone + "/docs/委派/队列.md";',
      'let after;',
      'if (role === "developer") {',
      '  writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 测试待审（整合方） |"), "utf8");',
      '  after = "测试待审（整合方）";',
      '} else {',
      '  writeFileSync(q, readFileSync(q, "utf8").replace("| 测试待审（整合方） |", "| 已完成（2026-10-23） |"), "utf8");',
      '  after = "已完成（2026-10-23）";',
      '}',
      'g("add", "-A");',
      'g("commit", "-q", "-m", "合成：替身改状态");',
      'g("push", "-q", "origin", "HEAD:main");',
      'console.log("RELAY-DONE 70 " + after);',
      '',
    ].join('\n'),
    'utf8',
  );
  const cfgPath = join(w.dataDir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    roles: { integrator: { argv: string[] }; developer: { argv: string[] } };
  };
  for (const [role, clone] of [
    ['developer', w.dev],
    ['integrator', w.integ],
  ] as const) {
    cfg.roles[role].argv = [
      process.execPath,
      stub,
      '{prompt_file}',
      '--role',
      role,
      '--clone',
      clone,
      '--dump-env',
      join(w.root, `env-${role}.json`),
    ];
  }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function setIdentity(w: World, on: boolean): void {
  const cfgPath = join(w.dataDir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    roles: {
      integrator: Record<string, unknown>;
      developer: Record<string, unknown>;
    };
  };
  if (on) {
    cfg.roles.developer.gitIdentity = { name: 'dev', email: 'dev@ixaeon.invalid' };
    cfg.roles.integrator.gitIdentity = {
      name: 'relay-integrator',
      email: 'integrator@ixaeon.invalid',
    };
  }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

describe('条件 3：起角色时设 git 署名', () => {
  it('配置了 gitIdentity：替身收到的四个变量和配置一致', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    envDumpStub(w);
    setIdentity(w, true);
    const r = await w.run(['once'], { IXAEON_RELAY_CODE: process.cwd() });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const dump = JSON.parse(readFileSync(join(w.root, 'env-developer.json'), 'utf8')) as Record<
      string,
      string | null
    >;
    expect(dump.authorName).toBe('dev');
    expect(dump.authorEmail).toBe('dev@ixaeon.invalid');
    expect(dump.committerName).toBe('dev');
    expect(dump.committerEmail).toBe('dev@ixaeon.invalid');
  }, 120_000);

  it('没配 gitIdentity：不设这几个（替身收到的是外面原来的值）', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    envDumpStub(w);
    setIdentity(w, false);
    const r = await w.run(['once'], { IXAEON_RELAY_CODE: process.cwd() });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const dump = JSON.parse(readFileSync(join(w.root, 'env-developer.json'), 'utf8')) as Record<
      string,
      string | null
    >;
    // 外面没有设过：替身收到的就应当是 null
    expect(dump.authorName).toBeNull();
    expect(dump.authorEmail).toBeNull();
    expect(dump.committerName).toBeNull();
    expect(dump.committerEmail).toBeNull();
  }, 120_000);
});
