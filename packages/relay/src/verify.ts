/** 核对有没有越界（第 8 条）：只看开发那一棒；`local-user` 任何一棒之后都查。L9 加规划棒两条。 */
import { spawnSync } from 'node:child_process';
import { fetchMain, git } from './git.js';
import { parseMainTableFull, tierOfTask, type MainTableRow } from './queue.js';
import type { RelayConfig, RelayState, Turn, Violation } from './types.js';

const QUEUE = 'docs/委派/队列.md';
const LOCK = 'docs/委派/锁定验收.json';
export interface VerifyResult {
  violations: Violation[];
  mainSha: string | null;
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

/** 这一棒的每一笔都查：提交说明以「并入 X」开头、而 X 在队列里是 B 档。给了 email 只看这个署名的提交。 */
function mergedBTier(
  cwd: string,
  queue: string,
  since: string,
  sha: string,
  email?: string,
): boolean {
  const subjects = git(cwd, [
    'log',
    '--format=%s%x1e',
    ...(email ? [`--author=${email}`] : []),
    `${since}..${sha}`,
  ]).out.split('\x1e');
  return subjects.some((s) => {
    const id = /^并入\s*([A-Za-z0-9._-]+)/.exec(s.trim())?.[1];
    return !!id && tierOfTask(queue, id) === 'B';
  });
}

/**
 * B 档任务在锁定清单里那一条有任何变化，或它登记的文件在这一棒里变了。
 * 给了 mine（这一棒自己署名的提交列表）就逐笔比（它和它的父提交），整段的比法只在没署名时用。
 */
function lockChangedBTier(
  cwd: string,
  queue: string,
  since: string,
  sha: string,
  changed: Set<string>,
  mine: string[] | null,
): boolean {
  const steps: Array<[LockTask[], LockTask[], Set<string>]> =
    mine === null
      ? [[lockTasks(cwd, since), lockTasks(cwd, sha), changed]]
      : mine.map((c) => [
          lockTasks(cwd, `${c}^`),
          lockTasks(cwd, c),
          new Set(
            git(cwd, [
              '-c',
              'core.quotepath=false',
              'diff-tree',
              '--no-renames',
              '--no-commit-id',
              '--name-only',
              '-r',
              c,
            ])
              .out.split('\n')
              .filter(Boolean),
          ),
        ]);
  for (const [before, after, files] of steps) {
    const ids = [
      ...new Set([...before, ...after].map((t) => t.id).filter((x): x is string => !!x)),
    ];
    const hit = ids.some((id) => {
      if (tierOfTask(queue, id) !== 'B') return false;
      const a = entryOf(before, id);
      const b = entryOf(after, id);
      if (JSON.stringify(a) !== JSON.stringify(b)) return true;
      const list = [...Object.keys(a?.files ?? {}), ...Object.keys(b?.files ?? {})];
      return list.some((f) => files.has(f));
    });
    if (hit) return true;
  }
  return false;
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
  /** L11 契约第 5 条：这一棒自己进程里记的起点；给了就不读两条道共用的 state.mainShaAtTurnStart。 */
  sinceOverride?: string | null,
): Promise<VerifyResult> {
  const cwd = config.roles.integrator.cwd;
  // L2 契约第 2 条：开发在自己的目录里推，整合方的目录不会跟着变，核对前得先拉一下。
  // 拉不下来就没法核对：停下（不再跑 local-user，也不猜）。
  if (!(await fetchMain(cwd))) return { violations: ['verify-fetch-failed'], mainSha: null };
  const mainSha = git(cwd, ['rev-parse', 'origin/main']).out || null;
  const since = sinceOverride !== undefined ? sinceOverride : (state.mainShaAtTurnStart ?? null);
  const violations: Violation[] = [];
  if (mainSha && since && mainSha !== since) {
    // L11 契约第 6 条：配了 gitIdentity，就只算这个角色署名的提交——另一条道同时推上来的
    // 不算到这一棒头上。没配照原来看整段。
    const identity = config.roles[turn.role]?.gitIdentity;
    const mine =
      identity === undefined
        ? null
        : git(cwd, ['log', '--format=%H', `--author=${identity.email}`, `${since}..${mainSha}`])
            .out.split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
    const filesOf = (commit: string): string[] =>
      git(cwd, [
        '-c',
        'core.quotepath=false',
        'diff-tree',
        '--no-renames',
        '--no-commit-id',
        '--name-only',
        '-r',
        commit,
      ])
        .out.split('\n')
        .filter(Boolean);
    const changed = new Set(
      mine === null
        ? git(cwd, [
            '-c',
            'core.quotepath=false',
            'diff',
            '--no-renames',
            '--name-only',
            since,
            mainSha,
          ]).out.split('\n')
        : mine.flatMap(filesOf),
    );
    if (turn.kind === 'integrator-plan') {
      // L9 契约第 6 条：规划棒只许改 `docs/` 下面的文件（不是 startsWith('docs')）。
      if ([...changed].some((f) => f && !f.startsWith('docs/'))) {
        violations.push('plan-touched-code');
      }
      // L11 契约第 6 条：主表按「每一笔自己」（它和它的父提交比）算；有署名只看自己的每一笔。
      let changedRows = false;
      let added = 0;
      let badNewStatus = false;
      const steps: Array<[string, string]> =
        mine === null ? [[since, mainSha]] : mine.map((c) => [`${c}^`, c] as [string, string]);
      for (const [a, b] of steps) {
        const d = diffPlanRows(showAt(cwd, a, QUEUE), showAt(cwd, b, QUEUE));
        changedRows ||= d.changed;
        added += d.added.length;
        badNewStatus ||= d.added.some(
          (r) => !r.status.startsWith('待领') && !r.status.startsWith('等用户：'),
        );
      }
      if (changedRows || added > 3 || badNewStatus) {
        violations.push('plan-changed-rows');
      }
    } else if (turn.role === 'developer') {
      const queue = showAt(cwd, mainSha, QUEUE);
      if (mergedBTier(cwd, queue, since, mainSha, config.roles.developer.gitIdentity?.email)) {
        violations.push('b-tier-merged-by-developer');
      }
      if (lockChangedBTier(cwd, queue, since, mainSha, changed, mine)) {
        violations.push('b-tier-lock-changed-by-developer');
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
  return { violations, mainSha };
}
