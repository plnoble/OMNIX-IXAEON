/**
 * L16 验收测试（三）：下一棒优先派飞书回复棒（规格条件 3，对应契约第 6 条的派活）。
 *
 * 逐条对应：
 * - `inbox.jsonl` 有没办的（`inboxPending > 0`）→ 先派飞书回复棒，哪怕同时有「待复审（整合方）」的行；
 * - 都办过了（没有 pending）→ 照原来（复审行派复审、待领派开发、都没有才轮到规划/空转）；
 * - 整合方在歇 → 不派（等它歇完）。
 *
 * 纯函数调用 `decideNextTurn`，不起进程、不连飞书。
 */
import { describe, expect, it } from 'vitest';
import { decideNextTurn } from '../../src/queue.js';
import type { RelayState } from '../../src/types.js';

const NOW = new Date('2026-10-24T04:00:00.000Z'); // 北京时间中午
const state = (o: Partial<RelayState> = {}): RelayState =>
  ({ stoppedReason: null, pausedUntil: {}, turns: 0, ...o }) as RelayState;
const md = (status70: string): string =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    `| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | ${status70} |`,
    '',
  ].join('\n');

describe('条件 3：飞书回复棒的派活', () => {
  it('有没办的 → 先派飞书回复棒，哪怕同时有「待复审（整合方）」的行', () => {
    const t = decideNextTurn(md('测试待审（整合方）'), state(), NOW, { inboxPending: 2 });
    expect(t).toMatchObject({
      role: 'integrator',
      kind: 'integrator-inbox',
      taskId: 'inbox',
      task: '用户在飞书里说的话',
      status: '2 条',
    });
  });

  it('有没办的 → 哪怕同时有开发能领的行，也是先派飞书回复棒', () => {
    const t = decideNextTurn(md('待领'), state(), NOW, { inboxPending: 1 });
    expect(t).toMatchObject({ role: 'integrator', kind: 'integrator-inbox', taskId: 'inbox' });
  });

  it('都办过了（没有 pending）→ 照原来', () => {
    const review = decideNextTurn(md('测试待审（整合方）'), state(), NOW);
    expect(review).toMatchObject({ role: 'integrator', kind: 'integrator-review', taskId: '70' });
    const claim = decideNextTurn(md('待领'), state(), NOW);
    expect(claim).toMatchObject({ role: 'developer', kind: 'developer-claim', taskId: '70' });
  });

  it('整合方在歇 → 不派（等它歇完）', () => {
    const t = decideNextTurn(
      md('测试待审（整合方）'),
      state({ pausedUntil: { integrator: '2999-01-01T00:00:00.000Z' } }),
      NOW,
      { inboxPending: 3 },
    );
    expect(t).not.toMatchObject({ kind: 'integrator-inbox' });
  });

  it('inboxPending 是 runOnce 算出来的（opts 加 inboxPending），不给就当 0', () => {
    const t = decideNextTurn(md('测试待审（整合方）'), state(), NOW, {});
    expect(t).toMatchObject({ kind: 'integrator-review' });
  });
});
