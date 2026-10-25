/** 命令背后的逻辑（第 9 条）：定一棒、跑一棒、核对、记账；越界就停、resume 之后接着；L2b 接飞书。 */
import { createHash } from 'node:crypto';
import { dailyDue, dailyEvent } from './daily.js';
import { ensureDeps } from './deps.js';
import { git } from './git.js';
import { createNotifier, loadFeishuTarget, type RelayEvent } from './notify/feishu.js';
import { beijingDay, decideNextTurn, parseMainTable } from './queue.js';
import { parsePushLines, readTurnStdout, relayPushes } from './push.js';
import { runTurn } from './run-turn.js';
import {
  appendLedger,
  readLedger,
  readMainQueue,
  relayNow,
  saveState,
  type LedgerEntry,
} from './store.js';
import { diffPlanRows, verifyTurn } from './verify.js';
import type { RelayConfig, RelayState } from './types.js';

const BJ = 8 * 3_600_000;

/** L15 契约第 5 条：北京时间 9:00 之后、今天还没发过、配置开着 → 今天的日期写法；否则 `null`。 */
export function morningDue(
  state: RelayState,
  now: Date,
  enabled: boolean | undefined,
): string | null {
  if (!enabled) return null;
  const d = new Date(now.getTime() + BJ);
  if (d.getUTCHours() < 9) return null;
  const today = beijingDay(now.getTime());
  return state.lastMorningDate === today ? null : today;
}

/**
 * L15 契约第 5 条：早报。`turns`、`done`、`costUsd` 照日报的算法，只算「北京时间昨天 21:00 到现在」
 * 开始的棒；`doing` 是主表里状态以「进行中」「测试待审」「待复审」开头的行的任务那一栏。
 */
export function morningEvent(ledger: LedgerEntry[], queueMd: string, now: Date): RelayEvent {
  const rows = parseMainTable(queueMd);
  // 北京时间「今天 00:00」再往回 3 小时 = 昨天 21:00（北京）。
  const dayStart = Math.floor((now.getTime() + BJ) / 86_400_000) * 86_400_000 - BJ;
  const from = dayStart - 3 * 3_600_000;
  const mine = ledger.filter((e) => {
    const t = Date.parse(e.startedAt);
    return t >= from && t <= now.getTime();
  });
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
  const doing = rows
    .filter(
      (r) =>
        r.status.startsWith('进行中') ||
        r.status.startsWith('测试待审') ||
        r.status.startsWith('待复审'),
    )
    .map((r) => r.task);
  const event: RelayEvent = { kind: 'morning', turns: mine.length, done, doing };
  return hasCost ? { ...event, costUsd } : event;
}

export type Outcome = 'ran' | 'idle' | 'stopped';
export interface RunOptions {
  /** 只有 `run` 发 idle；`once` 不发（规格末尾第 3 条）。 */
  sendIdle?: boolean;
}

/** 做完之后重读 origin/main：这一行现在的状态。 */
export function statusOfTask(queueMd: string, taskId: string): string | null {
  return parseMainTable(queueMd).find((r) => r.no === taskId)?.status ?? null;
}

/** 限频记在 state.json 里，跨命令保留；没配飞书也照常存。 */
const notifyStore = (state: RelayState): { sent: Record<string, string> } =>
  (state.notify ??= { sent: {} });

