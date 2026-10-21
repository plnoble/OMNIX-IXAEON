/** 接力调度器：公开 API 都从这里再导出（契约第 1 条）。 */
export * from './types.js';
export * from './lock.js';
export * from './store.js';
export { decideNextTurn, leadingId, parseMainTable, tierOfTask } from './queue.js';
export { checkConfig, findSharedCheckout, FORBIDDEN_SWITCHES, isInside } from './config.js';
export { buildTurnPrompt, writeTurnPrompt } from './prompt.js';
export { verifyTurn, type VerifyResult } from './verify.js';
export { runTurn, type TurnResult, type Usage } from './run-turn.js';
export { runOnce, statusOfTask, type Outcome } from './engine.js';
