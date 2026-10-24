/**
 * L15 验收测试：做完一件就告诉用户；「没活」一天只说一次、说清要不要用户做什么；早报。
 *
 * 逐条对应规格「验收」：
 * - 条件 1：`formatEvent` 的 `done`：有花费、花费是 0 两种，原样比对。
 * - 条件 2：`formatEvent` 的 idle：不带 `waiting` → 和原来一字不差；`waiting` 两行 → 原话后接
 *   「要你回答的：」和两行；`waiting: []` → 原话后接「没有要你回答的，你不用做什么。」。
 * - 条件 3：合成仓库 + 假飞书：替身把一行改成「已完成（…）」→ 一条 done，`turns`、`hours`、
 *   `costUsd` 照记账算对（事先放一条同一个序号的旧棒）；改成「待复审（整合方）」→ 不发 done。
 * - 条件 4：只剩一行「暂停（…）」和一行「等用户：…」→ `run --exit-when-idle` 跑两次只收到一条
 *   idle，里面列出要回答的那一行；换到第二天再跑 → 又收到一条。
 * - 条件 5：`formatEvent` 的 `morning` 几种组合原样比对；合成仓库、`morningReport: true`、
 *   北京时间 9:30 → 早报只算昨晚 21:00 之后开始的棒；同一天第二份不发、8:30 不发、配置没开不发；
 *   `relay init` 生成的配置和 `config.example.json` 里是 `true`。
 *
 * 假飞书是本机 http 服务（127.0.0.1 随机端口），地址和密钥都是合成的。合成仓库全在临时目录里，
 * 不调真模型、不连 GitHub。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatEvent } from '../../src/notify/feishu.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const SECRET = 'synthetic-secret-not-real';
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const trees: string[] = [];

const mkTmp = (prefix = 'ixa-l15-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const t of trees.splice(0)) {
    spawnSync('git', ['worktree', 'remove', '--force', join(t, 'relay-int')], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    });
    spawnSync('git', ['worktree', 'prune'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fakeFeishu() {
  const texts: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { content?: { text?: string } };
      texts.push(body.content?.text ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${port}/synthetic`, texts };
}

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
};

interface Row {
  no: string;
  task: string;
  tier?: string;
  status: string;
}
const queueOf = (rows: Row[]) =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    ...rows.map((r) => `| ${r.no} | ${r.task} | [x](x.md) | ${r.tier ?? 'A'} | 无 | ${r.status} |`),
    '',
  ].join('\n');

/** 替身：done / review 改这一行的状态并推 main；skip 什么都不做（这一棒照常结束）。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const mode = argv[argv.indexOf("--mode") + 1];',
  'if (mode === "skip") process.exit(0);',
  'const cwd = process.cwd();',
  'const g = (...a) => {',
  '  const r = spawnSync("git", a, { cwd, encoding: "utf8" });',
  '  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }',
  '};',
  'g("pull", "--ff-only", "-q", "origin", "main");',
  'const q = cwd + "/docs/委派/队列.md";',
  'const after = mode === "done" ? "已完成（2026-10-23）" : "待复审（整合方）";',
  'writeFileSync(q, readFileSync(q, "utf8").replace("| 待领 |", "| " + after + " |"), "utf8");',
  'g("add", "-A");',
  'g("commit", "-q", "-m", "合成：替身改状态");',
  'g("push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE 70 " + after);',
  '',
].join('\n');

function setup(opts: {
  rows: Row[];
  mode: 'done' | 'review' | 'skip';
  feishu?: { url: string };
  state?: Record<string, unknown>;
  morningReport?: boolean;
  ledger?: Array<Record<string, unknown>>;
}) {
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
  writeFileSync(join(integ, 'docs', '委派', '队列.md'), queueOf(opts.rows), 'utf8');
  git(integ, ['add', '-A']);
  git(integ, ['commit', '-m', '初始合成仓库']);
  git(integ, ['push', 'origin', 'HEAD:main']);
  git(root, ['clone', origin, dev]);
  git(dev, ['config', 'user.email', 'relay@example.invalid']);
  git(dev, ['config', 'user.name', 'relay']);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string) => ({
    argv: [process.execPath, stub, '{prompt_file}', '--mode', opts.mode],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: [],
    quotaPauseMinutes: 120,
  });
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: { integrator: role(integ), developer: role(dev) },
        idleSeconds: 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
        ...(opts.morningReport ? { morningReport: true } : {}),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify(
      { stoppedReason: null, pausedUntil: {}, turns: 0, ...(opts.state ?? {}) },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (opts.feishu) {
    writeFileSync(
      join(dataDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: opts.feishu.url, secret: SECRET })}\n`,
      'utf8',
    );
  }
  if (opts.ledger) {
    writeFileSync(
      join(dataDir, 'ledger.jsonl'),
      `${opts.ledger.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
  }
  return { dataDir };
}

const relay = (dataDir: string, args: string[], now: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        IXAEON_RELAY_DIR: dataDir,
        IXAEON_RELAY_NOW: now,
        IXAEON_RELAY_CODE: REPO,
        IXAEON_WORKTREES: join(dirs[0] ?? tmpdir(), 'trees'),
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => p.kill(), 110_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });

const MORNING = '2026-10-23T02:00:00.000Z'; // 北京时间 10月23日 10:00

describe('条件 1：done 的文字逐字对', () => {
  it('有花费：两行，棒数、小时（一位小数）、两位美元', () => {
    expect(
      formatEvent({
        kind: 'done',
        taskId: '70',
        task: 'L7 合成的一行',
        turns: 3,
        hours: 2.34,
        costUsd: 1.456,
      }),
    ).toBe(
      [
        '【IXAEON 接力】',
        '第 70 行做完了：L7 合成的一行',
        '一共 3 棒、2.3 小时，整合方花了 1.46 美元',
      ].join('\n'),
    );
  });

  it('花费是 0：不写美元那一段；整数小时也带一位小数', () => {
    expect(
      formatEvent({
        kind: 'done',
        taskId: '71',
        task: 'L8 合成的另一行',
        turns: 1,
        hours: 2,
        costUsd: 0,
      }),
    ).toBe(
      ['【IXAEON 接力】', '第 71 行做完了：L8 合成的另一行', '一共 1 棒、2.0 小时'].join('\n'),
    );
  });
});

describe('条件 2：idle 的文字', () => {
  it('不带 waiting → 和原来一字不差', () => {
    expect(formatEvent({ kind: 'idle', why: 'queue-empty' })).toBe(
      ['【IXAEON 接力】', '队列空了，等你排新活。'].join('\n'),
    );
    expect(formatEvent({ kind: 'idle', why: 'all-blocked' })).toBe(
      ['【IXAEON 接力】', '剩下的都被依赖或暂停挡着，等你看一眼。'].join('\n'),
    );
  });

  it('waiting 两行 → 原话后接「要你回答的：」和两行', () => {
    expect(
      formatEvent({
        kind: 'idle',
        why: 'all-blocked',
        waiting: [
          { no: '76', task: 'V4 合成的第一件', status: '等用户：要不要现在重写' },
          { no: '78', task: 'L11b 合成的第二件', status: '等用户' },
        ],
      }),
    ).toBe(
      [
        '【IXAEON 接力】',
        '剩下的都被依赖或暂停挡着，等你看一眼。',
        '要你回答的：',
        '- 第 76 行 V4 合成的第一件：要不要现在重写',
        '- 第 78 行 L11b 合成的第二件：',
      ].join('\n'),
    );
  });

  it('waiting 是空数组 → 原话后接「没有要你回答的，你不用做什么。」', () => {
    expect(formatEvent({ kind: 'idle', why: 'all-blocked', waiting: [] })).toBe(
      [
        '【IXAEON 接力】',
        '剩下的都被依赖或暂停挡着，等你看一眼。',
        '没有要你回答的，你不用做什么。',
      ].join('\n'),
    );
  });
});

describe('条件 3：一棒做完发 done（合成仓库 + 假飞书）', () => {
  const OLD = {
    turn: 7,
    role: 'developer',
    kind: 'developer-continue',
    taskId: '70',
    startedAt: '2026-10-23T00:00:00.000Z',
    endedAt: '2026-10-23T02:00:00.000Z',
    exitCode: 0,
    timedOut: false,
    quotaHit: false,
    usage: { costUsd: 0.5 },
    statusBefore: '进行中（dev）',
    statusAfter: '进行中（dev）',
    doneLine: null,
    violations: [],
  };

  it('换成「已完成（…）」→ 一条 done；turns、hours、costUsd 照记账算（含同序号的旧棒）', async () => {
    const fake = await fakeFeishu();
    const s = setup({
      rows: [{ no: '70', task: 'L7 合成的一行', status: '待领' }],
      mode: 'done',
      feishu: fake,
      ledger: [OLD],
    });
    const r = await relay(s.dataDir, ['once'], MORNING);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const done = fake.texts.filter((t) => t.includes('做完了'));
    expect(done).toHaveLength(1);
    expect(done[0]!.split('\n')[0]).toBe('【IXAEON 接力】');
    expect(done[0]!.split('\n')[1]).toBe('第 70 行做完了：L7 合成的一行');
    // 旧棒 2 小时整 + 这一棒不到一秒 → 一位小数是 2.0；花费 0.5 + 0 → 0.50。
    expect(done[0]!.split('\n')[2]).toBe('一共 2 棒、2.0 小时，整合方花了 0.50 美元');
  }, 120_000);

  it('换成「待复审（整合方）」→ 不发 done', async () => {
    const fake = await fakeFeishu();
    const s = setup({
      rows: [{ no: '70', task: 'L7 合成的一行', status: '待领' }],
      mode: 'review',
      feishu: fake,
    });
    const r = await relay(s.dataDir, ['once'], MORNING);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(fake.texts.filter((t) => t.includes('做完了'))).toHaveLength(0);
  }, 120_000);
});

describe('条件 4：没活一天只发一次，并列出要回答的', () => {
  const ROWS: Row[] = [
    { no: '70', task: 'L14 合成的一行', status: '暂停（等 D2c）' },
    { no: '71', task: 'L15 合成的一行', status: '等用户：要不要 X' },
  ];

  it('同一个北京日跑两次只收到一条；第二天再跑又收到一条', async () => {
    const fake = await fakeFeishu();
    const s = setup({ rows: ROWS, mode: 'skip', feishu: fake });
    expect((await relay(s.dataDir, ['run', '--exit-when-idle'], MORNING)).status).toBe(0);
    expect((await relay(s.dataDir, ['run', '--exit-when-idle'], MORNING)).status).toBe(0);

    const idle = fake.texts.filter((t) => t.includes('挡着'));
    expect(idle).toHaveLength(1);
    expect(idle[0]!.split('\n')).toEqual([
      '【IXAEON 接力】',
      '剩下的都被依赖或暂停挡着，等你看一眼。',
      '要你回答的：',
      '- 第 71 行 L15 合成的一行：要不要 X',
    ]);

    expect(
      (await relay(s.dataDir, ['run', '--exit-when-idle'], '2026-10-24T02:00:00.000Z')).status,
    ).toBe(0);
    expect(fake.texts.filter((t) => t.includes('挡着'))).toHaveLength(2);
  }, 180_000);
});

describe('条件 5：早报', () => {
  it('formatEvent 的 morning：有花费 / 没花费、有在做 / 没在做、做完了 / 没做完', () => {
    // 早报上的日期取调度器眼里的「现在」（formatEvent 的 morning 事件里不带 date 字段）。
    const old = process.env.IXAEON_RELAY_NOW;
    process.env.IXAEON_RELAY_NOW = '2026-10-24T01:30:00.000Z'; // 北京 10月24日 09:30
    try {
      expect(
        formatEvent({
          kind: 'morning',
          turns: 3,
          done: ['A 合成的一件', 'B 合成的另一件'],
          costUsd: 1.5,
          doing: ['C 合成的一行'],
        }),
      ).toBe(
        [
          '【IXAEON 接力】',
          '早报 10月24日：昨晚 9 点到现在跑了 3 棒，整合方花了 1.50 美元',
          '做完了：A 合成的一件、B 合成的另一件',
          '在做：C 合成的一行',
        ].join('\n'),
      );
      expect(formatEvent({ kind: 'morning', turns: 0, done: [], doing: [] })).toBe(
        ['【IXAEON 接力】', '早报 10月24日：昨晚 9 点到现在跑了 0 棒', '这段时间没做完新的'].join(
          '\n',
        ),
      );
    } finally {
      if (old === undefined) delete process.env.IXAEON_RELAY_NOW;
      else process.env.IXAEON_RELAY_NOW = old;
    }
  });

  const DONE_OLD = {
    turn: 3,
    role: 'developer',
    kind: 'developer-claim',
    taskId: '70',
    startedAt: '2026-10-23T14:00:00.000Z', // 北京 10月23日 22:00
    endedAt: '2026-10-23T15:00:00.000Z',
    exitCode: 0,
    timedOut: false,
    quotaHit: false,
    usage: { costUsd: 0.25 },
    statusBefore: '待领',
    statusAfter: '已完成（2026-10-23）',
    doneLine: 'RELAY-DONE 70 已完成（2026-10-23）',
    violations: [],
  };
  const BEFORE = { ...DONE_OLD, turn: 2, startedAt: '2026-10-23T12:00:00.000Z' }; // 北京 20:00

  it('北京时间 9:30 → 早报只算昨晚 9 点之后的棒；同一天再跑不发第二份', async () => {
    const fake = await fakeFeishu();
    const s = setup({
      rows: [
        { no: '70', task: 'L7 合成的一行', status: '已完成（2026-10-23）' },
        { no: '71', task: 'L8 合成的一行', status: '进行中（dev）' },
      ],
      mode: 'skip',
      feishu: fake,
      morningReport: true,
      ledger: [BEFORE, DONE_OLD],
    });
    const NINE_THIRTY = '2026-10-24T01:30:00.000Z'; // 北京 10月24日 09:30
    expect((await relay(s.dataDir, ['once'], NINE_THIRTY)).status).toBe(0);
    const morning = fake.texts.filter((t) => t.includes('早报'));
    expect(morning).toHaveLength(1);
    expect(morning[0]).toBe(
      [
        '【IXAEON 接力】',
        '早报 10月24日：昨晚 9 点到现在跑了 1 棒，整合方花了 0.25 美元',
        '做完了：L7 合成的一行',
        '在做：L8 合成的一行',
      ].join('\n'),
    );
    expect((await relay(s.dataDir, ['once'], NINE_THIRTY)).status).toBe(0);
    expect(fake.texts.filter((t) => t.includes('早报'))).toHaveLength(1);
  }, 180_000);

  it('8:30 不发早报', async () => {
    const fake = await fakeFeishu();
    const s = setup({
      rows: [{ no: '70', task: 'L7 合成的一行', status: '已完成（2026-10-23）' }],
      mode: 'skip',
      feishu: fake,
      morningReport: true,
    });
    expect((await relay(s.dataDir, ['once'], '2026-10-24T00:30:00.000Z')).status).toBe(0); // 北京 08:30
    expect(fake.texts.filter((t) => t.includes('早报'))).toHaveLength(0);
  }, 120_000);

  it('配置没有 morningReport → 不发早报', async () => {
    const fake = await fakeFeishu();
    const s = setup({
      rows: [{ no: '70', task: 'L7 合成的一行', status: '已完成（2026-10-23）' }],
      mode: 'skip',
      feishu: fake,
    });
    expect((await relay(s.dataDir, ['once'], '2026-10-24T01:30:00.000Z')).status).toBe(0);
    expect(fake.texts.filter((t) => t.includes('早报'))).toHaveLength(0);
  }, 120_000);

  it('config.example.json 和 relay init 生成的配置里 morningReport 是 true', () => {
    const example = JSON.parse(
      readFileSync(join(REPO, 'packages', 'relay', 'config.example.json'), 'utf8'),
    ) as { morningReport?: boolean };
    expect(example.morningReport).toBe(true);

    const treesRoot = mkTmp('ixa-l15-trees-');
    trees.push(treesRoot);
    const relayDir = mkTmp('ixa-l15-init-');
    const appdata = mkTmp('ixa-l15-appdata-');
    const fakeClaude = join(
      appdata,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    mkdirSync(dirname(fakeClaude), { recursive: true });
    writeFileSync(fakeClaude, 'stub\n', 'utf8');

    const r = spawnSync(process.execPath, [CLI, 'init'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: {
        ...process.env,
        IXAEON_RELAY_DIR: relayDir,
        IXAEON_WORKTREES: treesRoot,
        APPDATA: appdata,
      },
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(existsSync(join(relayDir, 'config.json'))).toBe(true);
    const config = JSON.parse(readFileSync(join(relayDir, 'config.json'), 'utf8')) as {
      morningReport?: boolean;
    };
    expect(config.morningReport).toBe(true);
  }, 180_000);
});