export async function runOnce(
  config: RelayConfig,
  state: RelayState,
  dataDir: string,
  opts: RunOptions = {},
): Promise<Outcome> {
  const now = relayNow();
  const notifier = createNotifier(loadFeishuTarget(), notifyStore(state), { now: () => now });
  // L2 契约第 2 条：开棒前拉不下来就不开棒（不建 turns/、不记账、不停下），当作没活。
  const queueMd = await readMainQueue(config);
  if (queueMd === null) {
    console.log('没活：拉不下来 origin/main');
    return 'idle';
  }
  // 日报在定下一棒之前发：到点之后的第一次（`once`、`run` 都发）。
  const due = dailyDue(state, now);
  if (due) {
    await notifier.notify(dailyEvent(readLedger(dataDir), due, queueMd));
    state.lastDailyDate = due;
    saveState(dataDir, state);
  }
  // L15 契约第 5 条：早报也在定下一棒之前发，和日报同一处。
  const morning = morningDue(state, now, config.morningReport);
  if (morning) {
    const sent = await notifier.notify(morningEvent(readLedger(dataDir), queueMd, now));
    // L15 契约第 5 条：真的发出去了才记下今天——发失败、没配飞书、被限频跳过都留到下一次。
    if (sent.ok && sent.sent) {
      state.lastMorningDate = morning;
      saveState(dataDir, state);
    }
  }
  const decision = decideNextTurn(queueMd, state, now, { planPerDay: config.planPerDay });
  if ('idle' in decision) {
    console.log(`没活：${decision.idle}`);
    if (opts.sendIdle && (decision.idle === 'queue-empty' || decision.idle === 'all-blocked')) {
      // L15 契约第 2 条：每种「没活」一个北京日只发一次。queue-empty 不带 waiting（原话不变）；
      // all-blocked 带上主表里「等用户」的行（空数组也带，好让用户知道不用做什么）。
      const today = beijingDay(now.getTime());
      if (state.idleDay?.[decision.idle] !== today) {
        const waiting =
          decision.idle === 'all-blocked'
            ? parseMainTable(queueMd)
                .filter((r) => r.status.startsWith('等用户'))
                .map((r) => ({ no: r.no, task: r.task, status: r.status }))
            : undefined;
        const sent = await notifier.notify({
          kind: 'idle',
          why: decision.idle,
          ...(waiting ? { waiting } : {}),
        });
        // L15 契约第 2 条：真的发出去了才记下今天；被 30 分钟限频跳过时不能占掉这一天的名额。
        if (sent.ok && sent.sent) state.idleDay = { ...state.idleDay, [decision.idle]: today };
      }
    }
    saveState(dataDir, state);
    return decision.idle === 'stopped' ? 'stopped' : 'idle';
  }
  const turn = state.turns + 1;
  // L10 契约第 4 条：整合方的棒开之前，给它 cwd 装一次依赖；装不上就当这一轮没开（不建 turns/、不记账、不停下）。
  if (decision.role === 'integrator') {
    if (ensureDeps(config.roles.integrator.cwd) === 'failed') {
      console.log('没开棒：整合方的工作目录装不上依赖');
      return 'idle';
    }
  }
  state.mainShaAtTurnStart = git(config.roles.integrator.cwd, ['rev-parse', 'origin/main']).out;
  // L9 契约第 3、4 条：派了规划棒就先记下这一次（日子、次数、队列全文的 sha256），跑之前存盘。
  if (decision.kind === 'integrator-plan') {
    const today = beijingDay(now.getTime());
    const sameDay = state.plan?.date === today;
    state.plan = {
      date: today,
      count: sameDay ? state.plan!.count + 1 : 1,
      queueHash: createHash('sha256').update(queueMd, 'utf8').digest('hex'),
    };
    saveState(dataDir, state);
  }
  const startedAt = new Date().toISOString();
  const result = await runTurn(decision, config, state, { dataDir, turnNumber: turn });
  // L6 契约第 4 条：标了 pushByRelay 的角色，替它把这一棒要推的推上去。**先推后端**再核对——
  // 替推上去的东西（比如「并入 B 档」）也要被核对到。
  const role = config.roles[decision.role];
  const push = role.pushByRelay
    ? await relayPushes(parsePushLines(readTurnStdout(result.stdoutPath)), role, turn)
    : null;
  // 整合方改（2026-10-23）：只有一条都没推（被拒）才跳过核对；推上去过东西（哪怕后面一条失败了）照样核对
  const verdict =
    push?.stopReason && push.pushes.length === 0
      ? { violations: [], mainSha: null }
      : await verifyTurn(decision, config, state);
  // 拉不下来就没法核对：停下，做完后的状态也不猜（规格末尾第 4 条）。
  const after = verdict.mainSha === null ? null : await readMainQueue(config);
  // L9 契约第 8 条：规划棒的 statusAfter 是「加了 <N> 行」，不是队列里某一行的状态。
  const planDiff =
    decision.kind === 'integrator-plan' && after !== null ? diffPlanRows(queueMd, after) : null;
  const statusAfter =
    after === null
      ? null
      : planDiff
        ? `加了 ${planDiff.added.length} 行`
        : statusOfTask(after, decision.taskId);
  appendLedger(dataDir, {
    turn,
    role: decision.role,
    kind: decision.kind,
    taskId: decision.taskId,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    quotaHit: result.quotaHit,
    usage: result.usage,
    statusBefore: decision.status,
    statusAfter,
    doneLine: result.doneLine,
    violations: verdict.violations,
    ...(push && push.pushes.length ? { pushes: push.pushes } : {}),
  });
  state.turns = turn;
  const stopReason =
    push?.stopReason ??
    (verdict.violations.includes('verify-fetch-failed')
      ? `第 ${turn} 棒之后拉不下来 origin/main，没法核对`
      : verdict.violations.length
        ? `第 ${turn} 棒越界（${decision.role}）：${verdict.violations.join('、')}`
        : null);
  if (stopReason) state.stoppedReason = stopReason;
  // 什么时候发（规格契约第 4 条的表）：停下 → stopped；撞额度 → paused；等用户 → needs-user。
  if (stopReason) {
    await notifier.notify({
      kind: 'stopped',
      reason: stopReason,
      taskId: decision.taskId,
      task: decision.task,
    });
  } else {
    // L15 契约第 1 条：这一棒把一行做完了（开棒时还没完成）就发一条 done；规划棒不发。
    if (
      statusAfter?.startsWith('已完成') &&
      !decision.status.startsWith('已完成') &&
      decision.taskId !== 'plan'
    ) {
      const mine = readLedger(dataDir).filter((e) => e.taskId === decision.taskId);
      const totalMs = mine.reduce(
        (sum, e) => sum + (Date.parse(e.endedAt) - Date.parse(e.startedAt)),
        0,
      );
      const costUsd = mine.reduce(
        (sum, e) => sum + (typeof e.usage?.costUsd === 'number' ? e.usage.costUsd : 0),
        0,
      );
      await notifier.notify({
        kind: 'done',
        taskId: decision.taskId,
        task: decision.task,
        turns: mine.length,
        hours: Number((totalMs / 3_600_000).toFixed(1)),
        costUsd,
      });
    }
    if (result.quotaHit && state.pausedUntil[decision.role]) {
      await notifier.notify({
        kind: 'paused',
        role: decision.role,
        until: state.pausedUntil[decision.role]!,
      });
    }
    // 整合方改（2026-10-23）：歇了也照样告诉用户「等你拍板」——原来 else if 把它吞了（第 3 棒）。
    if (statusAfter?.startsWith('等用户')) {
      await notifier.notify({
        kind: 'needs-user',
        taskId: decision.taskId,
        task: decision.task,
        status: statusAfter,
      });
    }
    // L9 契约第 7 条：规划棒没越界、加了至少一行才发 planned；一行没加照常空转。
    if (planDiff && planDiff.added.length > 0) {
      await notifier.notify({
        kind: 'planned',
        rows: planDiff.added.map((r) => ({ no: r.no, task: r.task, status: r.status })),
      });
    }
  }
  saveState(dataDir, state);
  console.log(
    `第 ${turn} 棒 ${decision.role} ${decision.kind} 行 ${decision.taskId} → ${statusAfter ?? '?'}` +
      // 整合方改（2026-10-24）：停下的原因整句打出来（替推失败原来不打，第 24 棒停了终端里看不出来）
      (stopReason ? `｜停下：${stopReason}` : ''),
  );
  return 'ran';
}
