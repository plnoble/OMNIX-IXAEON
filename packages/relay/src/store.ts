/** 数据目录（第 2 条）、状态、记账，以及从 origin/main 读队列（不读工作区）。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { git } from './git.js';
import type { RelayConfig, RelayState } from './types.js';

export interface LedgerEntry {
  turn: number;
  role: string;
  kind: string;
  taskId: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  quotaHit: boolean;
  usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number };
  statusBefore: string;
  statusAfter: string | null;
  doneLine: string | null;
  violations: string[];
}

/** 数据目录：`IXAEON_RELAY_DIR`，或者 `<Worktrees>/IXAEON/relay`（照 scripts/worktree.mjs 现算）。 */
export function relayDir(): string {
  const env = process.env.IXAEON_RELAY_DIR?.trim();
  if (env) return resolve(env);
  const wt = process.env.IXAEON_WORKTREES?.trim();
  const common = git(process.cwd(), [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).out;
  const base = wt
    ? resolve(wt)
    : resolve(common ? dirname(common) : process.cwd(), '..', '..', 'Worktrees', 'IXAEON');
  return join(base, 'relay');
}

export function loadState(dataDir: string): RelayState {
  const p = join(dataDir, 'state.json');
  const base: RelayState = { stoppedReason: null, pausedUntil: {}, turns: 0 };
  if (!existsSync(p)) return base;
  return { ...base, ...(JSON.parse(readFileSync(p, 'utf8')) as Partial<RelayState>) };
}

export function saveState(dataDir: string, state: RelayState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function appendLedger(dataDir: string, entry: LedgerEntry): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 队列从 **origin/main** 上读（`git show`）：开发在自己的目录里推，整合方的目录不会跟着变。 */
export function readMainQueue(config: RelayConfig): string {
  const cwd = config.roles.integrator.cwd;
  git(cwd, ['fetch', 'origin']);
  return git(cwd, ['show', 'origin/main:docs/委派/队列.md']).out;
}
