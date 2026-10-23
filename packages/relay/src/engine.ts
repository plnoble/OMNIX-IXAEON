/** 命令背后的逻辑（第 9 条）：定一棒、跑一棒、核对、记账；越界就停、resume 之后接着；L2b 接飞书。 */
import { dailyDue, dailyEvent } from './daily.js';
import { git } from './git.js';
import { createNotifier, loadFeishuTarget } from './notify/feishu.js';
import { decideNextTurn, parseMainTable } from './queue.js';
import { parsePushLines, readTurnStdout, relayPushes } from './push.js';
import { runTurn } from './run-turn.js';
import { appendLedger, readLedger, readMainQueue, relayNow, saveState } from './store.js';
import { verifyTurn } from './verify.js';
import type { RelayConfig, RelayState } from './types.js';

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
  const decision = decideNextTurn(queueMd, state, now);
  if ('idle' in decision) {
    console.log(`没活：${decision.idle}`);
    if (opts.sendIdle && (decision.idle === 'queue-empty' || decision.idle === 'all-blocked')) {
      await notifier.notify({ kind: 'idle', why: decision.idle });
    }
    saveState(dataDir, state);
    return decision.idle === 'stopped' ? 'stopped' : 'idle';
  }
  const turn = state.turns + 1;
  state.mainShaAtTurnStart = git(config.roles.integrator.cwd, ['rev-parse', 'origin/main']).out;
  const startedAt = new Date().toISOString();
  const result = await runTurn(decision, config, state, { dataDir, turnNumber: turn });
  // L6 契约第 4 条：标了 pushByRelay 的角色，替它把这一棒要推的推上去。**先推后端**再核对——
  // 替推上去的东西（比如「并入 B 档」）也要被核对到。
  const role = config.roles[decision.role];
  const push = role.pushByRelay
    ? relayPushes(parsePushLines(readTurnStdout(result.stdoutPath)), role, turn)
    : null;
  const verdict = push?.stopReason
    ? { violations: [], mainSha: null }
    : await verifyTurn(decision, config, state);
  // 拉不下来就没法核对：停下，做完后的状态也不猜（规格末尾第 4 条）。
  const after = verdict.mainSha === null ? null : await readMainQueue(config);
  const statusAfter = after === null ? null : statusOfTask(after, decision.taskId);
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
  } else if (result.quotaHit && state.pausedUntil[decision.role]) {
    await notifier.notify({
      kind: 'paused',
      role: decision.role,
      until: state.pausedUntil[decision.role]!,
    });
  } else if (statusAfter?.startsWith('等用户')) {
    await notifier.notify({
      kind: 'needs-user',
      taskId: decision.taskId,
      task: decision.task,
      status: statusAfter,
    });
  }
  saveState(dataDir, state);
  console.log(
    `第 ${turn} 棒 ${decision.role} ${decision.kind} 行 ${decision.taskId} → ${statusAfter ?? '?'}` +
      (verdict.violations.length ? `｜停下：${verdict.violations.join('、')}` : ''),
  );
  return 'ran';
}
