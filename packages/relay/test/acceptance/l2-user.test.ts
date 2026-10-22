/**
 * L2 验收测试（三）：要用户拍板（规格条件 4 的前半，对应契约第 3 条）。
 *
 * 逐条对应：
 * - 条件 4：两种交代里都有「要用户拍板的事，不要自己定：把这一行的状态改成「等用户：<一句话说清要定什么>」，然后停。」；
 *   替身把状态改成「等用户：要不要买新电脑」→ 记账 `statusAfter` 是它；
 *   下一次 `decideNextTurn` 不给这一行；只剩这一行时是 `all-blocked`。
 *   （发 `needs-user` 那半条在 l2b-notify.test.ts。）
 *
 * 临时 git 仓库和替身脚本，不调真模型。数据目录用 IXAEON_RELAY_DIR 指到临时目录。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnPrompt, decideNextTurn, type RelayState, type Turn } from '../../src/index.js';

const ASK =
  '要用户拍板的事，不要自己定：把这一行的状态改成「等用户：<一句话说清要定什么>」，然后停。';
const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l2-user-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const turn = (over: Partial<Turn> = {}): Turn => ({
  role: 'developer',
  kind: 'developer-claim',
  taskId: '70',
  task: 'L7 合成的一行',
  status: '待领',
  ...over,
});
const state = (over: Partial<RelayState> = {}): RelayState => ({
  stoppedReason: null,
  pausedUntil: {},
  turns: 0,
  ...over,
});

describe('条件 4（前半）：交代里的那句话，和「等用户」不再给', () => {
  it('两种交代里都有那句逐字的话', () => {
    const dev = buildTurnPrompt(turn(), { turnNumber: 1 });
    const integ = buildTurnPrompt(
      turn({ role: 'integrator', kind: 'integrator-review', status: '待复审（整合方）' }),
      { turnNumber: 1 },
    );
    expect(dev).toContain(ASK);
    expect(integ).toContain(ASK);
  });

  it('状态以「等用户」开头的行不给；只剩这一行时是 all-blocked', () => {
    const md = [
      '# 委派队列',
      '',
      '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
      '| ---- | ---- | ------------ | ---- | ---- | ---- |',
      '| 70 | L7 合成的一行 | [L7](L7.md) | A | 无 | 等用户：要不要买新电脑 |',
      '',
    ].join('\n');
    const now = new Date('2026-10-22T10:00:00+08:00');
    const r = decideNextTurn(md, state(), now);
    expect('idle' in r && r.idle).toBe('all-blocked');
  });
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
};

/** 替身：把队列里这一行的状态改成「等用户：要不要买新电脑」，提交、推。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const clone = argv[argv.indexOf("--clone") + 1];',
  'const g = (...a) => spawnSync("git", a, { cwd: clone, encoding: "utf8" });',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| 等用户：要不要买新电脑 |"), "utf8");',
  'g("add", "-A");',
  'g("commit", "-q", "-m", "合成：交给用户拍板");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE 70 等用户：要不要买新电脑");',
  '',
].join('\n');

describe('条件 4（前半）：替身改成「等用户」之后，记账记的是这个状态', () => {
  it('statusAfter 是「等用户：要不要买新电脑」', () => {
    const root = mkTmp();
    const origin = join(root, 'origin.git');
    const integ = join(root, 'integ');
    const dev = join(root, 'dev');
    const dataDir = join(root, 'relay');
    mkdirSync(dataDir, { recursive: true });
    git(root, ['init', '--bare', '-b', 'main', origin]);
    git(root, ['clone', origin, integ]);
    git(integ, ['config', 'user.email', 'relay@example.invalid']);
    git(integ, ['config', 'user.name', 'relay']);
    mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
    writeFileSync(
      join(integ, 'docs', '委派', '队列.md'),
      [
        '# 委派队列',
        '',
        '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
        '| ---- | ---- | ------------ | ---- | ---- | ---- |',
        '| 70 | L7 合成的一行 | [L7](L7.md) | A | 无 | 待领 |',
        '',
      ].join('\n'),
      'utf8',
    );
    git(integ, ['add', '-A']);
    git(integ, ['commit', '-m', '初始合成仓库']);
    git(integ, ['push', 'origin', 'HEAD:main']);
    git(root, ['clone', origin, dev]);
    git(dev, ['config', 'user.email', 'relay@example.invalid']);
    git(dev, ['config', 'user.name', 'relay']);

    const stub = join(root, 'stub-role.mjs');
    writeFileSync(stub, STUB, 'utf8');
    const role = (cwd: string) => ({
      argv: [process.execPath, stub, '{prompt_file}', '--clone', cwd],
      cwd,
      timeoutMinutes: 5,
      quotaPatterns: [],
      quotaPauseMinutes: 10,
    });
    writeFileSync(
      join(dataDir, 'config.json'),
      `${JSON.stringify(
        {
          roles: { integrator: role(integ), developer: role(dev) },
          idleSeconds: 1,
          localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(dataDir, 'state.json'),
      `${JSON.stringify(
        {
          stoppedReason: null,
          pausedUntil: { integrator: '2999-01-01T00:00:00.000Z' },
          turns: 0,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const r = spawnSync(process.execPath, [CLI, 'once'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
      windowsHide: true,
      timeout: 120_000,
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const rows = readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { statusAfter: string });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statusAfter).toBe('等用户：要不要买新电脑');
  }, 120_000);
});
