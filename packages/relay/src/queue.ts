/** 队列主表（第 4 条）：解析、任务号 → 档位、依赖算不算完成，以及「定下一棒」。 */
import { createHash } from 'node:crypto';
import type { Idle, RelayState, Role, Turn, TurnKind } from './types.js';

export interface QueueRow {
  no: string;
  task: string;
  tier: string;
  deps: string;
  status: string;
}
/** 主表一行：除了 `parseMainTable` 读的那几栏，还有规格链接和原样的六格（核对「任何一格变了」用）。 */
export interface MainTableRow extends QueueRow {
  link: string;
  cells: string[];
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

/**
 * 只认第一张表头是「序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态」的表（主表）。
 * 返回六格原样，顺序照表头。
 */
export function parseMainTableFull(md: string): MainTableRow[] {
  const lines = md.split(/\r?\n/);
  const want = ['序号', '任务', '委派单或规格', '档位', '依赖', '状态'];
  for (let i = 0; i < lines.length; i++) {
    const head = cellsOf(lines[i]!);
    if (!head || !want.every((h) => head.includes(h))) continue;
    const rows: MainTableRow[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const c = cellsOf(lines[j]!);
      if (!c) break;
      if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;
      const cell = (h: string) => c[head.indexOf(h)] ?? '';
      const [no, task, link, tier, deps, status] = [
        '序号',
        '任务',
        '委派单或规格',
        '档位',
        '依赖',
        '状态',
      ].map(cell);
      rows.push({
        no: no!,
        task: task!,
        link: link!,
        tier: tier!,
        deps: deps!,
        status: status!,
        cells: c,
      });
    }
    return rows;
  }
  return [];
}

/** 只读解析结果的几栏（原来的形状不变）。 */
export function parseMainTable(md: string): QueueRow[] {
  return parseMainTableFull(md).map(({ no, task, tier, deps, status }) => ({
    no,
    task,
    tier,
    deps,
    status,
  }));
}

/** 任务号 = 「任务」那一格的前导词（`L1 接力调度器核心…` → `L1`）。 */
export const leadingId = (task: string): string => task.trim().split(/\s+/)[0] ?? '';

/** 北京时间的日历日写法（`10月23日`），照 daily.ts 的写法。 */
export const beijingDay = (t: number): string => {
  const d = new Date(t + 8 * 3_600_000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};

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

/**
 * L9 契约第 4 条：原来要回 `queue-empty` / `all-blocked` 时，三条都成立就派规划棒——
 * 配了 `planPerDay`、整合方没在歇、当天次数没到、队列和上次派规划棒时不一样。
 */
export function decideNextTurn(
  md: string,
  state: RelayState,
  now: Date,
  opts: {
    planPerDay?: number;
    /** L16 契约第 6 条：inbox.jsonl 里还没办的条数，由 runOnce 算出来。 */ inboxPending?: number;
  } = {},
): Turn | Idle {
  if (state.stoppedReason) return { idle: 'stopped' };
  const rows = parseMainTable(md);
  const paused = (r: Role) => {
    const u = state.pausedUntil?.[r];
    return !!u && Date.parse(u) > now.getTime();
  };
  const iOk = !paused('integrator');
  const dOk = !paused('developer');
  // L16 契约第 6 条的派活位：inboxPending 由 runOnce 算出来传进来；行为在实现阶段补（先只推测试）。
  void opts.inboxPending;
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
  const idle: Idle['idle'] = rows.some((r) => !r.status.startsWith('已完成'))
    ? 'all-blocked'
    : 'queue-empty';
  const perDay = opts.planPerDay;
  if (iOk && typeof perDay === 'number' && perDay > 0) {
    const plan = state.plan;
    const today = beijingDay(now.getTime());
    const queueHash = createHash('sha256').update(md, 'utf8').digest('hex');
    const mayPlan = !plan || plan.date !== today || plan.count < perDay;
    if (mayPlan && plan?.queueHash !== queueHash) {
      return {
        role: 'integrator',
        kind: 'integrator-plan',
        taskId: 'plan',
        task: '找下一批活',
        status: idle,
      };
    }
  }
  return { idle };
}
