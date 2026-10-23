/**
 * L9 验收测试（一）：没活时派规划棒（规格条件 1，对应契约第 3、4 条）。
 *
 * 逐条对应：
 * - `queue-empty`、`all-blocked` 两种都派规划棒（Turn 的形状照契约第 1 条：role integrator、
 *   kind integrator-plan、taskId plan、task 找下一批活、status 是原来要回的 idle 原因）；
 * - `planPerDay` 没配 / 不大于 0、整合方在歇、当天次数到了、队列和上次一字不差 → 各自照原来回 idle；
 * - 换了北京日次数重算：昨天已经派满、队列也没变，今天照样派；
 * - `all-paused`、`stopped` 不规划；
 * - `runOnce` 把 `config.planPerDay` 传进去；派了规划棒就更新 `state.plan`（北京日子、当天次数、
 *   队列全文的 sha256），同一个北京日里队列没变就不再规划。
 *
 * 纯函数 + 临时合成仓库（替身当整合方），不调真模型、不连 GitHub。
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { decideNextTurn } from '../../src/index.js';
import type { Idle, RelayState, Turn } from '../../src/index.js';
import {
  BLOCKED_ROWS,
  DONE_ROWS,
  makeL9World,
  queueMarkdown,
  TODAY,
  YESTERDAY,
  type World,
} from './l9-harness.js';

const worlds: World[] = [];
const world = (opts: Parameters<typeof makeL9World>[0] = {}) => {
  const w = makeL9World(opts);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

/** 北京时间 2026-10-23 10:00。 */
const NOW = new Date('2026-10-23T02:00:00.000Z');
type Plan = { date: string; count: number; queueHash: string };
type State = RelayState & { plan?: Plan };

const state = (over: Partial<State> = {}): State => ({
  stoppedReason: null,
  pausedUntil: {},
  turns: 1,
  ...over,
});
const hashOf = (md: string) => createHash('sha256').update(md, 'utf8').digest('hex');
const otherHash = 'b'.repeat(64);

const asTurn = (r: Turn | Idle): Turn => {
  if ('idle' in r) throw new Error(`期望派一棒，实际是 idle=${r.idle}`);
  return r;
};
const asIdle = (r: Turn | Idle): Idle => {
  if (!('idle' in r)) throw new Error(`期望停住，实际派了 ${r.kind}`);
  return r;
};

// 真队列经 `readMainQueue`（`git show` 的输出会 trim）到这里，末尾没有多余的空白；
// 这样 `hashOf` 对「按原文算」和「按 trim 后算」两种写法结果一样，不把实现的规范化方式钉死。
const EMPTY = queueMarkdown(DONE_ROWS).trimEnd();
const BLOCKED = queueMarkdown(BLOCKED_ROWS).trimEnd();

