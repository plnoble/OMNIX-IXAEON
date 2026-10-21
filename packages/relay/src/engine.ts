/** 命令背后的逻辑（第 9 条）：定一棒、跑一棒、核对、记账；越界就停、resume 之后接着。 */
import { git } from './git.js';
import { decideNextTurn, parseMainTable } from './queue.js';
import { runTurn } from './run-turn.js';
import { appendLedger, readMainQueue, saveState } from './store.js';
import { verifyTurn } from './verify.js';
import type { RelayConfig, RelayState } from './types.js';

export type Outcome = 'ran' | 'idle' | 'stopped';

/** 做完之后重读 origin/main：这一行现在的状态。 */
export function statusOfTask(queueMd: string, taskId: string): string | null {
  return parseMainTable(queueMd).find((r) => r.no === taskId)?.status ?? null;
}

export async function runOnce(
  config: RelayConfig,
  state: RelayState,
  dataDir: string,
): Promise<Outcome> {
  const decision = decideNextTurn(readMainQueue(config), state, new Date());
  if ('idle' in decision) {
    console.log(`没活：${decision.idle}`);
    return decision.idle === 'stopped' ? 'stopped' : 'idle';
  }
  const turn = state.turns + 1;
  state.mainShaAtTurnStart = git(config.roles.integrator.cwd, ['rev-parse', 'origin/main']).out;
  const startedAt = new Date().toISOString();
  const result = await runTurn(decision, config, state, { dataDir, turnNumber: turn });
  const verdict = await verifyTurn(decision, config, state);
  const statusAfter = statusOfTask(readMainQueue(config), decision.taskId);
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
  });
  state.turns = turn;
  if (verdict.violations.length) {
    state.stoppedReason = `第 ${turn} 棒越界（${decision.role}）：${verdict.violations.join('、')}`;
  }
  saveState(dataDir, state);
  console.log(
    `第 ${turn} 棒 ${decision.role} ${decision.kind} 行 ${decision.taskId} → ${statusAfter ?? '?'}` +
      (verdict.violations.length ? `｜停下：${verdict.violations.join('、')}` : ''),
  );
  return 'ran';
}
