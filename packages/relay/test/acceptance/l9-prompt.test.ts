/**
 * L9 验收测试（二）：交代（规格条件 2，对应契约第 5、9 条）。
 *
 * 逐条对应：
 * - 规划棒的交代逐字含契约第 5 条那段（照手册第 11 节排下一批活）、「这是第 N 棒。」、普通棒同样的
 *   ASK、停点那句「停点：加完行、推上 main 就停。」、最后一行「RELAY-DONE plan <加了几行>」；
 * - 普通棒的交代在「序号」那一行后面加一行任务号，逐字「任务号：<任务号>（分支、工作目录、交付说明都用它；
 *   序号只是它在队列里第几行）」——<任务号> 是任务一栏的前导词（用任务以 `L8 ` 开头的合成行测）。
 *
 * 纯函数，不调模型。
 */
import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, decideNextTurn } from '../../src/index.js';
import type { RelayState, Turn } from '../../src/index.js';
import { queueMarkdown } from './l9-harness.js';

/** 契约第 5 条那段原文（逐字）。 */
const PLAN_PARA =
  '你是整合方（统筹）。这一棒是规划棒：队列里现在没有谁能接的活。照 docs/委派/整合方手册.md 第 11 节，从 docs/三周任务单.md 里挑下一批活，最多 3 件：每件写一页规格放进 docs/委派/，在 docs/委派/队列.md 主表末尾加一行，状态写「待领」；拿不准方向的，只加一行「等用户：<一句话的问题>」，不写规格。只改 docs/ 下面的文件，不动主表里已有的行。做完照手册推到 main。';
/** 契约第 5 条：普通棒同样的那段 ASK（逐字）。 */
const ASK =
  '要用户拍板的事，不要自己定：把这一行的状态改成「等用户：<一句话说清要定什么>」，然后停。';

const planTurn = (status: 'queue-empty' | 'all-blocked'): Turn => ({
  role: 'integrator',
  kind: 'integrator-plan',
  taskId: 'plan',
  task: '找下一批活',
  status,
});

const devTurn = (over: Partial<Turn> = {}): Turn => ({
  role: 'developer',
  kind: 'developer-claim',
  taskId: '70',
  task: 'L8 relay status 打印路径时遮掉用户目录（接力的第一棒真活）',
  status: '待领',
  ...over,
});

/** 一行任务一栏以 `L8 ` 开头的合成队列（序号 70）——第 4 棒把序号当成任务号那一行。 */
const L8_QUEUE = queueMarkdown([
  {
    no: '70',
    task: 'L8 relay status 打印路径时遮掉用户目录（接力的第一棒真活）',
    tier: 'A',
    status: '待领',
  },
]);
const DEV_STATE: RelayState = { stoppedReason: null, pausedUntil: {}, turns: 0 };
const fromQueue = (now = new Date('2026-10-23T02:00:00.000Z')): Turn => {
  const r = decideNextTurn(L8_QUEUE, DEV_STATE, now);
  if ('idle' in r) throw new Error(`期望派一棒，实际是 idle=${r.idle}`);
  return r;
};

describe('条件 2：规划棒的交代', () => {
  it.each(['queue-empty', 'all-blocked'] as const)(
    '%s：逐字含契约第 5 条那段、这是第 N 棒、ASK、停点、最后一行',
    (status) => {
      const p = buildTurnPrompt(planTurn(status), { turnNumber: 3 });
      expect(p).toContain(PLAN_PARA);
      expect(p).toContain('这是第 3 棒。');
      expect(p).toContain(ASK);
      expect(p).toContain('停点：加完行、推上 main 就停。');
      expect(p).toContain('做完在最后一行输出：RELAY-DONE plan <加了几行>');
      // 整合方补（2026-10-24）：契约第 5 条的先后（那段开头、最后一行收尾），且不带普通棒的停点和行信息。
      expect(p.startsWith(PLAN_PARA)).toBe(true);
      expect(p.trimEnd().endsWith('做完在最后一行输出：RELAY-DONE plan <加了几行>')).toBe(true);
      const at = (s: string) => p.indexOf(s);
      expect(at('这是第 3 棒。')).toBeGreaterThan(at(PLAN_PARA));
      expect(at(ASK)).toBeGreaterThan(at('这是第 3 棒。'));
      expect(at('停点：加完行、推上 main 就停。')).toBeGreaterThan(at(ASK));
      expect(p).not.toContain('这一行复审完就停');
      expect(p).not.toContain('序号：');
      expect(p).not.toContain('RELAY-DONE plan <这一行现在的状态>');
      expect(p.match(/停点：/g)).toHaveLength(1);
    },
  );
});

describe('条件 2：普通棒的交代写明任务号', () => {
  it('序号那一行后面加一行「任务号：L8（…）」——任务号是任务一栏的前导词', () => {
    const p = buildTurnPrompt(fromQueue(), { turnNumber: 2 });
    expect(p).toContain(
      '序号：70\n任务号：L8（分支、工作目录、交付说明都用它；序号只是它在队列里第几行）\n任务：',
    );
    expect(p).toContain(`做完在最后一行输出：RELAY-DONE 70`);
  });

  it('普通棒的另外两种 kind 也写任务号', () => {
    const continueTurn = devTurn({ kind: 'developer-continue', status: '进行中（dev）' });
    const reviewTurn: Turn = {
      role: 'integrator',
      kind: 'integrator-review',
      taskId: '71',
      task: 'D4c 建分支失败时带上 git 的原话',
      status: '待复审（整合方）',
    };
    for (const t of [continueTurn, reviewTurn]) {
      expect(buildTurnPrompt(t, { turnNumber: 4 }), `${t.kind} 的交代里没有任务号那一行`).toContain(
        `序号：${t.taskId}\n任务号：${t.task.split(/\s+/)[0]}（分支、工作目录、交付说明都用它；序号只是它在队列里第几行）\n任务：`,
      );
    }
  });
});