describe('条件 1：什么时候派规划棒', () => {
  it('queue-empty、没配 planPerDay（或 0、负数）→ 照原来回 queue-empty', () => {
    expect(asIdle(decideNextTurn(EMPTY, state(), NOW)).idle).toBe('queue-empty');
    expect(asIdle(decideNextTurn(EMPTY, state(), NOW, { planPerDay: 0 })).idle).toBe('queue-empty');
    expect(asIdle(decideNextTurn(EMPTY, state(), NOW, { planPerDay: -1 })).idle).toBe(
      'queue-empty',
    );
  });

  it('all-blocked、没配 planPerDay（或 0）→ 照原来回 all-blocked', () => {
    expect(asIdle(decideNextTurn(BLOCKED, state(), NOW)).idle).toBe('all-blocked');
    expect(asIdle(decideNextTurn(BLOCKED, state(), NOW, { planPerDay: 0 })).idle).toBe(
      'all-blocked',
    );
  });

  it('queue-empty、planPerDay 2、没派过 → 派规划棒（Turn 形状照契约第 1 条）', () => {
    expect(asTurn(decideNextTurn(EMPTY, state(), NOW, { planPerDay: 2 }))).toEqual({
      role: 'integrator',
      kind: 'integrator-plan',
      taskId: 'plan',
      task: '找下一批活',
      status: 'queue-empty',
    });
  });

  it('all-blocked 也派，status 是 all-blocked', () => {
    expect(asTurn(decideNextTurn(BLOCKED, state(), NOW, { planPerDay: 2 }))).toMatchObject({
      role: 'integrator',
      kind: 'integrator-plan',
      taskId: 'plan',
      status: 'all-blocked',
    });
  });

  it('整合方在歇 → 不派（queue-empty、all-blocked 两种都试）', () => {
    const paused = state({ pausedUntil: { integrator: '2026-10-23T12:00:00+08:00' } });
    expect(asIdle(decideNextTurn(EMPTY, paused, NOW, { planPerDay: 2 })).idle).toBe('queue-empty');
    expect(asIdle(decideNextTurn(BLOCKED, paused, NOW, { planPerDay: 2 })).idle).toBe(
      'all-blocked',
    );
  });

  it('当天已经派满 planPerDay 棒 → 不派', () => {
    const atLimit = state({ plan: { date: TODAY, count: 2, queueHash: otherHash } });
    expect(asIdle(decideNextTurn(EMPTY, atLimit, NOW, { planPerDay: 2 })).idle).toBe('queue-empty');
  });

  it('当天还没派满、队列和上次不一样 → 派', () => {
    const one = state({ plan: { date: TODAY, count: 1, queueHash: otherHash } });
    expect(asTurn(decideNextTurn(EMPTY, one, NOW, { planPerDay: 2 })).kind).toBe('integrator-plan');
  });

  it('队列和上一次派规划棒时一字不差 → 不派（哪怕当天次数还没到）', () => {
    const same = state({ plan: { date: TODAY, count: 0, queueHash: hashOf(EMPTY) } });
    expect(asIdle(decideNextTurn(EMPTY, same, NOW, { planPerDay: 2 })).idle).toBe('queue-empty');
  });

  it('换了北京日 → 次数重算，照样派（昨天派满、队列没变也派）', () => {
    const yesterday = state({ plan: { date: YESTERDAY, count: 5, queueHash: hashOf(EMPTY) } });
    expect(asTurn(decideNextTurn(EMPTY, yesterday, NOW, { planPerDay: 2 })).kind).toBe(
      'integrator-plan',
    );
  });

  it('北京日按北京时间算，不按 UTC：UTC 10月23日 16:30 已经是北京 10月24日', () => {
    const lateUtc = new Date('2026-10-23T16:30:00.000Z');
    const yesterday = state({ plan: { date: TODAY, count: 2, queueHash: otherHash } });
    expect(asTurn(decideNextTurn(EMPTY, yesterday, lateUtc, { planPerDay: 2 })).kind).toBe(
      'integrator-plan',
    );
  });

  it('stopped 不规划', () => {
    const stopped = state({ stoppedReason: '第 3 棒越界（integrator）：plan-touched-code' });
    expect(asIdle(decideNextTurn(EMPTY, stopped, NOW, { planPerDay: 2 })).idle).toBe('stopped');
  });

  it('两个角色都在歇 → all-paused，不规划', () => {
    const both = state({
      pausedUntil: {
        integrator: '2026-10-23T12:00:00+08:00',
        developer: '2026-10-23T12:00:00+08:00',
      },
    });
    expect(asIdle(decideNextTurn(EMPTY, both, NOW, { planPerDay: 2 })).idle).toBe('all-paused');
  });
});

describe('条件 1（契约第 4 条）：runOnce 传 planPerDay、更新 state.plan', () => {
  it('没配 planPerDay：没活就照原来空转，不派规划棒、不记账', async () => {
    const w = world();
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('没活：queue-empty');
    expect(w.ledger()).toHaveLength(0);
    expect(w.state().turns).toBe(0);
    expect(w.state().plan).toBeUndefined();
  }, 120_000);

  it('派了规划棒：state.plan 记下北京日子、当天 1 次、队列全文的 sha256', async () => {
    const w = world({ planPerDay: 2 });
    w.writePlan({
      rows: [
        { no: '73', task: 'L11 合成的第一件', status: '待领' },
        { no: '74', task: 'L12 合成的第二件', status: '待领' },
      ],
      message: '规划：排两件',
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const st = w.state() as { plan?: Plan; turns: number };
    expect(st.turns).toBe(1);
    expect(st.plan?.date).toBe(TODAY);
    expect(st.plan?.count).toBe(1);
    expect(st.plan?.queueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(w.ledger()).toHaveLength(1);
  }, 120_000);

  it('同一个北京日、队列没变：第二次没活就不再规划', async () => {
    const w = world({ planPerDay: 2 });
    // 替身一行都不加：队列和上一次派规划棒时一字不差
    w.writePlan({ rows: [] });
    expect((await w.run(['once'])).status).toBe(0);
    expect(w.ledger()).toHaveLength(1);
    const saved = w.state().plan;
    expect(saved).toBeTruthy();

    const second = await w.run(['once']);
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(second.stdout).toContain('没活：queue-empty');
    expect(w.ledger()).toHaveLength(1);
    expect(w.state().turns).toBe(1);
    expect(w.state().plan).toEqual(saved);
  }, 120_000);

  it('换了北京日：昨天派满 5 次也照样派，count 从 1 起', async () => {
    const w = world({
      planPerDay: 2,
      state: { plan: { date: YESTERDAY, count: 5, queueHash: otherHash } },
    });
    w.writePlan({ rows: [] });
    expect((await w.run(['once'])).status).toBe(0);
    expect(w.ledger()).toHaveLength(1);
    const st = w.state() as { plan?: Plan };
    expect(st.plan?.date).toBe(TODAY);
    expect(st.plan?.count).toBe(1);
  }, 120_000);

  it('整合方在歇：没活也不派规划棒', async () => {
    const w = world({
      planPerDay: 2,
      state: { pausedUntil: { integrator: '2999-01-01T00:00:00.000Z' } },
    });
    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('没活：queue-empty');
    expect(w.ledger()).toHaveLength(0);
    expect(w.state().plan).toBeUndefined();
  }, 120_000);
});
