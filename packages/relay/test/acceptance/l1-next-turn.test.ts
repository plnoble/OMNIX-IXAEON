/**
 * L1 验收测试（一）：看队列定下一棒（规格 docs/委派/L1-接力调度器核心.md 条件 1、2、3，以及条件 7 里
 * 「撞了额度的角色被跳过 / 到点又能轮到」那半条）。
 *
 * 逐条对应：
 * - 条件 1：合成的队列里同时有「待复审（整合方）」「进行中（dev）」「待领」三行 → 先给整合方；
 *   整合方在歇着 → 给开发「进行中」那行；没有「进行中」→ 给开发第一个依赖都完成的「待领」。
 * - 条件 2：「无」「无（说明）」没依赖；「P5 ✅」算完成；「D2c」去表里找、状态「已完成（…）」才算；
 *   依赖没完成的「待领」跳过、去看下一行；全被挡着 → all-blocked。
 * - 条件 3：「暂停（…）」「已完成（…）」的行不给；stoppedReason 有值 → stopped；两个角色都在歇着 → all-paused；
 *   表里全是已完成 → queue-empty；只认主表，别的表（「已完成」那几张）里的行不给。
 * - 条件 7（前半）：撞了额度的角色，下一次 decideNextTurn 跳过它。
 *
 * 全是合成队列、纯函数调用，不碰文件、不调模型。
 */
import { describe, expect, it } from 'vitest';
import { decideNextTurn, type Idle, type RelayState, type Turn } from '../../src/index.js';

/** 合成队列：主表 + 另一张同形状的表（后者必须被忽略）。 */
function queue(mainRows: string[]): string {
  return [
    '# 委派队列',
    '',
    '## 可以领的',
    '',
    '| 序号 | 任务                                                             | 委派单或规格        | 档位 | 依赖   | 状态                 |',
    '| ---- | ---------------------------------------------------------------- | ------------------- | ---- | ------ | -------------------- |',
    ...mainRows,
    '',
    '## 已完成',
    '',
    '| 序号 | 任务                 | 委派单或规格 | 档位 | 依赖 | 状态          |',
    '| ---- | -------------------- | ------------ | ---- | ---- | ------------- |',
    '| 900  | L900 别的表里的一行  | [x](x.md)    | B    | 无   | 进行中（dev） |',
    '',
  ].join('\n');
}

const row = (no: string, task: string, tier: string, deps: string, status: string) =>
  `| ${no}   | ${task} | [x](x.md) | ${tier}    | ${deps} | ${status} |`;

const NOW = new Date('2026-10-21T10:00:00+08:00');
const state = (over: Partial<RelayState> = {}): RelayState => ({
  stoppedReason: null,
  pausedUntil: {},
  turns: 0,
  ...over,
});

const asTurn = (r: Turn | Idle): Turn => {
  if ('idle' in r) throw new Error(`期望给一棒，实际是 idle=${r.idle}`);
  return r;
};
const asIdle = (r: Turn | Idle): Idle => {
  if (!('idle' in r)) throw new Error(`期望停住，实际给了第 ${r.taskId} 行`);
  return r;
};

