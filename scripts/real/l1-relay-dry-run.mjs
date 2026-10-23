/**
 * L1b 真机检查：`scripts/real/l1-relay-dry-run.mjs`（规格「真机检查」那一节）。
 *
 * 在**临时目录**里建一个合成的 git 仓库：
 *   - 一份合成的队列（三行：一行「待领」B 档、一行「待领」A 档、一行「已完成」）；
 *   - 两个**替身角色**（小脚本：开发替身把「待领」改成「测试待审（整合方）」并提交推送；
 *     整合方替身把它改成「已完成」并提交推送）。
 * 然后跑 `relay run --exit-when-idle`，一直转到 `queue-empty`，打印每一棒的记账。
 * 再造一次越界（开发这一棒「并入 L80」，而 L80 是 B 档）：看它停下、`relay status` 里写着原因，
 * `relay resume` 之后又能接着跑。
 *
 * **不调真的模型**：角色全是替身小脚本，git 仓库是临时目录里的合成仓库。
 * 输出遮掉临时目录与本机账户名。退出码：全部符合预期才 0。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repo, 'packages', 'relay', 'bin', 'relay.mjs');

const mask = (s) => {
  let text = String(s);
  for (const p of [
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
    tmpdir(),
  ].filter((x) => x && x.trim())) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};

/** 替身角色：拉一下，按 --mode 改队列或者并一笔，提交推送，最后一行打 RELAY-DONE。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const prompt = readFileSync(argv[0], "utf8");',
  'const mode = argv[argv.indexOf("--mode") + 1];',
  'const clone = argv[argv.indexOf("--clone") + 1];',
  'const g = (...a) => spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'const taskId = (prompt.match(/序号[^0-9]{0,4}(\\d+)/) ?? [])[1] ?? "?";',
  'let after = "?";',
  'if (mode === "dev") {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 测试待审（整合方） |"), "utf8");',
  '  after = "测试待审（整合方）";',
  '} else if (mode === "integ") {',
  '  writeFileSync(q, readFileSync(q, "utf8").replace("| 测试待审（整合方） |", "| 已完成（2026-10-21） |"), "utf8");',
  '  after = "已完成（2026-10-21）";',
  '} else if (mode === "merge-b") {',
  '  writeFileSync(clone + "/docs/委派/笔记.md", "越界的一笔 " + Date.now() + "\\n", "utf8");',
  '  after = "待复审（整合方）";',
  '}',
  'g("add", "-A");',
  'g("commit", "-q", "-m", mode === "merge-b" ? "并入 L80：B 档那一笔" : "L：替身改状态");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE " + taskId + " " + after);',
  '',
].join('\n');

const QUEUE = [
  '# 委派队列（合成的）',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 80 | L80 合成的 B 档一行 | [L80](L80.md) | B | 无 | 待领 |',
  '| 81 | L81 合成的 A 档一行 | [L81](L81.md) | A | 无 | 待领 |',
  '| 82 | L82 早做完的一行 | [L82](L82.md) | A | 无 | 已完成（2026-10-20） |',
  '',
].join('\n');

/** 合成仓库 + 两个替身角色 + 数据目录。 */
function setup(tag) {
  const root = mkdtempSync(join(tmpdir(), `ixa-relay-dry-${tag}-`));
  const origin = join(root, 'origin.git');
  const integ = join(root, 'integ');
  const dev = join(root, 'dev');
  const dataDir = join(root, 'relay');
  mkdirSync(dataDir, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, integ]);
  git(integ, ['config', 'user.email', 'dev@example.invalid']);
  git(integ, ['config', 'user.name', 'dev']);
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(join(integ, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
  git(integ, ['add', '-A']);
  git(integ, ['commit', '-q', '-m', '初始合成仓库']);
  git(integ, ['push', '-q', 'origin', 'HEAD:main']);
  git(root, ['clone', '-q', origin, dev]);
  git(dev, ['config', 'user.email', 'dev@example.invalid']);
  git(dev, ['config', 'user.name', 'dev']);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd, mode) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--mode', mode, '--clone', cwd],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 30,
  });
  return { root, integ, dev, dataDir, role };
}

const relay = (dataDir, args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    // L10：relay run 是看门人；指定代码根，不去本机真的 Worktrees 下建 relay-run、不连 GitHub。
    env: { ...process.env, IXAEON_RELAY_DIR: dataDir, IXAEON_RELAY_CODE: repo },
    windowsHide: true,
    timeout: 300_000,
  });

