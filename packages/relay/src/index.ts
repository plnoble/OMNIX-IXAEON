/** L1 接力调度器核心：公开 API 都从这里再导出（契约第 1 条）。 */
export * from './types.js';
export { decideNextTurn, leadingId, parseMainTable, tierOfTask } from './queue.js';
export { checkConfig, findSharedCheckout, FORBIDDEN_SWITCHES, isInside } from './config.js';
export { buildTurnPrompt, writeTurnPrompt } from './prompt.js';
export { verifyTurn, type VerifyResult } from './verify.js';
