/**
 * K2 验收（规格 docs/委派/K2-驾驶舱快照.md，B 档：先只推测试）。
 *
 * 每个 it 对应规格「验收条件」里的一条：
 * 条件 1：合成 relay 目录（lock.json 用测试进程自己的 pid，ledger 3 棒，turns/ 1 到 4、4 没进 ledger）
 *          → running 有 relay 和第 4 棒，recent 3 条且最新在前。
 * 条件 2：同一个合成目录，lock.json 的 pid 不存在 → attention 有 relay_down 和 turn_unfinished（第 4 棒）。
 * 条件 3：最后一棒结束于 3 小时前、没有额度暂停、队列有「待领」→ relay 为 stale，attention 有 relay_stale；
 *          把其中一个角色的 pausedUntil 设在未来 → 不再 stale，running 出现 paused_role。
 * 条件 4：state.json 的 stoppedReason 非空 → attention 有 relay_stopped。
 * 条件 5：合成 git 仓库：origin/main 上的队列有一行「等用户：待用户定」，工作区再改出一行（不推）
 *          → 只出现 origin/main 那一行。
 * 条件 6：relay 目录不存在 → relay 为 missing，queue、projects 照常。
 * 条件 7：合成目录里放 config.json、feishu.json（假密钥 SECRET-XYZ）、turns/4/prompt.md（PROMPT-XYZ）、
 *          inbox.jsonl（INBOX-XYZ）→ 快照 JSON 里找不到这三个字符串。
 * 条件 9：队列一行「待领（用户 10-25 定的…）」、一行「等用户：要不要做 X」→ 只有后一行进 queue_user。
 * 条件 10：state.json 的 notify.sent 里有 needs-user 70 键、队列里第 70 行已完成 → attention 里没有它。
 * 条件 11：ledger 一棒 kind 是 integrator-inbox、statusAfter 是 INBOX-SUMMARY-XYZ → 快照 JSON 里找不到这个
 *          字符串（statusBefore 同样不用），recent 里那一条写「处理了你在飞书里的回复」。
 * 条件 8（projects 分组 + IPC）在 apps/desktop/test/acceptance/k2-cockpit-ipc.test.ts。
 *
 * 先测试后实现：`packages/core/src/cockpit/snapshot.ts` 现在还没有，整合方锁定这些测试之后才写实现。
 * 动态 import 上的 `@ts-ignore` 只为了在实现还不存在时让门禁里的 typecheck-acceptance 过得去；
 * 测试本身在实现写出来之前逐条是红的（不是靠类型检查过的）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase, ProjectService, type CoreDatabase } from '../../src/index.js';

type SourceStatus = 'ok' | 'stale' | 'missing' | 'error';

interface SourceHealth {
  status: SourceStatus;
  readAt: string;
  lastEventAt: string | null;
  note: string | null;
}

interface AttentionItem {
  kind: 'relay_down' | 'turn_unfinished' | 'relay_stale' | 'relay_stopped' | 'queue_user';
  project: string | null;
  text: string;
  since: string | null;
}

interface RunningItem {
  kind: 'relay' | 'turn' | 'paused_role';
  role: string | null;
  taskId: string | null;
  startedAt: string | null;
  until: string | null;
  text: string;
}

interface RecentEvent {
  at: string;
  role: string;
  taskId: string | null;
  outcome: 'done' | 'failed' | 'timeout' | 'quota' | 'other';
  text: string;
}

interface ProjectCard {
  id: string;
  name: string;
  status: string;
  description: string | null;
  currentState: string | null;
  updatedAt: string;
}

interface CockpitSnapshot {
  generatedAt: string;
  sources: { relay: SourceHealth; queue: SourceHealth; projects: SourceHealth };
  attention: AttentionItem[];
  running: RunningItem[];
  projects: { active: ProjectCard[]; paused: ProjectCard[]; archived: ProjectCard[] };
  recent: RecentEvent[];
  today: { finishedTurns: number };
}

type BuildCockpitSnapshot = (
  db: CoreDatabase,
  opts: { relayDir: string; ixaeonRepo: string; now?: Date },
) => CockpitSnapshot;

let buildSnapshot: BuildCockpitSnapshot | null = null;

beforeAll(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- 实现还没写；@ts-ignore 在实现写出来后也不报「多余指令」
    // @ts-ignore 实现在 packages/core/src/cockpit/snapshot.ts，锁定测试之后才写（B 档先只推测试）
    const mod = (await import('../../src/cockpit/snapshot.js')) as {
      buildCockpitSnapshot?: BuildCockpitSnapshot;
    };
    buildSnapshot =
      typeof mod.buildCockpitSnapshot === 'function' ? mod.buildCockpitSnapshot : null;
  } catch {
    buildSnapshot = null;
  }
});

/** 拿到实现；还没有实现时给出能看懂的原因，而不是一句 undefined is not a function。 */
function build(): BuildCockpitSnapshot {
  if (!buildSnapshot) {
    throw new Error(
      'buildCockpitSnapshot 还没实现：本任务是 B 档，先只推测试，实现等整合方锁定后写（见规格 K2）',
    );
  }
  return buildSnapshot;
}

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

