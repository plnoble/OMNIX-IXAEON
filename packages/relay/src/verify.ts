/** 核对有没有越界（第 8 条）：只看开发那一棒；`local-user` 任何一棒之后都查。L9 加规划棒两条。 */
import { spawnSync } from 'node:child_process';
import { fetchMain, git } from './git.js';
import { parseMainTableFull, tierOfTask, type MainTableRow } from './queue.js';
import type { RelayConfig, RelayState, Turn, Violation } from './types.js';

const QUEUE = 'docs/委派/队列.md';
const LOCK = 'docs/委派/锁定验收.json';
/** K9b 契约第 4 条：迁移文件也只由整合方写；替补碰了就是越界。 */
const MIGRATIONS = 'packages/core/src/db/migrations.ts';
export interface VerifyResult {
  violations: Violation[];
  mainSha: string | null;
}

export interface VerifyOptions {
  /** K9b：这一棒替补写过的 RELAY-PUSH 远端分支（原样）；用来认 `substitute-bad-branch`。 */
  pushRemotes?: string[];
}

/** K9b 契约第 4 条：替补推的分支只许 main（放文档）和 `integrate-sub/` 开头的。 */
export function substitutePushViolations(remotes: string[]): Violation[] {
  return remotes.some((r) => r !== 'main' && !r.startsWith('integrate-sub/'))
    ? ['substitute-bad-branch']
    : [];
}

/** K9b：origin 上的分支名（`git ls-remote --heads`）；出错回 `null`，不猜。 */
export function remoteHeads(cwd: string): string[] | null {
  const r = git(cwd, ['ls-remote', '--heads', 'origin'], 120_000);
  if (r.code !== 0) return null;
  return r.out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1] ?? '')
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ''));
}
interface LockTask {
  id?: string;
  files?: Record<string, string>;
}
/** 读某个提交上的文件（不 checkout、不 pull——调度器不改仓库）。 */
const showAt = (cwd: string, rev: string, path: string): string =>
  git(cwd, ['show', `${rev}:${path}`]).out;
function lockTasks(cwd: string, rev: string): LockTask[] {
  const raw = showAt(cwd, rev, LOCK);
  try {
    return raw ? ((JSON.parse(raw) as { tasks?: LockTask[] }).tasks ?? []) : [];
  } catch {
    return [];
  }
}
const entryOf = (list: LockTask[], id: string) => list.find((t) => t.id === id) ?? null;

/** 这一棒的每一笔都查：提交说明以「并入 X」开头、而 X 在队列里是 B 档。 */
function mergedBTier(cwd: string, queue: string, since: string, sha: string): boolean {
  const subjects = git(cwd, ['log', '--format=%s%x1e', `${since}..${sha}`]).out.split('\x1e');
  return subjects.some((s) => {
    const id = /^并入\s*([A-Za-z0-9._-]+)/.exec(s.trim())?.[1];
    return !!id && tierOfTask(queue, id) === 'B';
  });
}

/** B 档任务在锁定清单里那一条有任何变化，或它登记的文件在这一棒里变了。 */
function lockChangedBTier(
  cwd: string,
  queue: string,
  since: string,
  sha: string,
  changed: Set<string>,
): boolean {
  const before = lockTasks(cwd, since);
  const after = lockTasks(cwd, sha);
  const ids = [...new Set([...before, ...after].map((t) => t.id).filter((x): x is string => !!x))];
  return ids.some((id) => {
    if (tierOfTask(queue, id) !== 'B') return false;
    const a = entryOf(before, id);
    const b = entryOf(after, id);
    if (JSON.stringify(a) !== JSON.stringify(b)) return true;
    const files = [...Object.keys(a?.files ?? {}), ...Object.keys(b?.files ?? {})];
    return files.some((f) => changed.has(f));
  });
}

const sameCells = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface PlanQueueDiff {
  /** 主表里新加的行（照 after 里的先后）。 */
  added: MainTableRow[];
  /** 开棒时已有的一行少了、或者任何一格变了。 */
  changed: boolean;
}

/**
 * L9 契约第 6 条：比开棒前后主表的两份原文。
 * 已有行按「整行六格」配对（只重排不算改）；对不上的算「变了」，多出来的算新加的行。
 */
export function diffPlanRows(beforeMd: string, afterMd: string): PlanQueueDiff {
  const before = parseMainTableFull(beforeMd);
  const after = parseMainTableFull(afterMd);
  const left = after.slice();
  let changed = false;
  for (const row of before) {
    const i = left.findIndex((x) => sameCells(x.cells, row.cells));
    if (i < 0) changed = true;
    else left.splice(i, 1);
  }
  return { added: left, changed };
}

