/**
 * K2b：驾驶舱快照的队列、项目与装配（规格 docs/委派/K2-驾驶舱快照.md）。
 * relay 部分在 K2a 的 ./relay.ts；队列只读 origin/main，项目读库，不新增网络访问。
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as C from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { readProjectActivity } from './activity.js';
import { readQuotas } from './quotas.js';
import { readRelaySnapshot } from './relay.js';

type QueueRow = { no: string; task: string; status: string };

const okHealth = (readAt: string): C.SourceHealth => ({
  status: 'ok',
  readAt,
  lastEventAt: null,
  note: null,
});

const cellsOf = (line: string): string[] | null => {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
};

/** 队列主表：行为照 relay 的 parseMainTable（core 不反向依赖 relay）。 */
function parseMainTable(md: string): QueueRow[] {
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
      rows.push({ no: cell('序号'), task: cell('任务'), status: cell('状态') });
    }
    return rows;
  }
  return [];
}

function readQueue(repo: string, now: Date) {
  const health = okHealth(now.toISOString());
  const rows: QueueRow[] = [];
  const attention: C.AttentionItem[] = [];
  if (!repo.trim()) {
    health.status = 'missing';
    health.note = '没有设置 IXAEON 仓库路径（cockpit.ixaeon_repo）';
    return { health, rows, attention };
  }
  // 只认 origin/main（和 relay 一致），不 fetch；10 秒超时，照 runtime/projectBrief.ts。
  const r = spawnSync('git', ['-C', repo, 'show', 'origin/main:docs/委派/队列.md'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0 || !r.stdout) {
    health.status = 'error';
    health.note = `读不到 origin/main 上的队列：${(r.stderr ?? '').trim() || `git 退出码 ${r.status ?? '超时'}`}`;
    return { health, rows, attention };
  }
  rows.push(...parseMainTable(r.stdout));
  for (const row of rows) {
    if (!row.status.startsWith('等用户')) continue;
    attention.push({
      kind: 'queue_user',
      project: null,
      text: `${row.task}（第 ${row.no} 行）：${row.status}`,
      since: null,
    });
  }
  return { health, rows, attention };
}

function readProjects(db: CoreDatabase, now: Date) {
  const readAt = now.toISOString();
  try {
    const rows = db
      .prepare(
        'SELECT id, name, status, description, current_state, updated_at, root_path FROM projects ORDER BY created_at',
      )
      .all() as Array<{
      id: string;
      name: string;
      status: string;
      description: string | null;
      current_state: string | null;
      updated_at: string;
      root_path: string | null;
    }>;
    const group = (status: string) =>
      rows
        .filter((r) => r.status === status)
        .map((r): C.ProjectCard => ({
          id: r.id,
          name: r.name,
          status: r.status,
          description: r.description,
          currentState: r.current_state,
          updatedAt: r.updated_at,
          // K4：每组都带；没登记读取的 readable=false，不跑 git。
          activity: readProjectActivity(db, r.id, r.root_path),
        }));
    const lastEventAt = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '');
    return {
      health: { status: 'ok' as const, readAt, lastEventAt: lastEventAt || null, note: null },
      active: group('active'),
      paused: group('paused'),
      archived: group('archived'),
    };
  } catch {
    return {
      health: { status: 'error' as const, readAt, lastEventAt: null, note: '读项目表失败' },
      active: [] as C.ProjectCard[],
      paused: [] as C.ProjectCard[],
      archived: [] as C.ProjectCard[],
    };
  }
}

/**
 * 规格契约：`buildCockpitSnapshot(db, { relayDir, ixaeonRepo, now? })`。
 * `ixaeonRepo` 只认参数（设置项是 IPC 那一层的事，空串 = 没设）；`relayDir` 空串时用
 * `IXAEON_RELAY_DIR`、默认 `~/.ixaeon/relay`。
 *
 * K4 起返回 Promise：额度要等 QuotaHub 的 HTTP 回答，同步等会卡住事件循环（同进程的
 * 合成服务回不了话）。项目活动仍是同步跑 git。
 */
export async function buildCockpitSnapshot(
  db: CoreDatabase,
  opts: { relayDir: string; ixaeonRepo: string; now?: Date },
): Promise<C.CockpitSnapshot> {
  const now = opts.now ?? new Date();
  const dir =
    opts.relayDir.trim() ||
    process.env.IXAEON_RELAY_DIR?.trim() ||
    join(homedir(), '.ixaeon', 'relay');
  const relay = readRelaySnapshot(dir, now);
  const queue = readQueue(opts.ixaeonRepo, now);
  const projects = readProjects(db, now);
  const quotas = await readQuotas(db, now);
  const attention = [...relay.attention, ...queue.attention];
  const hasWork = queue.rows.some(
    (r) => r.status.startsWith('待领') || r.status.startsWith('进行中（'),
  );
  if (
    relay.health.status === 'ok' &&
    queue.health.status === 'ok' &&
    relay.lastEndedAt &&
    !relay.paused &&
    hasWork &&
    now.getTime() - Date.parse(relay.lastEndedAt) > 2 * 3_600_000
  ) {
    relay.health.status = 'stale';
    attention.push({
      kind: 'relay_stale',
      project: null,
      text: '最后一棒结束已超过 2 小时，队列里还有要做的，可能停了',
      since: relay.lastEndedAt,
    });
  }
  return {
    generatedAt: now.toISOString(),
    sources: {
      relay: relay.health,
      queue: queue.health,
      projects: projects.health,
      quotas: quotas.health,
    },
    attention,
    running: relay.running,
    projects: { active: projects.active, paused: projects.paused, archived: projects.archived },
    recent: relay.recent,
    today: { finishedTurns: relay.finishedTurns },
    quotas: quotas.cards,
  };
}