function freshDb(dir: string): CoreDatabase {
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// 合成 relay 目录
// ---------------------------------------------------------------------------

function ledgerRow(
  turn: number,
  endedAt: Date,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    turn,
    role: 'developer',
    kind: 'developer-claim',
    taskId: String(100 + turn),
    startedAt: new Date(endedAt.getTime() - 10 * 60_000).toISOString(),
    endedAt: endedAt.toISOString(),
    exitCode: 0,
    timedOut: false,
    quotaHit: false,
    statusBefore: '待领',
    statusAfter: '进行中（dev）',
    doneLine: null,
    violations: [],
    ...extra,
  };
}

function writeLedger(relayDir: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(relayDir, 'ledger.jsonl'),
    rows.map((r) => `${JSON.stringify(r)}\n`).join(''),
    'utf8',
  );
}

function writeLock(relayDir: string, pid: number, startedAt: Date): void {
  writeFileSync(
    join(relayDir, 'lock.json'),
    `${JSON.stringify({ pid, startedAt: startedAt.toISOString() })}\n`,
    'utf8',
  );
}

/** turns/ 下 1..n 各一个目录、里面有交代文件（只让实现看目录名和修改时间，不看内容）。 */
function writeTurnDirs(relayDir: string, last: number): void {
  for (let n = 1; n <= last; n++) {
    const dir = join(relayDir, 'turns', String(n));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prompt.md'), `第 ${n} 棒的交代（合成）\n`, 'utf8');
  }
}

const hoursAgo = (now: Date, h: number): Date => new Date(now.getTime() - h * 3_600_000);

// ---------------------------------------------------------------------------
// 合成 IXAEON 仓库（队列从 origin/main 读，不从工作区读）
// ---------------------------------------------------------------------------

const QUEUE_HEADER = [
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
];

function queueMarkdown(rows: Array<{ no: string; task: string; status: string }>): string {
  return [
    '# 委派队列（合成）',
    '',
    '## 可以领的',
    '',
    ...QUEUE_HEADER,
    ...rows.map((r) => `| ${r.no} | ${r.task} | — | A | 无 | ${r.status} |`),
    '',
    '',
  ].join('\n');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 建一个 git 仓库，把队列提交成 origin/main，工作区停在提交后的状态。 */
function makeQueueRepo(md: string): string {
  const repo = tempDir('ixaeon-k2-repo-');
  mkdirSync(join(repo, 'docs', '委派'), { recursive: true });
  writeFileSync(join(repo, 'docs', '委派', '队列.md'), md, 'utf8');
  git(repo, ['init', '-q']);
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=K2 合成仓库',
    '-c',
    'user.email=k2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    '合成队列',
  ]);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

/** 条件 1、2 的 3 棒 + turns/1..4（第 4 棒没进 ledger）。 */
function seedRelayWithUnfinishedTurn(now: Date, pid: number): string {
  const relay = tempDir('ixaeon-k2-relay-');
  writeLock(relay, pid, hoursAgo(now, 5));
  writeLedger(relay, [
    // 三棒都记成已完成：`today.finishedTurns` 无论按「跑完的棒」还是「完成任务的棒」数，都应当是 3。
    ledgerRow(1, hoursAgo(now, 3), { statusAfter: '已完成（2026-10-31）' }),
    ledgerRow(2, hoursAgo(now, 2), { statusAfter: '已完成（2026-10-31）' }),
    ledgerRow(3, hoursAgo(now, 1), { statusAfter: '已完成（2026-10-31）' }),
  ]);
  writeTurnDirs(relay, 4);
  return relay;
}