/** 规划棒新加的行数（拉不下来就不猜：`null`）。 */
export function planAddedRows(beforeMd: string, afterMd: string | null): number | null {
  if (afterMd === null) return null;
  return diffPlanRows(beforeMd, afterMd).added.length;
}

export async function verifyTurn(
  turn: Turn,
  config: RelayConfig,
  state: RelayState,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const cwd = config.roles.integrator.cwd;
  const violations: Violation[] = [];
  // K9b 契约第 4 条：替补写过的 RELAY-PUSH 行先认一遍（推送被拒了也算推错了分支）。
  if (turn.role === 'integrator-substitute') {
    violations.push(...substitutePushViolations(opts.pushRemotes ?? []));
  }
  // L2 契约第 2 条：开发在自己的目录里推，整合方的目录不会跟着变，核对前得先拉一下。
  // 拉不下来就没法核对：停下（不再跑 local-user，也不猜）。
  if (!(await fetchMain(cwd))) {
    return {
      violations: [...new Set([...violations, 'verify-fetch-failed' as Violation])],
      mainSha: null,
    };
  }
  const mainSha = git(cwd, ['rev-parse', 'origin/main']).out || null;
  const since = state.mainShaAtTurnStart ?? null;
  if (mainSha && since && mainSha !== since) {
    // 整合方改：改名要拆成「删 + 加」才看得见旧名字；路径不转义、按行切（路径里可能有空格和中文）
    const diff = [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-renames',
      '--name-only',
      since,
      mainSha,
    ];
    const changed = new Set(git(cwd, diff).out.split('\n'));
    if (turn.kind === 'integrator-plan') {
      // L9 契约第 6 条：规划棒只许改 `docs/` 下面的文件（不是 startsWith('docs')）。
      if ([...changed].some((f) => f && !f.startsWith('docs/'))) {
        violations.push('plan-touched-code');
      }
      const diffRows = diffPlanRows(showAt(cwd, since, QUEUE), showAt(cwd, mainSha, QUEUE));
      const badNewStatus = diffRows.added.some(
        (r) => !r.status.startsWith('待领') && !r.status.startsWith('等用户：'),
      );
      if (diffRows.changed || diffRows.added.length > 3 || badNewStatus) {
        violations.push('plan-changed-rows');
      }
    } else if (turn.kind === 'integrator-inbox') {
      // L16 契约第 6 条：飞书回复棒也只许改 `docs/` 下面的文件。
      if ([...changed].some((f) => f && !f.startsWith('docs/'))) {
        violations.push('inbox-touched-code');
      }
    } else if (turn.role === 'developer') {
      const queue = showAt(cwd, mainSha, QUEUE);
      if (mergedBTier(cwd, queue, since, mainSha)) violations.push('b-tier-merged-by-developer');
      if (lockChangedBTier(cwd, queue, since, mainSha, changed)) {
        violations.push('b-tier-lock-changed-by-developer');
      }
    }
    // K9b 契约第 4 条：替补在 main 上只许动 docs/委派/ 下的文件；锁定清单和迁移谁都不能碰。
    if (turn.role === 'integrator-substitute') {
      if (
        turn.kind === 'integrator-review' &&
        [...changed].some((f) => f && !f.startsWith('docs/委派/'))
      ) {
        violations.push('substitute-touched-main-code');
      }
      if (changed.has(LOCK)) violations.push('substitute-locked');
      if (changed.has(MIGRATIONS)) violations.push('substitute-migration');
    }
  }
  // K9b 契约第 4 条：替补自己直接推上去的分支也算——比开棒时多出来的分支里，
  // 只许 main 和 integrate-sub/ 开头的。拉不到分支清单时不猜，只认 RELAY-PUSH 那一层。
  if (turn.role === 'integrator-substitute' && state.remoteHeadsAtTurnStart) {
    const now = remoteHeads(cwd);
    if (now !== null) {
      const before = new Set(state.remoteHeadsAtTurnStart);
      if (now.some((h) => !before.has(h) && h !== 'main' && !h.startsWith('integrate-sub/'))) {
        violations.push('substitute-bad-branch');
      }
    }
  }
  // local-user：任何一棒之后都查（跑在整合方的目录里）
  const [cmd, ...args] = config.localUserCheck ?? ['node', 'scripts/check-local-user.mjs'];
  const check = spawnSync(cmd!, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  if ((check.status ?? 1) !== 0) violations.push('local-user');
  return { violations: [...new Set(violations)], mainSha };
}
