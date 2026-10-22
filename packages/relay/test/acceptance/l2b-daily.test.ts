/**
 * L2b 验收测试（二）：日报（规格条件 6，对应契约第 4 条的两个纯函数）。
 *
 * 逐条对应：
 * - 条件 6：`dailyDue`：北京时间 20:59 → `null`；21:00 → 今天的日期；`lastDailyDate` 已经是今天 → `null`；
 *   第二天 21:00 → 第二天的日期。
 * - `dailyEvent`：合成的记账跨两天、有重复完成的行、有的棒没有 `costUsd` → 只算那一天的、完成的任务去重、
 *   `costUsd` 加总；那天一棒都没有 → `turns: 0`、`done: []`、不带 `costUsd`。
 *
 * 纯函数，不调真模型、不碰文件。
 */
import { describe, expect, it } from 'vitest';
import { dailyDue, dailyEvent, type LedgerEntry, type RelayState } from '../../src/index.js';

const state = (over: Partial<RelayState> = {}): RelayState => ({
  stoppedReason: null,
  pausedUntil: {},
  turns: 0,
  ...over,
});

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  turn: 1,
  role: 'developer',
  kind: 'developer-claim',
  taskId: '70',
  startedAt: '2026-10-21T10:00:00.000Z',
  endedAt: '2026-10-21T10:05:00.000Z',
  exitCode: 0,
  timedOut: false,
  quotaHit: false,
  statusBefore: '待领',
  statusAfter: '已完成（2026-10-21）',
  doneLine: 'RELAY-DONE 70 已完成（2026-10-21）',
  violations: [],
  ...over,
});

describe('条件 6：dailyDue', () => {
  it('北京时间 20:59 → null；21:00 → 今天的日期', () => {
    expect(dailyDue(state(), new Date('2026-10-21T12:59:00.000Z'))).toBeNull();
    expect(dailyDue(state(), new Date('2026-10-21T13:00:00.000Z'))).toBe('10月21日');
  });

  it('lastDailyDate 已经是今天 → null；第二天 21:00 → 第二天的日期', () => {
    const sent = state({ lastDailyDate: '10月21日' });
    expect(dailyDue(sent, new Date('2026-10-21T14:00:00.000Z'))).toBeNull();
    expect(dailyDue(sent, new Date('2026-10-22T13:00:00.000Z'))).toBe('10月22日');
  });
});

describe('条件 6：dailyEvent', () => {
  const ledger: LedgerEntry[] = [
    entry({
      turn: 1,
      startedAt: '2026-10-21T02:00:00.000Z',
      statusAfter: '已完成（2026-10-21）',
      taskId: '70',
      usage: { costUsd: 0.1 },
    }),
    entry({
      turn: 2,
      startedAt: '2026-10-21T06:00:00.000Z',
      statusAfter: '已完成（2026-10-21）',
      taskId: '70',
      usage: { costUsd: 0.2 },
    }),
    entry({
      turn: 3,
      startedAt: '2026-10-21T08:00:00.000Z',
      statusAfter: '已完成（2026-10-21）',
      taskId: '71',
    }),
    entry({
      turn: 4,
      startedAt: '2026-10-21T10:00:00.000Z',
      statusAfter: '进行中（dev）',
      taskId: '72',
      usage: { costUsd: 0.05 },
    }),
    entry({
      turn: 5,
      startedAt: '2026-10-22T01:00:00.000Z',
      statusAfter: '已完成（2026-10-22）',
      taskId: '73',
      usage: { costUsd: 9 },
    }),
  ];

  it('只算那一天的、完成的任务去重、costUsd 加总', () => {
    const e = dailyEvent(ledger, '10月21日');
    expect(e).toMatchObject({
      kind: 'daily',
      date: '10月21日',
      turns: 4,
      done: ['70', '71'],
      costUsd: 0.35,
    });
  });

  it('那天一棒都没有 → turns 0、done 空、不带 costUsd', () => {
    const e = dailyEvent(ledger, '10月20日');
    expect(e).toEqual({ kind: 'daily', date: '10月20日', turns: 0, done: [] });
    expect('costUsd' in e).toBe(false);
  });
});