const NOW = new Date('2026-10-31T12:00:00+08:00');

describe('K2 驾驶舱快照（核心）', () => {
  it('条件 1：lock 指向活着的进程 → running 有 relay 和第 4 棒，recent 3 条且最新在前', () => {
    const relay = seedRelayWithUnfinishedTurn(NOW, process.pid);
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    const relayRunning = snap.running.find((r) => r.kind === 'relay');
    expect(relayRunning, 'running 里应该有调度器').toBeTruthy();
    expect(relayRunning!.text).toContain('调度器在转');

    const turn4 = snap.running.find((r) => r.kind === 'turn');
    expect(turn4, 'turns/4 没进 ledger，应该算在跑的第 4 棒').toBeTruthy();
    expect(turn4!.text).toContain('第 4 棒');

    expect(snap.recent).toHaveLength(3);
    expect(snap.recent.map((e) => e.taskId)).toEqual(['103', '102', '101']);
    expect(snap.today.finishedTurns).toBe(3);

    // 「每个来源带读取时间和健康状态」（规格「要什么」）
    for (const health of Object.values(snap.sources)) {
      expect(['ok', 'stale', 'missing', 'error']).toContain(health.status);
      expect(Number.isNaN(Date.parse(health.readAt))).toBe(false);
    }
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });

  it('条件 2：lock 的 pid 不在 → attention 有 relay_down 和 turn_unfinished（第 4 棒）', () => {
    const relay = seedRelayWithUnfinishedTurn(NOW, 999_999);
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    const down = snap.attention.find((a) => a.kind === 'relay_down');
    expect(down, '锁文件残留、进程不在，应该提醒').toBeTruthy();
    expect(down!.text).toContain('调度器进程不在了');

    const unfinished = snap.attention.find((a) => a.kind === 'turn_unfinished');
    expect(unfinished, 'turns/4 没进 ledger、调度器又不在，应该提醒没跑完').toBeTruthy();
    expect(unfinished!.text).toContain('第 4 棒');
    expect(unfinished!.text).toContain('没有跑完');

    expect(snap.running.find((r) => r.kind === 'relay')).toBeUndefined();
    expect(snap.recent).toHaveLength(3);
  });

  it('条件 3：最后一棒 3 小时前 + 队列有待领 → stale/relay_stale；有额度暂停 → 不再 stale、running 有 paused_role', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeLedger(relay, [ledgerRow(1, hoursAgo(NOW, 3))]);
    writeFileSync(
      join(relay, 'state.json'),
      `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 1 })}\n`,
      'utf8',
    );
    const repo = makeQueueRepo(queueMarkdown([{ no: '139', task: 'K2 合成行', status: '待领' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));

    const stale = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });
    expect(stale.sources.relay.status).toBe('stale');
    const notice = stale.attention.find((a) => a.kind === 'relay_stale');
    expect(notice, '最后一棒结束超过 2 小时、队列还有待领，应该提醒可能停了').toBeTruthy();
    expect(notice!.text).toContain('可能停了');

    const until = new Date(NOW.getTime() + 60 * 60_000);
    writeFileSync(
      join(relay, 'state.json'),
      `${JSON.stringify({
        stoppedReason: null,
        pausedUntil: { developer: until.toISOString() },
        turns: 1,
      })}\n`,
      'utf8',
    );
    const paused = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });
    expect(paused.sources.relay.status).not.toBe('stale');
    expect(paused.attention.find((a) => a.kind === 'relay_stale')).toBeUndefined();
    const pausedRole = paused.running.find((r) => r.kind === 'paused_role');
    expect(pausedRole, '额度暂停中的角色应该进 running（不算要用户处理）').toBeTruthy();
    expect(pausedRole!.role).toBe('developer');
    expect(pausedRole!.until).toBe(until.toISOString());
    expect(pausedRole!.text).toContain('额度暂停');
  });

  it('条件 4：state.json 的 stoppedReason 非空 → attention 有 relay_stopped', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeFileSync(
      join(relay, 'state.json'),
      `${JSON.stringify({
        stoppedReason: '第 12 棒越界（developer）：改了不该改的',
        pausedUntil: {},
        turns: 12,
      })}\n`,
      'utf8',
    );
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    const stopped = snap.attention.find((a) => a.kind === 'relay_stopped');
    expect(stopped, 'stoppedReason 非空应该进 attention').toBeTruthy();
    expect(stopped!.text).toContain('越界');
  });

  it('条件 5：只读 origin/main 的队列，工作区改出来、没推的那一行不出现', () => {
    const onMain = {
      no: '139',
      task: 'Z5 待用户定的那一行',
      status: '等用户：待用户定',
    };
    const repo = makeQueueRepo(queueMarkdown([onMain]));
    // 工作区再改出一行，不提交、不推：只要实现读的是 origin/main，就看不见这一行。
    writeFileSync(
      join(repo, 'docs', '委派', '队列.md'),
      queueMarkdown([
        onMain,
        { no: '140', task: 'Z5b 工作区那一行', status: '等用户：工作区那一行' },
      ]),
      'utf8',
    );
    const relay = tempDir('ixaeon-k2-relay-');
    writeLock(relay, process.pid, NOW);
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    const waiting = snap.attention.filter((a) => a.kind === 'queue_user');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.text).toContain('待用户定');
    expect(waiting[0]!.text).not.toContain('工作区那一行');
  });

  it('条件 6：relay 目录不存在 → relay 为 missing，queue、projects 照常', () => {
    const missing = join(tempDir('ixaeon-k2-none-'), '根本没有这个目录');
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const dir = tempDir('ixaeon-k2-db-');
    const db = freshDb(dir);
    new ProjectService(db).create({
      name: 'K2 项目',
      rootPath: null,
      description: '合成项目',
    });
    const snap = build()(db, { relayDir: missing, ixaeonRepo: repo, now: NOW });

    expect(snap.sources.relay.status).toBe('missing');
    expect(snap.sources.relay.note).toBeTruthy();
    expect(snap.sources.queue.status).toBe('ok');
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
  });

  it('条件 7：config.json、feishu.json、turns/4/prompt.md、inbox.jsonl 的内容都不进快照', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeLock(relay, process.pid, NOW);
    writeLedger(relay, [ledgerRow(1, hoursAgo(NOW, 1))]);
    writeTurnDirs(relay, 4);
    writeFileSync(join(relay, 'turns', '4', 'prompt.md'), 'PROMPT-XYZ 这一棒要做什么\n', 'utf8');
    writeFileSync(
      join(relay, 'config.json'),
      `${JSON.stringify({ feishuAppSecret: 'SECRET-XYZ', roles: {} })}\n`,
      'utf8',
    );
    writeFileSync(
      join(relay, 'feishu.json'),
      `${JSON.stringify({ appSecret: 'SECRET-XYZ', webhook: 'SECRET-XYZ' })}\n`,
      'utf8',
    );
    writeFileSync(join(relay, 'inbox.jsonl'), '{"text":"INBOX-XYZ"}\n', 'utf8');

    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const json = JSON.stringify(build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW }));

    expect(json).not.toContain('SECRET-XYZ');
    expect(json).not.toContain('PROMPT-XYZ');
    expect(json).not.toContain('INBOX-XYZ');
  });

  it('条件 9：状态里提到「用户」的待领行不算等你处理，只有「等用户」开头的算', () => {
    const repo = makeQueueRepo(
      queueMarkdown([
        {
          no: '9',
          task: 'Z9 状态里提到用户的待领行',
          status: '待领（用户 10-25 定的：先做别的）',
        },
        { no: '10', task: 'Z10 要不要做 X', status: '等用户：要不要做 X' },
      ]),
    );
    const relay = tempDir('ixaeon-k2-relay-');
    writeLock(relay, process.pid, NOW);
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    const waiting = snap.attention.filter((a) => a.kind === 'queue_user');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.text).toContain('要不要做 X');
    expect(waiting[0]!.text).not.toContain('先做别的');
  });

  it('条件 10：不读 notify.sent；已完成的行不因旧的「等你处理」记录挂在 attention 里', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeLock(relay, process.pid, NOW);
    writeFileSync(
      join(relay, 'state.json'),
      `${JSON.stringify({
        stoppedReason: null,
        pausedUntil: {},
        turns: 20,
        notify: { sent: { 'needs-user 70': '2026-10-23T01:02:03.456Z' } },
      })}\n`,
      'utf8',
    );
    const repo = makeQueueRepo(
      queueMarkdown([{ no: '70', task: '早先的一行', status: '已完成（2026-10-23）' }]),
    );
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    expect(snap.attention.filter((a) => a.text.includes('70'))).toEqual([]);
    expect(JSON.stringify(snap)).not.toContain('2026-10-23T01:02:03.456Z');
    expect(JSON.stringify(snap)).not.toContain('needs-user 70');
  });

  it('条件 11：飞书回复棒的 statusBefore/statusAfter 不进快照，recent 写「处理了你在飞书里的回复」', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeLock(relay, process.pid, NOW);
    writeLedger(relay, [
      ledgerRow(30, hoursAgo(NOW, 1), {
        role: 'integrator',
        kind: 'integrator-inbox',
        taskId: 'inbox',
        statusBefore: 'STATUSBEFORE-XYZ',
        statusAfter: 'INBOX-SUMMARY-XYZ',
        doneLine: 'RELAY-DONE inbox INBOX-SUMMARY-XYZ',
      }),
    ]);
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    const json = JSON.stringify(snap);
    expect(json).not.toContain('INBOX-SUMMARY-XYZ');
    expect(json).not.toContain('STATUSBEFORE-XYZ');
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0]!.text).toContain('处理了你在飞书里的回复');
  });
});

