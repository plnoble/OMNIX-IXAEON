/**
 * K9b 验收测试（一）：定下一棒、交代（规格 docs/委派/K9b-整合方顶班.md 条件 1、2、3、5）。
 *
 * 逐条对应：
 * - 条件 1：整合方在歇、配了替补、队列有一行「待复审（整合方）」→ 派给 integrator-substitute；
 *   整合方没在歇 → 照旧派给整合方；交代里含「你是替补整合方」那段。
 * - 条件 2：那一行状态已含「替补审过」→ 替补不接、看下一行；全都审过 → 没活（idle）。
 * - 条件 3：没配替补 → 和现在一模一样（整合方在歇就不派整合方的活）。
 * - 条件 5：整合方在歇时不派规划棒给替补（哪怕到了规划的点）。
 *
 * 全是合成队列、纯函数调用；不碰文件、不调模型。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTurnPrompt,
  decideNextTurn,
  type Idle,
  type RelayState,
  type Turn,
} from '../../src/index.js';

const row = (no: string, task: string, tier: string, deps: string, status: string) =>
  `| ${no}   | ${task} | [x](x.md) | ${tier}    | ${deps} | ${status} |`;

const queue = (rows: string[]) =>
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    ...rows,
    '',
  ].join('\n');

const NOW = new Date('2026-10-31T10:00:00+08:00');
const PAUSED = '2026-11-01T04:30:00+08:00';
const state = (over: Partial<RelayState> = {}): RelayState => ({
  stoppedReason: null,
  pausedUntil: {},
  turns: 0,
  ...over,
});
const pausedIntegrator = (over: Partial<RelayState> = {}) =>
  state({ pausedUntil: { integrator: PAUSED }, ...over });

const asTurn = (r: Turn | Idle): Turn => {
  if ('idle' in r) throw new Error(`期望给一棒，实际是 idle=${r.idle}`);
  return r;
};
const asIdle = (r: Turn | Idle): Idle => {
  if (!('idle' in r)) throw new Error(`期望停住，实际给了第 ${r.taskId} 行`);
  return r;
};

const reviewQueue = queue([
  row('1', 'K9b 待复审的一行', 'B', '无', '待复审（整合方）'),
  row('2', 'K9c 进行中的一行', 'A', '无', '进行中（dev）'),
]);

const claudeTurn: Turn = {
  role: 'integrator',
  kind: 'integrator-review',
  taskId: '1',
  task: 'K9b 待复审的一行',
  status: '待复审（整合方）',
};

const substituteTurn: Turn = {
  role: 'integrator-substitute',
  kind: 'integrator-review',
  taskId: '1',
  task: 'K9b 待复审的一行',
  status: '待复审（整合方）',
};

describe('条件 1：整合方在歇时改派替补', () => {
  it('配了替补 + 整合方在歇 → 派给 integrator-substitute（kind 照旧 integrator-review）', () => {
    expect(
      asTurn(decideNextTurn(reviewQueue, pausedIntegrator(), NOW, { integratorSubstitute: true })),
    ).toMatchObject({
      role: 'integrator-substitute',
      kind: 'integrator-review',
      taskId: '1',
      status: '待复审（整合方）',
    });
  });

  it('整合方没在歇 → 照旧派给整合方（哪怕配了替补）', () => {
    expect(
      asTurn(decideNextTurn(reviewQueue, state(), NOW, { integratorSubstitute: true })),
    ).toMatchObject({ role: 'integrator', kind: 'integrator-review', taskId: '1' });
  });

  it('交代里含「你是替补整合方」那段（能做 / 不能做）、标签、只许 integrate-sub/，最后一行仍是 RELAY-DONE', () => {
    const prompt = buildTurnPrompt(substituteTurn, {
      turnNumber: 78,
      pushByRelay: true,
      cwd: 'D:\\合成\\integrate',
      substituteLabel: 'DSH + 合成/模型',
    });
    expect(prompt).toContain('你是替补整合方（DSH + 合成/模型）');
    expect(prompt).toContain('替补整合方预审');
    expect(prompt).toContain('不合 main、不锁验收测试');
    expect(prompt).toContain('不写迁移');
    expect(prompt).toContain('integrate-sub/');
    expect(prompt).not.toContain('以 dev/ 开头');
    // 开发那层「你的仓库是 <cwd>/repo」不该跟着进替补的交代（替补在整合方的工作目录里干）
    expect(prompt).not.toContain('你的仓库是');
    expect(prompt.trimEnd().endsWith('RELAY-DONE 1 <这一行现在的状态>')).toBe(true);
  });

  it('整合方的交代不变：没有「你是替补整合方」那段', () => {
    const prompt = buildTurnPrompt(claudeTurn, { turnNumber: 1, pushByRelay: false });
    expect(prompt).not.toContain('你是替补整合方');
    expect(prompt).not.toContain('integrate-sub/');
  });
});

describe('条件 2：已经「替补审过」的行不再接', () => {
  it('第一行含「替补审过」→ 看下一行', () => {
    const md = queue([
      row('1', 'K9b 审过的一行', 'B', '无', '待复审（整合方）：替补审过（10月31日）：没问题'),
      row('2', 'K9c 没审过的一行', 'B', '无', '测试待审（整合方）'),
    ]);
    expect(
      asTurn(decideNextTurn(md, pausedIntegrator(), NOW, { integratorSubstitute: true })),
    ).toMatchObject({ role: 'integrator-substitute', taskId: '2' });
  });

  it('全都「替补审过」→ 没活（idle），不派替补', () => {
    const md = queue([
      row('1', 'K9b 审过的一行', 'B', '无', '待复审（整合方）：替补审过（10月31日）：没问题'),
      row('2', 'K9c 也审过', 'B', '无', '测试待审（整合方）：替补审过（10月31日）：改了测试'),
    ]);
    const r = decideNextTurn(md, pausedIntegrator(), NOW, { integratorSubstitute: true });
    expect('idle' in r).toBe(true);
  });

  it('替补自己也在歇 → 不接（开发照常）', () => {
    const st = pausedIntegrator({
      pausedUntil: { integrator: PAUSED, 'integrator-substitute': PAUSED },
    });
    expect(
      asTurn(decideNextTurn(reviewQueue, st, NOW, { integratorSubstitute: true })),
    ).toMatchObject({ role: 'developer', taskId: '2' });
  });
});

describe('条件 3：没配替补时和现在一模一样', () => {
  it('整合方在歇、没配替补 → 不派整合方的活，仍然给开发', () => {
    expect(asTurn(decideNextTurn(reviewQueue, pausedIntegrator(), NOW))).toMatchObject({
      role: 'developer',
      taskId: '2',
    });
  });

  it('整合方在歇、没配替补、只有待复审那一行 → all-blocked（不派替补）', () => {
    const only = queue([row('1', 'K9b 待复审的一行', 'B', '无', '待复审（整合方）')]);
    expect(asIdle(decideNextTurn(only, pausedIntegrator(), NOW)).idle).toBe('all-blocked');
  });

  it('写成半个替补（argv 不合法）当作没配：substituteConfig 回 null', async () => {
    const { substituteConfig } = await import('../../src/index.js');
    const base = {
      idleSeconds: 60,
      roles: {
        integrator: {
          argv: ['x'],
          cwd: '.',
          timeoutMinutes: 1,
          quotaPatterns: [],
          quotaPauseMinutes: 1,
        },
        developer: {
          argv: ['x'],
          cwd: '.',
          timeoutMinutes: 1,
          quotaPatterns: [],
          quotaPauseMinutes: 1,
        },
        integratorSubstitute: { argv: [], label: 'DSH + 合成/模型' },
      },
    };
    expect(substituteConfig(base as never)).toBeNull();
  });
});

describe('条件 5：规划棒不派给替补', () => {
  const allDone = queue([row('1', 'K9b 做完了', 'A', '无', '已完成（2026-10-31）')]);

  it('整合方在歇 + 配了替补 + 到了规划的点 → 不派规划棒', () => {
    const r = decideNextTurn(allDone, pausedIntegrator(), NOW, {
      planPerDay: 2,
      integratorSubstitute: true,
    });
    expect('idle' in r).toBe(true);
  });

  it('整合方当班 → 照旧派规划棒（K9b 没改 L9 的行为）', () => {
    expect(
      asTurn(decideNextTurn(allDone, state(), NOW, { planPerDay: 2, integratorSubstitute: true })),
    ).toMatchObject({ role: 'integrator', kind: 'integrator-plan' });
  });
});

describe('条件 4：替补的飞书回复棒交代', () => {
  const inboxTurn: Turn = {
    role: 'integrator-substitute',
    kind: 'integrator-inbox',
    taskId: 'inbox',
    task: '用户在飞书里说的话',
    status: '1 条',
  };
  const prompt = buildTurnPrompt(inboxTurn, {
    turnNumber: 3,
    pushByRelay: true,
    cwd: 'D:\\合成\\integrate',
    substituteLabel: 'DSH + 合成/模型',
    inboxMessages: [{ at: '2026-10-31T02:00:00.000Z', text: '合成的一条' }],
  });

  it('开头是替补那段、正文是现有的回复棒、推送只许 integrate-sub/', () => {
    expect(prompt).toContain('你是替补整合方（DSH + 合成/模型）');
    expect(prompt).toContain('这一棒是飞书回复棒');
    expect(prompt).toContain('- 10月31日 10:00：合成的一条');
    expect(prompt).toContain('以 integrate-sub/ 开头');
    expect(
      prompt.trimEnd().endsWith('做完在最后一行输出：RELAY-DONE inbox <一句话说你做了什么>'),
    ).toBe(true);
  });

  it('交代里不出现「你是整合方（统筹）」（别名顶班，不冒充本人）', () => {
    expect(prompt).not.toContain('你是整合方（统筹）');
  });
});
