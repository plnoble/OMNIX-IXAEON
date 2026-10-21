/** 队列主表（第 4 条）：解析、任务号 → 档位、依赖算不算完成，以及「定下一棒」。 */
import type { Idle, RelayState, Role, Turn, TurnKind } from './types.js';

interface QueueRow {
  no: string;
  task: string;
  tier: string;
  deps: string;
  status: string;
}
const cellsOf = (line: string): string[] | null =>
  line.trim().startsWith('|')
    ? line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    : null;

/** 只认第一张表头是「序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态」的表（主表）。 */
export function parseMainTable(md: string): QueueRow[] {
  const lines = md.split(/\r?\n/);
  const want = ['序号', '任务', '委派单或规格', '档位', '依赖', '状态'];
  for (let i = 0; i < lines.length; i++) {
    const head = cellsOf(lines[i]!);
    if (!head || !want.every((h) => head.includes(h))) continue;
    const rows: QueueRow[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const c = cellsOf(lines[j]!);
      if (!c) break;
      if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;
      const cell = (h: string) => c[head.indexOf(h)] ?? '';
      const [no, task, tier, deps, status] = ['序号', '任务', '档位', '依赖', '状态'].map(cell);
      rows.push({ no: no!, task: task!, tier: tier!, deps: deps!, status: status! });
    }
    return rows;
  }
  return [];
}

/** 任务号 = 「任务」那一格的前导词（`L1 接力调度器核心…` → `L1`）。 */
export const leadingId = (task: string): string => task.trim().split(/\s+/)[0] ?? '';

/** 任务号 → 档位；`L3b` 这种第二支按去掉末尾 `b` 查（规格末尾第 4 条）。 */
export function tierOfTask(md: string, id: string): string | null {
  const rows = parseMainTable(md);
  const hit = (x: string) => rows.find((r) => leadingId(r.task) === x)?.tier ?? null;
  return hit(id) ?? (id.endsWith('b') ? hit(id.slice(0, -1)) : null);
}

const depsDone = (rows: QueueRow[], deps: string): boolean => {
  const d = deps.trim();
  if (!d || d === '无' || d.startsWith('无（')) return true;
  const done = (p: string) =>
    p.endsWith('✅') ||
    (rows.find((r) => leadingId(r.task) === p)?.status.startsWith('已完成') ?? false);
  return d
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .every(done);
};

/** 状态 → 这一行该谁做（`null` = 不给）。 */
const kindOf = (s: string): TurnKind | null => {
  if (s.startsWith('测试待审（整合方）') || s.startsWith('待复审（整合方）')) {
    return 'integrator-review';
  }
  if (s.startsWith('进行中（') || s.startsWith('待审（Codex 额度）')) return 'developer-continue';
  if (s.startsWith('待领')) return 'developer-claim';
  return null;
};
const turnOf = (role: Role, kind: TurnKind, r: QueueRow): Turn =>
  ({ role, kind, taskId: r.no, task: r.task, status: r.status }) as Turn;

export function decideNextTurn(md: string, state: RelayState, now: Date): Turn | Idle {
  if (state.stoppedReason) return { idle: 'stopped' };
  const rows = parseMainTable(md);
  const paused = (r: Role) => {
    const u = state.pausedUntil?.[r];
    return !!u && Date.parse(u) > now.getTime();
  };
  const iOk = !paused('integrator');
  const dOk = !paused('developer');
  if (iOk) {
    const r = rows.find((x) => kindOf(x.status) === 'integrator-review');
    if (r) return turnOf('integrator', 'integrator-review', r);
  }
  if (dOk) {
    const r =
      rows.find((x) => kindOf(x.status) === 'developer-continue') ??
      rows.find((x) => kindOf(x.status) === 'developer-claim' && depsDone(rows, x.deps));
    if (r) return turnOf('developer', kindOf(r.status)!, r);
  }
  if (!iOk && !dOk) return { idle: 'all-paused' };
  if (rows.some((r) => !r.status.startsWith('已完成'))) return { idle: 'all-blocked' };
  return { idle: 'queue-empty' };
}
