/**
 * K2 驾驶舱快照：整合方复审时补的 2 条（规格 docs/委派/K2-驾驶舱快照.md）。
 *
 * 变异检查里两处改坏了也不红，补在这里：
 * - 条件 5 / 契约「只认 origin/main」：本地提交了、没推的那一行也不能出现（读 HEAD 代替 origin/main 要红）。
 * - 「today.finishedTurns 按北京时间的当天数」（审测试时的提醒，照 relay 的 beijingDay）：
 *   北京时间 0 点到 8 点之间，UTC 还是前一天，按 UTC 数要红。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCockpitSnapshot } from '../../src/cockpit/snapshot.js';
import { migrate, openDatabase, type CoreDatabase } from '../../src/index.js';

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

function freshDb(): CoreDatabase {
  const db = openDatabase(join(tempDir('ixaeon-k2r-db-'), 'ixaeon.db'));
  migrate(db);
  return db;
}

function queueMarkdown(rows: Array<{ no: string; task: string; status: string }>): string {
  return [
    '# 委派队列（合成）',
    '',
    '## 可以领的',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    ...rows.map((r) => `| ${r.no} | ${r.task} | — | A | 无 | ${r.status} |`),
    '',
  ].join('\n');
}

function commit(repo: string, md: string, message: string): void {
  writeFileSync(join(repo, 'docs', '委派', '队列.md'), md, 'utf8');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['add', '.']);
  git([
    '-c',
    'user.name=K2 合成仓库',
    '-c',
    'user.email=k2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    message,
  ]);
}

describe('K2 驾驶舱快照（整合方复审补充）', () => {
  it('条件 5：本地提交了、没推到 origin/main 的那一行不出现', () => {
    const repo = tempDir('ixaeon-k2r-repo-');
    mkdirSync(join(repo, 'docs', '委派'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    const onMain = { no: '139', task: 'Z5 在 origin/main 上的行', status: '等用户：main 上那一行' };
    commit(repo, queueMarkdown([onMain]), '合成队列');
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], {
      cwd: repo,
      stdio: 'ignore',
    });
    commit(
      repo,
      queueMarkdown([onMain, { no: '140', task: 'Z5c 本地提交的行', status: '等用户：本地那一行' }]),
      '本地提交，没推',
    );
    const relay = tempDir('ixaeon-k2r-relay-');
    const snap = buildCockpitSnapshot(freshDb(), {
      relayDir: relay,
      ixaeonRepo: repo,
      now: new Date('2026-10-31T12:00:00+08:00'),
    });
    const waiting = snap.attention.filter((a) => a.kind === 'queue_user');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.text).toContain('main 上那一行');
    expect(JSON.stringify(snap)).not.toContain('本地那一行');
  });

  it('today.finishedTurns 按北京时间的当天数（北京 0–8 点 UTC 还是前一天）', () => {
    const relay = tempDir('ixaeon-k2r-relay-');
    const row = (turn: number, endedAt: string) => ({
      turn,
      role: 'developer',
      kind: 'developer-claim',
      taskId: String(100 + turn),
      startedAt: endedAt,
      endedAt: new Date(endedAt).toISOString(),
      exitCode: 0,
      timedOut: false,
      quotaHit: false,
      statusBefore: '待领',
      statusAfter: '进行中（dev）',
    });
    writeFileSync(
      join(relay, 'ledger.jsonl'),
      [
        row(1, '2026-10-30T23:30:00+08:00'), // 北京 10-30（UTC 10-30）：不算今天
        row(2, '2026-10-31T00:30:00+08:00'), // 北京 10-31（UTC 还是 10-30）：算今天
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
      'utf8',
    );
    const snap = buildCockpitSnapshot(freshDb(), {
      relayDir: relay,
      ixaeonRepo: '',
      now: new Date('2026-10-31T01:00:00+08:00'),
    });
    expect(snap.today.finishedTurns).toBe(1);
  });
});
