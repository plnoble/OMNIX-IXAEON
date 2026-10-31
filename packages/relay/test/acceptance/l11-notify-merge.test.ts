/**
 * L11 复审修复的回归测试（统筹 2026-10-27 任务书 §14）。
 *
 * 原缺陷：`engine.ts` 两处写 `Object.assign(notifyStore(s), notifyStore(state))`。
 * 源是 `{ sent: {...} }`，`Object.assign` 只拷**顶层属性**，等于把盘上那份 `sent`
 * **整份换成内存这一份**——两条道同时跑时，另一道刚记下的「今天已经提醒过谁」被盖掉，
 * 同一天就会重复打扰用户。Quiet Policy 后续依赖这张表可靠。
 *
 * 条件（逐条对应下面的 it）：
 * 1. 另一道写的 key 不被本道盖掉（逐键并集，不是整表替换）；
 * 2. 同一个 key 两边都有时以本道新值为准；
 * 3. 两边都没有 notify 时不炸、产出空表；
 * 4. 目标已有 notify 时不被整份丢弃（保留它原有的其它 key）。
 */
import { describe, expect, it } from 'vitest';
import * as engineModule from '../../src/engine.js';
import type { RelayState } from '../../src/types.js';

/**
 * 实现之前 `mergeNotifyInto` 还没有导出（测试先行、B 档还不许写实现）。
 * 用断言取出：运行时没有就是 `undefined`，下面一调就红；类型检查照过。
 * 实现补上之后这里不用改。
 */
const mergeNotifyInto = (
  engineModule as unknown as {
    mergeNotifyInto: (target: RelayState, source: RelayState) => void;
  }
).mergeNotifyInto;

const state = (over: Partial<RelayState> = {}): RelayState => ({
  pausedUntil: {},
  turns: 0,
  ...over,
});

describe('条件 1：另一道的记录不能被整表覆盖', () => {
  it('盘上有 dev 的 key，本道（integrator）写入后 dev 的 key 还在', () => {
    const onDisk = state({ notify: { sent: { 'dev|idle|queue-empty': '2026-10-27T01:00:00Z' } } });
    const mine = state({
      notify: { sent: { 'integrator|idle|queue-empty': '2026-10-27T02:00:00Z' } },
    });

    mergeNotifyInto(onDisk, mine);

    expect(onDisk.notify!.sent).toEqual({
      'dev|idle|queue-empty': '2026-10-27T01:00:00Z',
      'integrator|idle|queue-empty': '2026-10-27T02:00:00Z',
    });
    // 用旧的 Object.assign 写法这条一定会红：dev 的 key 会消失
    expect(onDisk.notify!.sent['dev|idle|queue-empty']).toBeDefined();
  });
});

describe('条件 2：同 key 以本道新值为准', () => {
  it('两条道都记了同一个 key，写入方覆盖成自己的时间', () => {
    const onDisk = state({ notify: { sent: { k: '2026-10-27T01:00:00Z' } } });
    const mine = state({ notify: { sent: { k: '2026-10-27T03:30:00Z' } } });

    mergeNotifyInto(onDisk, mine);

    expect(onDisk.notify!.sent.k).toBe('2026-10-27T03:30:00Z');
    expect(Object.keys(onDisk.notify!.sent)).toHaveLength(1);
  });
});

describe('条件 3：缺 notify 时不炸', () => {
  it('两边都没 notify → 得到空 sent 表；只有源有 → 并进来；只有目标有 → 原样保留', () => {
    const a = state();
    mergeNotifyInto(a, state());
    expect(a.notify).toEqual({ sent: {} });

    const b = state();
    mergeNotifyInto(b, state({ notify: { sent: { x: '1' } } }));
    expect(b.notify).toEqual({ sent: { x: '1' } });

    const c = state({ notify: { sent: { y: '2' } } });
    mergeNotifyInto(c, state());
    expect(c.notify).toEqual({ sent: { y: '2' } });
  });
});

describe('条件 4：目标已有的其它 key 不被丢弃', () => {
  it('目标三条、源一条新 key，合并后四条都在', () => {
    const onDisk = state({
      notify: { sent: { a: '1', b: '2', c: '3' } },
    });
    mergeNotifyInto(onDisk, state({ notify: { sent: { d: '4' } } }));

    expect(Object.keys(onDisk.notify!.sent).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(onDisk.notify!.sent).toEqual({ a: '1', b: '2', c: '3', d: '4' });
  });

  it('源为空表时是幂等的（不改目标）', () => {
    const onDisk = state({ notify: { sent: { a: '1' } } });
    const before = { ...onDisk.notify!.sent };

    mergeNotifyInto(onDisk, state({ notify: { sent: {} } }));

    expect(onDisk.notify!.sent).toEqual(before);
  });
});
