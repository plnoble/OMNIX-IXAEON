/**
 * K2a：驾驶舱快照的 relay 部分（规格 docs/委派/K2-驾驶舱快照.md）。
 * 只读 lock.json / ledger.jsonl / state.json；turns/ 只看目录名和文件修改时间，
 * config.json、feishu.json、inbox.jsonl 和 turns/ 下的内容都不读。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type * as C from '@ixaeon/contracts';

type Row = {
  turn: number;
  role: string;
  kind?: string;
  taskId: string;
  endedAt: string;
  exitCode: number | null;
  timedOut?: boolean;
  quotaHit?: boolean;
  statusAfter?: string | null;
};
type State = { stoppedReason?: string | null; pausedUntil?: Record<string, string | undefined> };
type Lock = { pid: number; startedAt: string };

const HOUR = 3_600_000;
const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 照 relay 的 beijingDay；core 不反向依赖 relay。 */
const beijingDay = (t: number): string => {
  const d = new Date(t + 8 * HOUR);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
};
/** 照 relay 的 pidAlive：EPERM 也算活着。 */
const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const load = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
};
const okHealth = (readAt: string): C.SourceHealth => ({
  status: 'ok',
  readAt,
  lastEventAt: null,
  note: null,
});
const att = (
  kind: C.AttentionItem['kind'],
  text: string,
  since: string | null = null,
): C.AttentionItem => ({ kind, project: null, text, since });
const run = (
  kind: C.RunningItem['kind'],
  text: string,
  extra: Partial<Omit<C.RunningItem, 'kind' | 'text'>> = {},
): C.RunningItem => ({
  kind,
  role: null,
  taskId: null,
  startedAt: null,
  until: null,
  text,
  ...extra,
});

/** turns/ 下的编号目录，只看目录名与文件修改时间。 */
function listTurnDirs(root: string): Array<{ turn: number; at: string }> {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ turn: number; at: string }> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(root, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      let at = st.mtime.toISOString();
      for (const f of readdirSync(dir)) {
        const fi = statSync(join(dir, f));
        if (fi.isFile() && fi.mtime.getTime() > Date.parse(at)) at = fi.mtime.toISOString();
      }
      out.push({ turn: Number(name), at });
    } catch {
      /* 读不到的目录跳过 */
    }
  }
  return out.sort((a, b) => a.turn - b.turn);
}

const OUTCOME_ZH = {
  done: '完成',
  failed: '失败',
  timeout: '超时',
  quota: '额度用完',
  other: '结束',
};
const outcomeOf = (r: Row): C.RecentEvent['outcome'] =>
  r.quotaHit
    ? 'quota'
    : r.timedOut
      ? 'timeout'
      : r.exitCode === 0
        ? 'done'
        : r.exitCode == null
          ? 'other'
          : 'failed';

/** 飞书回复棒的 statusAfter 是整合方对用户原话的概括，不进快照（条件 11）。 */
function toRecent(r: Row): C.RecentEvent {
  const outcome = outcomeOf(r);
  return {
    at: r.endedAt,
    role: r.role,
    taskId: r.taskId ?? null,
    outcome,
    text:
      r.kind === 'integrator-inbox'
        ? `第 ${r.turn} 棒：处理了你在飞书里的回复`
        : `第 ${r.turn} 棒（${r.role}，任务 ${r.taskId ?? '—'}）：${r.statusAfter ?? OUTCOME_ZH[outcome]}`,
  };
}

/** relay 数据目录的只读快照：健康状态、要提醒的、在跑的、最近几棒、今天的完成数。 */
export function readRelaySnapshot(dir: string, now: Date) {
  const health = okHealth(now.toISOString());
  const attention: C.AttentionItem[] = [];
  const running: C.RunningItem[] = [];
  const out = {
    health,
    attention,
    running,
    recent: [] as C.RecentEvent[],
    finishedTurns: 0,
    lastEndedAt: null as string | null,
    paused: false,
  };
  if (!existsSync(dir)) {
    health.status = 'missing';
    health.note = '没有找到 relay 数据目录';
    return out;
  }
  const statePath = join(dir, 'state.json');
  const lockPath = join(dir, 'lock.json');
  const state = existsSync(statePath) ? load<State>(statePath) : {};
  if (existsSync(statePath) && !state) {
    health.status = 'error';
    health.note = 'state.json 读不出来（解析失败）';
  }
  const lock = existsSync(lockPath) ? load<Lock>(lockPath) : null;
  if (existsSync(lockPath) && !lock) {
    health.status = 'error';
    health.note = health.note ?? 'lock.json 读不出来（解析失败）';
  }
  const up = !!lock && pidAlive(lock.pid);
  if (up && lock) {
    running.push(
      run('relay', `调度器在转（进程 ${lock.pid}），从 ${hhmm(lock.startedAt)} 起`, {
        startedAt: lock.startedAt,
      }),
    );
  } else if (lock) {
    attention.push(
      att(
        'relay_down',
        `调度器进程不在了，锁文件残留（进程 ${lock.pid}，从 ${hhmm(lock.startedAt)} 起）`,
        lock.startedAt,
      ),
    );
  }
  for (const [role, until] of Object.entries(state?.pausedUntil ?? {})) {
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) continue;
    if (Date.parse(until) <= now.getTime()) continue;
    out.paused = true;
    running.push(run('paused_role', `额度暂停到 ${hhmm(until)}`, { role, until }));
  }
  if (state?.stoppedReason) {
    attention.push(att('relay_stopped', `调度器停了：${state.stoppedReason}`));
  }
  const ledgerPath = join(dir, 'ledger.jsonl');
  let rows: Row[] = [];
  if (existsSync(ledgerPath)) {
    try {
      rows = readFileSync(ledgerPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-200)
        .map((l) => JSON.parse(l) as Row);
    } catch {
      health.status = 'error';
      health.note = health.note ?? 'ledger.jsonl 读不出来（解析失败）';
    }
  }
  const last = rows.at(-1);
  out.lastEndedAt = last && !Number.isNaN(Date.parse(last.endedAt)) ? last.endedAt : null;
  health.lastEventAt = out.lastEndedAt;
  const today = beijingDay(now.getTime());
  out.finishedTurns = rows.filter((r) => {
    const t = Date.parse(r.endedAt);
    return !Number.isNaN(t) && beijingDay(t) === today;
  }).length;
  out.recent = [...rows]
    .sort((a, b) => (Date.parse(b.endedAt) || 0) - (Date.parse(a.endedAt) || 0))
    .slice(0, 20)
    .map(toRecent);
  const lastTurn = rows.reduce((m, r) => Math.max(m, Number(r.turn) || 0), 0);
  for (const t of listTurnDirs(join(dir, 'turns')).filter((x) => x.turn > lastTurn)) {
    if (up) {
      const text = `第 ${t.turn} 棒在跑（最后输出于 ${hhmm(t.at)}）`;
      running.push(run('turn', text, { startedAt: t.at }));
    } else {
      attention.push(
        att(
          'turn_unfinished',
          `第 ${t.turn} 棒没有跑完，只有交代文件 / 最后输出于 ${hhmm(t.at)}`,
          t.at,
        ),
      );
    }
  }
  return out;
}