const ledger = (dataDir) => {
  const p = join(dataDir, 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

let bad = 0;
const check = (ok, what, extra = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${what}${extra ? `：${mask(extra)}` : ''}`);
};

const dirs = [];
try {
  // ── 一、一直转到 queue-empty ──────────────────────────────────────────────
  console.log('== 一、合成仓库 + 两个替身角色，relay run --exit-when-idle 一直转到 queue-empty');
  const a = setup('run');
  dirs.push(a.root);
  writeFileSync(
    join(a.dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: { integrator: a.role(a.integ, 'integ'), developer: a.role(a.dev, 'dev') },
        idleSeconds: 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const r1 = relay(a.dataDir, ['run', '--exit-when-idle']);
  console.log(mask(`   退出码 ${r1.status}｜${(r1.stdout ?? '').trim()}`));
  const rows = ledger(a.dataDir);
  for (const row of rows) {
    console.log(
      `   记账 第${row.turn}棒 ${row.role} ${row.kind} 行${row.taskId}：${row.statusBefore} → ${row.statusAfter}` +
        `｜exit=${row.exitCode} timedOut=${row.timedOut} quotaHit=${row.quotaHit}` +
        `｜doneLine=${row.doneLine}｜越界=[${row.violations.join(',')}]`,
    );
  }
  const state1 = JSON.parse(readFileSync(join(a.dataDir, 'state.json'), 'utf8'));
  console.log(`   收尾状态：turns=${state1.turns} stoppedReason=${state1.stoppedReason ?? 'null'}`);
  console.log(
    `   队列现在是：${git(a.integ, ['show', 'origin/main:docs/委派/队列.md'])
      .match(/\| (待领|测试待审（整合方）|已完成（[^|]*）|待复审（整合方）) \|/g)
      ?.map((s) => s.trim())
      .join(' ')}`,
  );
  check(r1.status === 0, 'run --exit-when-idle 退出码 0', String(r1.status));
  check(
    rows.length === 4,
    '跑到没活为止一共四棒（两行待领，各自：开发领 + 整合方完成）',
    String(rows.length),
  );
  check(
    rows.map((x) => [x.turn, x.role, x.kind, x.taskId, x.statusAfter]).join('|') ===
      '1,developer,developer-claim,80,测试待审（整合方）|2,integrator,integrator-review,80,已完成（2026-10-21）|3,developer,developer-claim,81,测试待审（整合方）|4,integrator,integrator-review,81,已完成（2026-10-21）',
    '先 B 档那行（第 1、2 棒），再 A 档那行（第 3、4 棒）',
    rows.map((x) => `${x.turn}:${x.role}:${x.kind}:${x.taskId}:${x.statusAfter}`).join(' / '),
  );
  check(state1.turns === 4 && (state1.stoppedReason ?? null) === null, 'state.turns=4 且没有停住');
  check(
    existsSync(join(a.dataDir, 'turns', '1', 'prompt.md')) &&
      existsSync(join(a.dataDir, 'turns', '1', 'stdout.txt')) &&
      existsSync(join(a.dataDir, 'turns', '4', 'prompt.md')) &&
      existsSync(join(a.dataDir, 'turns', '4', 'stderr.txt')),
    '每一棒的 prompt/stdout/stderr 都落在 turns/<编号>/ 里',
  );
  check(
    git(a.integ, ['status', '--porcelain']) === '',
    '整合方目录的工作区是干净的（调度器不改仓库）',
  );

  // ── 二、造一次越界 ───────────────────────────────────────────────────────
  console.log('== 二、造一次越界：开发这一棒「并入 L80」（B 档）应停下，resume 之后又能接着跑');
  const b = setup('bad');
  dirs.push(b.root);
  writeFileSync(
    join(b.dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          integrator: { ...b.role(b.integ, 'integ'), argv: [] },
          developer: b.role(b.dev, 'merge-b'),
        },
        idleSeconds: 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(b.dataDir, 'state.json'),
    `${JSON.stringify(
      { stoppedReason: null, pausedUntil: { integrator: '2999-01-01T00:00:00.000Z' }, turns: 0 },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const r2 = relay(b.dataDir, ['once']);
  const state2 = JSON.parse(readFileSync(join(b.dataDir, 'state.json'), 'utf8'));
  console.log(mask(`   relay once 退出码 ${r2.status}｜${(r2.stdout ?? '').trim()}`));
  console.log(
    `   记账：${JSON.stringify(ledger(b.dataDir).map((x) => ({ turn: x.turn, role: x.role, taskId: x.taskId, violations: x.violations })))}`,
  );
  console.log(`   state.stoppedReason = ${state2.stoppedReason ?? 'null'}`);
  check(r2.status === 0, 'once 退出码 0', String(r2.status));
  check(
    String(state2.stoppedReason ?? '').includes('b-tier-merged-by-developer'),
    '停下，原因里有 b-tier-merged-by-developer',
    String(state2.stoppedReason ?? ''),
  );
  const r3 = relay(b.dataDir, ['once']);
  check(
    ledger(b.dataDir).length === 1 && !existsSync(join(b.dataDir, 'turns', '2')),
    '停住之后再 once 什么都不跑（不加记账、不新开一棒）',
  );
  const r4 = relay(b.dataDir, ['status']);
  console.log(
    mask(
      `   relay status 退出码 ${r4.status}；输出里有原因吗：${String(r4.stdout).includes('b-tier-merged-by-developer')}`,
    ),
  );
  check(String(r4.stdout).includes('b-tier-merged-by-developer'), 'relay status 里写着停住的原因');
  const r5 = relay(b.dataDir, ['resume']);
  const state3 = JSON.parse(readFileSync(join(b.dataDir, 'state.json'), 'utf8'));
  check(
    r5.status === 0 && (state3.stoppedReason ?? null) === null,
    'relay resume 之后 stoppedReason 清掉了',
  );
  const r6 = relay(b.dataDir, ['once']);
  check(ledger(b.dataDir).length === 2, 'resume 之后 once 又能跑一棒（记账到两行）');
  check(r3.status === 0 && r6.status === 0, '停住期间的 once 与 resume 之后的 once 退出码都是 0');
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(bad === 0 ? '== 全部符合预期' : `== 有 ${bad} 条不符合预期`);
process.exit(bad === 0 ? 0 : 1);
