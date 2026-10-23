/** 日报（L2b 契约第 4 条）：北京时间每天 21:00 之后第一次转到，发一条当天的小结。 */
import type { RelayEvent } from './notify/feishu.js';
import { beijingDay, parseMainTable } from './queue.js';
import type { LedgerEntry } from './store.js';
import type { RelayState } from './types.js';

const BJ = 8 * 3_600_000;

/** 到点（北京时间 21:00 之后）且今天还没发过 → 今天的日期写法；否则 `null`。 */
export function dailyDue(state: RelayState, now: Date): string | null {
  const d = new Date(now.getTime() + BJ);
  if (d.getUTCHours() < 21) return null;
  const today = beijingDay(now.getTime());
  return state.lastDailyDate === today ? null : today;
}

/**
 * 那一天的日报：只算 `startedAt` 落在北京时间那一天的棒；做完后状态以「已完成」开头的任务去重、
 * 按先后写任务名（队列里按序号查，查不到写「第 N 行」）；`costUsd` 是当天各棒的和，一棒都没有就不带。
 */
export function dailyEvent(ledger: LedgerEntry[], date: string, queueMd: string): RelayEvent {
  const rows = parseMainTable(queueMd);
  const mine = ledger.filter((e) => beijingDay(Date.parse(e.startedAt)) === date);
  const done: string[] = [];
  const seen = new Set<string>();
  let costUsd = 0;
  let hasCost = false;
  for (const e of mine) {
    if (typeof e.usage?.costUsd === 'number') {
      costUsd += e.usage.costUsd;
      hasCost = true;
    }
    if (e.statusAfter?.startsWith('已完成') && !seen.has(e.taskId)) {
      seen.add(e.taskId);
      done.push(rows.find((r) => r.no === e.taskId)?.task ?? `第 ${e.taskId} 行`);
    }
  }
  const event: RelayEvent = { kind: 'daily', date, turns: mine.length, done };
  return hasCost ? { ...event, costUsd } : event;
}