describe('条件 1：定下一棒的次序', () => {
  const threeRows = queue([
    row('1', 'L1 待复审的一行', 'B', '无', '待复审（整合方）'),
    row('2', 'L2 进行中的一行', 'A', '无', '进行中（dev）'),
    row('3', 'L3 待领的一行', 'A', '无', '待领'),
  ]);

  it('三行都在时先给整合方那一行（原样带上序号、任务、状态）', () => {
    expect(asTurn(decideNextTurn(threeRows, state(), NOW))).toEqual({
      role: 'integrator',
      kind: 'integrator-review',
      taskId: '1',
      task: 'L1 待复审的一行',
      status: '待复审（整合方）',
    });
  });

  it('整合方在歇着 → 给开发「进行中」那一行（developer-continue）', () => {
    const paused = state({ pausedUntil: { integrator: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(threeRows, paused, NOW))).toEqual({
      role: 'developer',
      kind: 'developer-continue',
      taskId: '2',
      task: 'L2 进行中的一行',
      status: '进行中（dev）',
    });
  });

  it('没有「进行中」→ 给开发第一个依赖都完成的「待领」（developer-claim）', () => {
    const noRunning = queue([
      row('1', 'L1 待复审的一行', 'B', '无', '待复审（整合方）'),
      row('3', 'L3 待领的一行', 'A', '无', '待领'),
    ]);
    const paused = state({ pausedUntil: { integrator: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(noRunning, paused, NOW))).toMatchObject({
      role: 'developer',
      kind: 'developer-claim',
      taskId: '3',
    });
  });

  // 整合方补：次序按「哪一种」排，不按表里的先后
  it('待复审那一行排在表的最后，也先给整合方；「进行中」排在「待领」后面，也先于「待领」', () => {
    const reordered = queue([
      row('3', 'L3 待领的一行', 'A', '无', '待领'),
      row('2', 'L2 进行中的一行', 'A', '无', '进行中（dev）'),
      row('1', 'L1 待复审的一行', 'B', '无', '待复审（整合方）'),
    ]);
    expect(asTurn(decideNextTurn(reordered, state(), NOW))).toMatchObject({
      kind: 'integrator-review',
      taskId: '1',
    });
    const paused = state({ pausedUntil: { integrator: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(reordered, paused, NOW))).toMatchObject({
      kind: 'developer-continue',
      taskId: '2',
    });
  });

  // 整合方补：规格第 4 条列的另外两种状态
  it('「测试待审（整合方）」也给整合方；「待审（Codex 额度）」算开发接着做', () => {
    const md = queue([
      row('3', 'L3 待领的一行', 'A', '无', '待领'),
      row('2', 'L2 等 Codex 额度', 'A', '无', '待审（Codex 额度）'),
      row('1', 'L1 测试等整合方', 'B', '无', '测试待审（整合方）'),
    ]);
    expect(asTurn(decideNextTurn(md, state(), NOW))).toMatchObject({
      role: 'integrator',
      kind: 'integrator-review',
      taskId: '1',
      status: '测试待审（整合方）',
    });
    const paused = state({ pausedUntil: { integrator: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(md, paused, NOW))).toMatchObject({
      role: 'developer',
      kind: 'developer-continue',
      taskId: '2',
      status: '待审（Codex 额度）',
    });
  });

  it('两个角色都在歇着 → 谁也不给（all-paused）', () => {
    const both = state({
      pausedUntil: {
        integrator: '2026-10-21T12:00:00+08:00',
        developer: '2026-10-21T12:00:00+08:00',
      },
    });
    expect(asIdle(decideNextTurn(threeRows, both, NOW)).idle).toBe('all-paused');
  });
});

describe('条件 2：依赖怎么算', () => {
  it('「无」和「无（说明）」都算没依赖', () => {
    const md = queue([
      row('1', 'L1 没依赖', 'A', '无', '待领'),
      row('2', 'L2 没依赖（带说明）', 'A', '无（Claude 那列等用户装好）', '待领'),
    ]);
    expect(asTurn(decideNextTurn(md, state(), NOW)).taskId).toBe('1');
    const onlySecond = queue([row('2', 'L2 没依赖（带说明）', 'A', '无（等用户）', '待领')]);
    expect(asTurn(decideNextTurn(onlySecond, state(), NOW)).taskId).toBe('2');
  });

  it('「P5 ✅」这种带勾的算完成', () => {
    const md = queue([row('1', 'L1 依赖带勾', 'B', 'P5 ✅', '待领')]);
    expect(asTurn(decideNextTurn(md, state(), NOW)).taskId).toBe('1');
  });

  it('不带勾的依赖去表里找任务号：状态「已完成」才算完成，否则跳过', () => {
    const done = queue([
      row('1', 'L1 依赖已完成的那行', 'B', 'L2', '待领'),
      row('2', 'L2 已经做完的', 'B', '无', '已完成（2026-10-21）'),
    ]);
    expect(asTurn(decideNextTurn(done, state(), NOW)).taskId).toBe('1');

    // 依赖的那行还没做完（不是「已完成」）→ 这一行跳过，去看下一行能领的
    // （整合方改：原来把开发设成歇着、又要开发去领第 3 行，自相矛盾；改成依赖那行等整合方、整合方歇着）
    const depRunning = queue([
      row('1', 'L1 依赖 L2（还没做完）', 'B', 'L2', '待领'),
      row('2', 'L2 等整合方看测试', 'B', '无', '测试待审（整合方）'),
      row('3', 'L3 没依赖', 'A', '无', '待领'),
    ]);
    const pausedInteg = state({ pausedUntil: { integrator: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(depRunning, pausedInteg, NOW))).toMatchObject({
      kind: 'developer-claim',
      taskId: '3',
    });
    // 只把第 1 行留下：依赖没完成 → 没得领，也没别的活
    const onlyBlocked = queue([
      row('1', 'L1 依赖 L2（没做完）', 'B', 'L2', '待领'),
      row('2', 'L2 暂停了', 'B', '无', '暂停（等 D2c）'),
    ]);
    expect(asIdle(decideNextTurn(onlyBlocked, state(), NOW)).idle).toBe('all-blocked');
  });

  it('多个依赖按「、」「，」「,」切开，全完成才给', () => {
    const md = queue([
      row('1', 'L1 两个依赖', 'B', 'P5 ✅、L2', '待领'),
      row('2', 'L2 做完了', 'B', '无', '已完成（2026-10-21）'),
    ]);
    expect(asTurn(decideNextTurn(md, state(), NOW)).taskId).toBe('1');
    const half = queue([
      row('1', 'L1 两个依赖', 'B', 'P5 ✅, L9', '待领'),
      row('9', 'L9 还没领', 'B', '无', '待领'),
    ]);
    expect(asTurn(decideNextTurn(half, state(), NOW)).taskId).toBe('9');
    // 整合方补：全角「，」也要切开（L9 没做完 → 第 1 行不给）
    const fullWidth = queue([
      row('1', 'L1 两个依赖', 'B', 'P5 ✅，L9', '待领'),
      row('9', 'L9 还没领', 'B', '无', '待领'),
    ]);
    expect(asTurn(decideNextTurn(fullWidth, state(), NOW)).taskId).toBe('9');
    // 整合方补：带勾的排在前面、不带勾的排在后面——不切开的话整串既不以 ✅ 结尾、也找不到任务号
    for (const deps of ['P5 ✅, L2', 'P5 ✅，L2', 'P5 ✅、L2']) {
      const both = queue([
        row('1', 'L1 两个依赖', 'B', deps, '待领'),
        row('2', 'L2 做完了', 'B', '无', '已完成（2026-10-21）'),
      ]);
      expect(asTurn(decideNextTurn(both, state(), NOW)).taskId, deps).toBe('1');
    }
  });

  // 整合方补：表里找不到的依赖不算完成
  it('依赖的任务号在主表里找不到 → 不算完成，这一行不给', () => {
    const md = queue([
      row('1', 'L1 依赖一个不存在的', 'B', 'Z9', '待领'),
      row('2', 'L2 没依赖', 'A', '无', '待领'),
    ]);
    expect(asTurn(decideNextTurn(md, state(), NOW)).taskId).toBe('2');
    const only = queue([row('1', 'L1 依赖一个不存在的', 'B', 'Z9', '待领')]);
    expect(asIdle(decideNextTurn(only, state(), NOW)).idle).toBe('all-blocked');
  });

  it('全被依赖挡着 → all-blocked', () => {
    const md = queue([
      row('1', 'L1 等 L9', 'B', 'L9', '待领'),
      row('9', 'L9 等 L1', 'B', 'L1', '待领'),
      row('5', 'L5 暂停中', 'A', '无', '暂停（等 D2c）'),
    ]);
    expect(asIdle(decideNextTurn(md, state(), NOW)).idle).toBe('all-blocked');
  });
});

describe('条件 3：跳过的行与各种停住', () => {
  it('「暂停（…）」「已完成（…）」的行不给', () => {
    const md = queue([
      row('1', 'L1 暂停了', 'A', '无', '暂停（等 D2c）'),
      row('2', 'L2 做完了', 'A', '无', '已完成（2026-10-20）'),
      row('3', 'L3 可以领', 'A', '无', '待领'),
    ]);
    expect(asTurn(decideNextTurn(md, state(), NOW)).taskId).toBe('3');
  });

  it('stoppedReason 有值 → 一律 stopped', () => {
    const md = queue([row('1', 'L1 待复审', 'B', '无', '待复审（整合方）')]);
    const stopped = state({ stoppedReason: 'developer 并了 B 档：第 3 行' });
    expect(asIdle(decideNextTurn(md, stopped, NOW)).idle).toBe('stopped');
  });

  it('表里全是已完成 → queue-empty', () => {
    const md = queue([
      row('1', 'L1 做完了', 'A', '无', '已完成（2026-10-20）'),
      row('2', 'L2 也做完了', 'A', '无', '已完成（2026-10-20）'),
    ]);
    expect(asIdle(decideNextTurn(md, state(), NOW)).idle).toBe('queue-empty');
  });

  // 整合方补（2026-10-21，复审实现时）：别的表排在主表前面，也不能当成主表
  it('只认主表：表头不一样的表排在主表前面 → 它的行不算数', () => {
    const md = [
      '# 委派队列',
      '',
      '| 序号 | 任务 | 档位 | 结果 |',
      '| ---- | ---- | ---- | ---- |',
      '| 800 | L800 别的表 | B | 进行中（dev） |',
      '',
      queue([row('1', 'L1 主表里做完了', 'A', '无', '已完成（2026-10-20）')]),
    ].join('\n');
    expect(asIdle(decideNextTurn(md, state(), NOW)).idle).toBe('queue-empty');
  });

  it('只认主表：别的表里的「进行中（dev）」不算数', () => {
    const md = queue([row('1', 'L1 主表里做完了', 'A', '无', '已完成（2026-10-20）')]);
    // 「## 已完成」那张表里有一行「进行中（dev）」，但它不该被当成活的
    expect(md).toContain('L900 别的表里的一行');
    expect(asIdle(decideNextTurn(md, state(), NOW)).idle).toBe('queue-empty');
  });
});

describe('条件 7（前半）：歇着的角色被跳过，到点又能轮到', () => {
  const md = queue([
    row('1', 'L1 待复审', 'B', '无', '待复审（整合方）'),
    row('2', 'L2 进行中', 'A', '无', '进行中（dev）'),
  ]);

  it('撞额度歇到 12:00 时跳过；11:59 还跳；12:01 又能轮到', () => {
    const paused = state({ pausedUntil: { integrator: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(md, paused, new Date('2026-10-21T11:00:00+08:00'))).role).toBe(
      'developer',
    );
    expect(asTurn(decideNextTurn(md, paused, new Date('2026-10-21T11:59:00+08:00'))).role).toBe(
      'developer',
    );
    expect(asTurn(decideNextTurn(md, paused, new Date('2026-10-21T12:01:00+08:00'))).role).toBe(
      'integrator',
    );
  });

  it('开发歇着时，待复审那行仍然给整合方', () => {
    const pausedDev = state({ pausedUntil: { developer: '2026-10-21T12:00:00+08:00' } });
    expect(asTurn(decideNextTurn(md, pausedDev, NOW)).role).toBe('integrator');
  });
});
