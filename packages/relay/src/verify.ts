/** 核对有没有越界（第 8 条）：只看开发那一棒；`local-user` 任何一棒之后都查。 */
import { spawnSync } from 'node:child_process';
import { git } from './git.js';
import { tierOfTask } from './queue.js';
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

export async function verifyTurn(
  turn: Turn,
  config: RelayConfig,
  state: RelayState,
): Promise<VerifyResult> {
  const cwd = config.roles.integrator.cwd;
  git(cwd, ['fetch', 'origin']); // 开发在自己的目录里推，整合方的目录不会跟着变
  const mainSha = git(cwd, ['rev-parse', 'origin/main']).out || null;
  const since = state.mainShaAtTurnStart ?? null;
  const violations: Violation[] = [];
  if (turn.role === 'developer' && mainSha && since && mainSha !== since) {
    const queue = showAt(cwd, mainSha, QUEUE);
    if (mergedBTier(cwd, queue, since, mainSha)) violations.push('b-tier-merged-by-developer');
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
    const lockChanged = lockChangedBTier(cwd, queue, since, mainSha, changed);
    if (lockChanged) violations.push('b-tier-lock-changed-by-developer');
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
