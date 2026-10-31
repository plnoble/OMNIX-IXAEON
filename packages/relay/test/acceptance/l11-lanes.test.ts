/**
 * L11 验收条件 1、6、7：看门人两条道。
 * - 条件 1：`lanes: 2` + `IXAEON_RELAY_CODE` 指本仓库：两棒都记账、棒号不一样、
 *   整合方那棒的开始早于开发那棒的结束（同时跑）、两行状态都改了、没停。
 * - 条件 6：开发那条道连崩 3 次 → stoppedReason 照 L10；整合方那条道跑完手上那棒不再开新的。
 * - 条件 7：`lanes` 不写 → 输出和 L10 一样（没有「（角色）」后缀）。
 *
 * 先测试后实现（B 档）：看门人的双道还没写，条件 1、6 的条目现在是红的；
 * 条件 7 那条现在就应当是绿的（L10 的行为不许变，锁定的 L10 测试也在守它）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld, type World } from './l10-harness.js';

const worlds: World[] = [];
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return d;
};
afterEach(() => {
  for (const w of worlds.splice(0)) {
    if (w.root) rmSync(w.root, { recursive: true, force: true });
  }
});

const REPO = process.cwd();

/** 给 makeWorld 生成的配置补上 lanes 与两个 gitIdentity。 */
function withLanes(w: World, lanes: 1 | 2): void {
  const cfgPath = join(w.dataDir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    roles: { integrator: Record<string, unknown>; developer: Record<string, unknown> };
    [k: string]: unknown;
  };
  cfg.lanes = lanes;
  cfg.roles.developer.gitIdentity = { name: 'dev', email: 'dev@ixaeon.invalid' };
  cfg.roles.integrator.gitIdentity = {
    name: 'relay-integrator',
    email: 'integrator@ixaeon.invalid',
  };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/**
 * 替身：开发把第 70 行（待领）改成测试待审（快）；整合方把第 71 行（测试待审）改成已完成（可先睡几秒）。
 * 队列里得有两行——两条道一开始就各有一行活，才看得出「同时跑」。
 */
function slowIntegStub(w: World, sleepMs: number): void {
  const stub = join(w.root, 'stub-lanes.mjs');
  writeFileSync(
    stub,
    [
      "import { spawnSync } from 'node:child_process';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'const opt = (n) => argv[argv.indexOf(n) + 1];',
      'const role = opt("--role");',
      'const clone = opt("--clone");',
      'const timing = opt("--timing");',
      'writeFileSync(timing, JSON.stringify({ role, start: new Date().toISOString(), end: null }), "utf8");',
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleepMs});`,
      'const g = (...a) => {',
      '  const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
      '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
      '};',
      '// 两条道同时改相邻的行，merge/rebase 会撞：一律从最新的 origin/main 重打底子再改',
      'const fresh = () => { g("fetch", "-q", "origin"); g("reset", "-q", "--hard", "origin/main"); };',
      'const q = clone + "/docs/委派/队列.md";',
      'const editRow = (no, from, to) => writeFileSync(q, readFileSync(q, "utf8").split("\\n").map((l) => l.startsWith(`| ${no} |`) ? l.replace(`| ${from} |`, `| ${to} |`) : l).join("\\n"), "utf8");',
      'let no, from, to, after;',
      'if (role === "developer") { no = "70"; from = "待领"; to = "测试待审（整合方）"; }',
      'else { no = "71"; from = "测试待审（整合方）"; to = "已完成（2026-10-23）"; }',
      'after = to;',
      'const apply = () => { editRow(no, from, to); g("add", "-A"); g("commit", "-q", "-m", "合成：替身改状态"); };',
      'fresh();',
      'apply();',
      'let ok = false;',
      'for (let i = 0; i < 3; i++) {',
      '  const pr = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: clone, encoding: "utf8" });',
      '  if (pr.status === 0) { ok = true; break; }',
      '  fresh(); apply();',
      '}',
      'if (!ok) { console.error("替身：推了三次都没推上"); process.exit(1); }',
      'const t = JSON.parse(readFileSync(timing, "utf8"));',
      't.end = new Date().toISOString();',
      'writeFileSync(timing, JSON.stringify(t), "utf8");',
      'console.log("RELAY-DONE " + no + " " + after);',
      '',
    ].join('\n'),
    'utf8',
  );
  const cfgPath = join(w.dataDir, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    roles: { integrator: { argv: string[] }; developer: { argv: string[] } };
  };
  const timing = join(w.root, 'timing');
  mkdirSync(timing, { recursive: true });
  for (const [role, clone] of [
    ['integrator', w.integ],
    ['developer', w.dev],
  ] as const) {
    cfg.roles[role].argv = [
      process.execPath,
      stub,
      '{prompt_file}',
      '--role',
      role,
      '--clone',
      clone,
      '--timing',
      join(timing, `${role}.json`),
    ];
  }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

describe('条件 1：lanes: 2 两条道同时跑', () => {
  it('两棒都记账、棒号不一样；整合方开始早于开发结束；两行状态都改了；没停', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    withLanes(w, 2);
    slowIntegStub(w, 4000);
    // 队列里再放一行「测试待审（整合方）」：两条道一开始就各有一行活，才看得出同时跑
    const q = join(w.integ, 'docs', '委派', '队列.md');
    writeFileSync(
      q,
      `${readFileSync(q, 'utf8')}| 71 | L9 合成的另一行 | [L9](L9.md) | B | 无 | 测试待审（整合方） |\n`,
      'utf8',
    );
    w.git(w.integ, ['add', '-A']);
    w.git(w.integ, ['commit', '-q', '-m', '合成：加一行整合方的活']);
    w.git(w.integ, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: REPO });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const ledger = w.ledger();
    const roles = ledger.map((row) => row.role);
    expect(roles).toContain('developer');
    expect(roles).toContain('integrator');
    const numbers = ledger.map((row) => row.turn as number);
    expect(new Set(numbers).size).toBe(ledger.length); // 棒号不重复
    const integ = ledger.find((row) => row.role === 'integrator')!;
    const dev = ledger.find((row) => row.role === 'developer')!;
    expect(
      String(integ.startedAt) < String(dev.endedAt),
      '整合方开始早于开发结束（两条道同时在跑）',
    ).toBe(true);
    const queueNow = w.git(w.dev, ['show', 'origin/main:docs/委派/队列.md']).out;
    expect(queueNow).toContain('| 测试待审（整合方） |');
    expect(queueNow).toContain('| 已完成（2026-10-23） |');
    expect(w.state().stoppedReason).toBeFalsy();
    // 两条道的输出都带角色后缀
    expect(r.stdout).toContain('（developer）');
    expect(r.stdout).toContain('（integrator）');
  }, 180_000);
});

describe('条件 6：一条道连崩 3 次', () => {
  it('开发道连崩 3 次 → stoppedReason 照 L10；整合方道跑完手上那棒就停；看门人退出', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    withLanes(w, 2);
    slowIntegStub(w, 0);
    // 假代码目录：relay.mjs 对 --role developer 一律退出 1，别的角色立即 0
    const fake = temp('ixa-l11-fakecode-');
    const bin = join(fake, 'packages', 'relay', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'relay.mjs'),
      [
        'const argv = process.argv.slice(2);',
        'const role = argv.includes("--role") ? argv[argv.indexOf("--role") + 1] : "";',
        'if (role === "developer") { console.error("合成：开发道崩了"); process.exit(1); }',
        'console.log("合成：这一棒没事");',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf8',
    );
    const r = await w.run(['run'], { IXAEON_RELAY_CODE: fake });
    expect(w.state().stoppedReason, r.stdout).toContain('调度器连着崩了 3 次');
    // 整合方那条道自己也转过（起过自己的子进程），只是没活可记
    expect(r.stdout).toContain('（integrator）');
    // 看门人自己退出了（run 不带 --exit-when-idle 也退：两道都停了）
    expect(r.status).toBe(0);
  }, 180_000);
});

describe('条件 7：lanes 不写 = 和 L10 一模一样', () => {
  it('输出还是「子进程 <pid> 退出 <code>」，没有角色后缀', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    const r = await w.run(['run', '--exit-when-idle'], { IXAEON_RELAY_CODE: REPO });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('子进程 '));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /子进程 \d+ 退出 \d+$/.test(l.trim()))).toBe(true);
    expect(r.stdout).not.toContain('（developer）');
  }, 180_000);
});
