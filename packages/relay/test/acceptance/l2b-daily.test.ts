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

  // 整合方补（2026-10-22）：北京时间第二天凌晨（UTC 还是前一天）还在「第二天」，没到 21:00 → null
  it('北京时间 10月22日 00:30（UTC 还是 21 日）→ null；23:59 且今天没发过 → 今天', () => {
    const sent = state({ lastDailyDate: '10月21日' });
    expect(dailyDue(sent, new Date('2026-10-21T16:30:00.000Z'))).toBeNull();
    expect(dailyDue(state(), new Date('2026-10-21T15:59:00.000Z'))).toBe('10月21日');
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

  // 整合方改（2026-10-22）：日报里写任务名，不写序号——dailyEvent 多收一份队列，按序号查「任务」那一格，
  // 查不到写「第 <序号> 行」（见规格末尾整合方的补充）。costUsd 是浮点数加总，用 toBeCloseTo。
  const QUEUE = [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    '| 70 | L7 合成的一行 | [L7](L7.md) | A | 无 | 已完成（2026-10-21） |',
    '| 72 | L9 还在做的一行 | [L9](L9.md) | A | 无 | 进行中（dev） |',
    '',
  ].join('\n');

  it('只算那一天的、完成的任务去重（写任务名）、costUsd 加总', () => {
    const e = dailyEvent(ledger, '10月21日', QUEUE);
    expect(e).toMatchObject({
      kind: 'daily',
      date: '10月21日',
      turns: 4,
      done: ['L7 合成的一行', '第 71 行'],
    });
    expect(e.kind === 'daily' && e.costUsd).toBeCloseTo(0.35, 10);
  });

  it('那天一棒都没有 → turns 0、done 空、不带 costUsd', () => {
    const e = dailyEvent(ledger, '10月20日', QUEUE);
    expect(e).toEqual({ kind: 'daily', date: '10月20日', turns: 0, done: [] });
    expect('costUsd' in e).toBe(false);
  });

  // 整合方补（2026-10-22）：「那一天」是北京时间的日历日，不是 UTC 的
  it('北京时间跨天：UTC 前一天 17:00 算北京的第二天，UTC 当天 16:30 算北京的下一天', () => {
    const edge: LedgerEntry[] = [
      entry({ turn: 1, startedAt: '2026-10-20T17:00:00.000Z', taskId: '70' }), // 北京 10月21日 01:00
      entry({ turn: 2, startedAt: '2026-10-21T15:59:00.000Z', taskId: '70' }), // 北京 10月21日 23:59
      entry({ turn: 3, startedAt: '2026-10-21T16:30:00.000Z', taskId: '72' }), // 北京 10月22日 00:30
    ];
    expect(dailyEvent(edge, '10月21日', QUEUE)).toMatchObject({
      turns: 2,
      done: ['L7 合成的一行'],
    });
    expect(dailyEvent(edge, '10月22日', QUEUE)).toMatchObject({ turns: 1 });
  });

  it('当天的棒都没有 costUsd → 不带 costUsd', () => {
    const e = dailyEvent([entry({ startedAt: '2026-10-21T02:00:00.000Z' })], '10月21日', QUEUE);
    expect(e).toMatchObject({ turns: 1 });
    expect('costUsd' in e).toBe(false);
  });
});