// ---------------------------------------------------------------------------
// 整合方审测试时补（2026-10-31）：上面各条只测了「该出现的出现」，补「不该出现的不出现」，
// 以及规格「要什么」「约束」里写了、编号条件没单列的几处（最多 20 条、outcome、解析失败不抛错）。
// ---------------------------------------------------------------------------
describe('K2 驾驶舱快照（整合方补充）', () => {
  it('条件 1 反面：调度器活着时，第 4 棒不算没跑完、也不报锁残留；relay 为 ok', () => {
    const relay = seedRelayWithUnfinishedTurn(NOW, process.pid);
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    expect(snap.attention.filter((a) => a.kind === 'relay_down')).toEqual([]);
    expect(snap.attention.filter((a) => a.kind === 'turn_unfinished')).toEqual([]);
    expect(snap.running.filter((r) => r.kind === 'turn')).toHaveLength(1);
    expect(snap.sources.relay.status).toBe('ok');
    expect(snap.sources.queue.status).toBe('ok');
  });

  it('条件 2 反面：调度器不在时，第 4 棒不进 running', () => {
    const relay = seedRelayWithUnfinishedTurn(NOW, 999_999);
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    expect(snap.running).toEqual([]);
    expect(snap.attention.filter((a) => a.kind === 'turn_unfinished')).toHaveLength(1);
  });

  it('条件 3 的三条缺一不可：不到 2 小时、队列没有可领的 → 都不算 stale；「进行中（」也算可领', () => {
    const cases: Array<{ hours: number; status: string; stale: boolean }> = [
      { hours: 1, status: '待领', stale: false },
      { hours: 3, status: '已完成（2026-10-31）', stale: false },
      { hours: 3, status: '等用户：要不要做 X', stale: false },
      { hours: 3, status: '进行中（dev）', stale: true },
    ];
    for (const c of cases) {
      const relay = tempDir('ixaeon-k2-relay-');
      writeLedger(relay, [ledgerRow(1, hoursAgo(NOW, c.hours))]);
      writeFileSync(
        join(relay, 'state.json'),
        `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 1 })}\n`,
        'utf8',
      );
      const repo = makeQueueRepo(
        queueMarkdown([{ no: '139', task: 'K2 合成行', status: c.status }]),
      );
      const db = freshDb(tempDir('ixaeon-k2-db-'));
      const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

      const label = `${c.hours} 小时前、状态「${c.status}」`;
      expect(snap.sources.relay.status === 'stale', label).toBe(c.stale);
      expect(
        snap.attention.some((a) => a.kind === 'relay_stale'),
        label,
      ).toBe(c.stale);
      // 没有 lock.json：不是「锁残留」；stoppedReason 为空：不是「停了」。
      expect(
        snap.attention.some((a) => a.kind === 'relay_down'),
        label,
      ).toBe(false);
      expect(
        snap.attention.some((a) => a.kind === 'relay_stopped'),
        label,
      ).toBe(false);
    }
  });

  it('pausedUntil 已经过去的角色：不进 running，也挡不住 stale', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeLedger(relay, [ledgerRow(1, hoursAgo(NOW, 3))]);
    writeFileSync(
      join(relay, 'state.json'),
      `${JSON.stringify({
        stoppedReason: null,
        pausedUntil: { developer: hoursAgo(NOW, 1).toISOString() },
        turns: 1,
      })}\n`,
      'utf8',
    );
    const repo = makeQueueRepo(queueMarkdown([{ no: '139', task: 'K2 合成行', status: '待领' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    expect(snap.running.filter((r) => r.kind === 'paused_role')).toEqual([]);
    expect(snap.sources.relay.status).toBe('stale');
  });

  it('recent 最多 20 条、最新在前；outcome 照 exitCode / timedOut / quotaHit 分', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeLock(relay, process.pid, NOW);
    const rows = [];
    for (let n = 1; n <= 25; n++)
      rows.push(ledgerRow(n, new Date(NOW.getTime() - (30 - n) * 60_000)));
    rows[21] = ledgerRow(22, new Date(NOW.getTime() - 8 * 60_000), { exitCode: 1 });
    rows[22] = ledgerRow(23, new Date(NOW.getTime() - 7 * 60_000), {
      exitCode: null,
      timedOut: true,
    });
    rows[23] = ledgerRow(24, new Date(NOW.getTime() - 6 * 60_000), { exitCode: 1, quotaHit: true });
    writeLedger(relay, rows);
    const repo = makeQueueRepo(queueMarkdown([{ no: '138', task: 'K1 合成行', status: '已完成' }]));
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: repo, now: NOW });

    expect(snap.recent).toHaveLength(20);
    expect(snap.recent[0]!.taskId).toBe('125');
    expect(snap.recent[19]!.taskId).toBe('106');
    expect(snap.recent.map((e) => e.outcome).slice(0, 5)).toEqual([
      'done',
      'quota',
      'timeout',
      'failed',
      'done',
    ]);
    expect(snap.sources.relay.lastEventAt).toBe(rows[24]!.endedAt);
  });

  it('文件解析失败、仓库读不到 → 对应来源 error/missing 并写 note，不抛错，其他来源照常', () => {
    const relay = tempDir('ixaeon-k2-relay-');
    writeFileSync(join(relay, 'state.json'), '{这不是 JSON', 'utf8');
    const notRepo = tempDir('ixaeon-k2-notrepo-');
    const dir = tempDir('ixaeon-k2-db-');
    const db = freshDb(dir);
    new ProjectService(db).create({ name: 'K2 项目', rootPath: null, description: null });

    const snap = build()(db, { relayDir: relay, ixaeonRepo: notRepo, now: NOW });
    expect(snap.sources.relay.status).toBe('error');
    expect(snap.sources.relay.note).toBeTruthy();
    expect(['missing', 'error']).toContain(snap.sources.queue.status);
    expect(snap.sources.queue.note).toBeTruthy();
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
  });

  it('没给仓库路径 → queue 为 missing，relay、projects 照常', () => {
    const relay = seedRelayWithUnfinishedTurn(NOW, process.pid);
    const db = freshDb(tempDir('ixaeon-k2-db-'));
    const snap = build()(db, { relayDir: relay, ixaeonRepo: '', now: NOW });

    expect(snap.sources.queue.status).toBe('missing');
    expect(snap.sources.queue.note).toBeTruthy();
    expect(snap.sources.relay.status).toBe('ok');
    expect(snap.recent).toHaveLength(3);
  });
});
