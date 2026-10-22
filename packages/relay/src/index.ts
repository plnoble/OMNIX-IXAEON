/** 接力调度器：公开 API 都从这里再导出（契约第 1 条）。 */
export * from './types.js';
export * from './lock.js';
export * from './store.js';
export { decideNextTurn, leadingId, parseMainTable, tierOfTask } from './queue.js';
export { checkConfig, findSharedCheckout, FORBIDDEN_SWITCHES, isInside } from './config.js';
export { buildTurnPrompt, writeTurnPrompt } from './prompt.js';
export { verifyTurn, type VerifyResult } from './verify.js';
export { fetchMain, git } from './git.js';
export { dailyDue, dailyEvent } from './daily.js';
export { parseRoleOutput, type RoleOutput } from './output.js';
export { runTurn, type TurnResult } from './run-turn.js';
export { runOnce, statusOfTask, type Outcome, type RunOptions } from './engine.js';
