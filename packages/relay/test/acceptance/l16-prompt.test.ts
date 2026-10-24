/**
 * L16 验收测试（四）：飞书回复棒的交代（规格条件 4，对应契约第 6 条的交代）。
 *
 * 逐条对应：
 * - 交代里逐字含契约第 6 条那一段；
 * - 原话按时间先后、一行一条，写法是 `- <北京时间 月日 时:分>：<text>`；
 * - 再接普通棒的「要用户拍板」那一句（ASK）、这一棒自己的停点、最后一行。
 *
 * 纯函数调用 `buildTurnPrompt`，不起进程。原话用合成的（「76 要」）。
 */
import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../../src/prompt.js';
import type { Turn } from '../../src/types.js';

const turn: Turn = {
  role: 'integrator',
  kind: 'integrator-inbox',
  taskId: 'inbox',
  task: '用户在飞书里说的话',
  status: '2 条',
};
const messages = [
  { at: '2026-10-24T06:03:00.000Z', text: '76 要' }, // 北京 14:03
  { at: '2026-10-24T06:05:00.000Z', text: '按 V4 的新沙箱来' }, // 北京 14:05
];

describe('条件 4：飞书回复棒的交代', () => {
  const prompt = buildTurnPrompt(turn, { turnNumber: 7, inboxMessages: messages });

  it('逐字含契约第 6 条那一段', () => {
    expect(prompt).toContain(
      '你是整合方（统筹）。这一棒是飞书回复棒：用户在飞书里给调度器发了下面这些话，' +
        '照 AGENTS.md 和 docs/委派/整合方手册.md 处理。多半是在回答队列里「等用户」的那几行：' +
        '把用户的决定写进去（改那一行的状态、要的话写规格、加行），决定记进三周任务单' +
        '（原话里有名字、地址、密钥这类个人信息的不要抄进仓库，只记决定）。' +
        '看不懂的，或者用户要的事得动 docs/ 以外的东西，加一行「等用户：<你的问题>」问回去。' +
        '只改 docs/ 下面的文件。做完照手册推到 main。',
    );
  });

  it('原话按时间先后、一行一条，北京时间 月日 时:分', () => {
    const i1 = prompt.indexOf('- 10月24日 14:03：76 要');
    const i2 = prompt.indexOf('- 10月24日 14:05：按 V4 的新沙箱来');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
  });

  it('再接普通棒的 ASK、这一棒的停点、最后一行；最后一行是 RELAY-DONE inbox', () => {
    expect(prompt).toContain(
      '要用户拍板的事，不要自己定：把这一行的状态改成「等用户：<一句话说清要定什么>」，然后停。',
    );
    expect(prompt).toContain('停点：处理完这几条、推上 main 就停。');
    expect(
      prompt.trimEnd().endsWith('做完在最后一行输出：RELAY-DONE inbox <一句话说你做了什么>'),
    ).toBe(true);
  });

  it('不是普通复审棒的交代（没有「这一棒只做队列里的一行」那段）', () => {
    expect(prompt).not.toContain('这一棒只做队列里的一行');
  });
});
