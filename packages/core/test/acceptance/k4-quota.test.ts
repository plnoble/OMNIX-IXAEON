/**
 * K4 验收（额度）：规格 docs/委派/K4-额度与项目活动.md，B 档——先只推测试。
 *
 * 每个 it 对应规格「验收条件」里的一条：
 * 条件 1：没配 `cockpit.quotahub_url` → quotas 来源 missing，note「未连接 QuotaHub」；其他部分正常。
 * 条件 2：合成 HTTP 服务返回 2 个账号 → 字段按契约映射；`resetAt` 原样给出（界面据此算倒计时，
 *         契约里没有倒计时字段，快照只保留 `reset_at` 这个时刻）。
 * 条件 3：`quotahub_url` 是 `http://example.com` → 被拒绝，测试证明没有发出请求。
 * 条件 4：合成服务 5 秒才响应 → 3 秒超时，来源 error，快照照常返回。
 * 条件 5：返回里夹带 cookie / token（以及别的没列出的字段）→ 快照 JSON 里找不到这些值或字段。
 * 条件 6：手动登记一条 Claude 额度 → 出现在 quotas 里，`source = 'manual'`。
 * 条件 8：`quotahub_url` 带路径（`/api/refresh`）或用户名密码 → 被拒绝，没发请求。
 * 约束（规格「约束」最后两条）：手动额度 JSON 坏了（不是 JSON / 形状不对）→ 当没有、quotas
 *         来源记 error 写原因、不抛错；没配 URL 时也不抛错。
 *
 * 实现接缝：`buildCockpitSnapshot(db, { relayDir, ixaeonRepo, now? })` 照 K2 不变；K4 新加的两个
 * 设置项从 `app_settings` 读（设置页写的就是这两个键）：`cockpit.quotahub_url`、`cockpit.manual_quotas`。
 * 手动额度的 JSON 是一个数组，每项照设置页表单：
 *   { account, window, resetAt, expiresAt, registeredAt, note? }
 * 「登记于 N 天前」用 `registeredAt`，映射到 `QuotaCard.collectedAt`。
 *
 * 先测试后实现：`packages/core/src/cockpit/snapshot.ts` 现在没有额度那块，整合方锁定这些测试之后才写。
 * 测试在实现写出来之前逐条是红的（不是靠类型检查过的）。
 */
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  migrate,
  openDatabase,
  ProjectService,
  setSetting,
  type CoreDatabase,
} from '../../src/index.js';

type SourceStatus = 'ok' | 'stale' | 'missing' | 'error';

interface SourceHealth {
  status: SourceStatus;
  readAt: string;
  lastEventAt: string | null;
  note: string | null;
}

interface QuotaWindow {
  name: string;
  usedPercent: number | null;
  resetAt: string | null;
}

interface QuotaCard {
  source: 'quotahub' | 'manual';
  provider: string;
  account: string;
  status: string;
  plan: string | null;
  expiresAt: string | null;
  windows: QuotaWindow[];
  collectedAt: string;
}

interface ProjectCard {
  id: string;
  name: string;
  status: string;
  description: string | null;
  currentState: string | null;
  updatedAt: string;
}

interface CockpitSnapshot {
  generatedAt: string;
  sources: {
    relay: SourceHealth;
    queue: SourceHealth;
    projects: SourceHealth;
    quotas: SourceHealth;
  };
  attention: Array<{ kind: string; text: string }>;
  running: Array<{ kind: string; text: string }>;
  projects: { active: ProjectCard[]; paused: ProjectCard[]; archived: ProjectCard[] };
  recent: Array<{ at: string; taskId: string | null; outcome: string; text: string }>;
  today: { finishedTurns: number };
  quotas: QuotaCard[];
}

type BuildCockpitSnapshot = (
  db: CoreDatabase,
  opts: { relayDir: string; ixaeonRepo: string; now?: Date },
) => CockpitSnapshot;

let buildSnapshot: BuildCockpitSnapshot | null = null;

beforeAll(async () => {
  try {
    // 实现写出来之前返回类型还没有 quotas，先按测试契约转一次；写出来后类型就对上了。
    const mod = (await import('../../src/cockpit/snapshot.js')) as unknown as {
      buildCockpitSnapshot?: BuildCockpitSnapshot;
    };
    buildSnapshot =
      typeof mod.buildCockpitSnapshot === 'function' ? mod.buildCockpitSnapshot : null;
  } catch {
    buildSnapshot = null;
  }
});

/** 拿到实现；还没有实现时给出能看懂的原因，而不是一句 undefined is not a function。 */
function build(): BuildCockpitSnapshot {
  if (!buildSnapshot) {
    throw new Error(
      'buildCockpitSnapshot 还没实现：本任务是 B 档，先只推测试，实现等整合方锁定后写（见规格 K4）',
    );
  }
  return buildSnapshot;
}

const QUOTA_URL = 'cockpit.quotahub_url';
const MANUAL_QUOTAS = 'cockpit.manual_quotas';

const NOW = new Date('2026-10-31T12:00:00+08:00');

const dirs: string[] = [];
const dbs: CoreDatabase[] = [];
const servers: Server[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function freshDb(): CoreDatabase {
  const db = openDatabase(join(tempDir('ixaeon-k4-db-'), 'ixaeon.db'));
  migrate(db);
  dbs.push(db);
  return db;
}

/** 一个不存在的 relay 目录：relay 来源 missing，不碰用户的真实数据。 */
function noRelayDir(): string {
  return join(tempDir('ixaeon-k4-relay-'), '根本没有这个目录');
}

function snapshotOf(db: CoreDatabase): CockpitSnapshot {
  return build()(db, { relayDir: noRelayDir(), ixaeonRepo: '', now: NOW });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) {
    try {
      if (db.open) db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

// ---------------------------------------------------------------------------
// 合成 QuotaHub 服务
// ---------------------------------------------------------------------------

interface TestServer {
  url: string;
  port: number;
  requests: Array<{ method: string; url: string }>;
}

async function startQuotaHub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const requests: Array<{ method: string; url: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('合成服务没拿到端口');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port, requests };
}

function jsonHandler(body: unknown): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    const text = JSON.stringify(body);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };
}

const CODEX_ACCOUNT = {
  provider: 'codex',
  account: 'acct-codex',
  account_name: '合成 Codex 账号',
  status: 'ok',
  plan: { name: 'Plus', expires_at: '2026-12-01T00:00:00.000Z' },
  quota_windows: [
    {
      id: '5h',
      name: '5 小时',
      type: 'rolling',
      used: 42.5,
      limit: 100,
      remaining_percent: 57.5,
      reset_at: '2026-10-31T07:00:00.000Z',
      note: null,
    },
    {
      id: 'weekly',
      name: '每周',
      type: 'fixed',
      used: null,
      limit: null,
      remaining_percent: null,
      reset_at: null,
      note: '上限未暴露',
    },
  ],
  data_level: 'A',
  error: null,
  collected_at: '2026-10-31T03:55:00.000Z',
};

const VOLC_ACCOUNT = {
  provider: 'volcengine',
  account: 'acct-volc',
  account_name: '合成火山账号',
  status: 'cookie_expired',
  plan: { name: 'coding_plan', expires_at: null },
  quota_windows: [
    {
      id: 'weekly',
      name: '每周',
      type: 'fixed',
      used: 0,
      limit: 100,
      remaining_percent: 100,
      reset_at: '2026-11-01T00:00:00.000Z',
      note: null,
    },
  ],
  data_level: 'C',
  error: null,
  collected_at: '2026-10-31T03:50:00.000Z',
};

// ---------------------------------------------------------------------------

describe('K4 额度（验收条件 1–6、8）', () => {
  it('条件 1：没配 quotahub_url → quotas 来源 missing，note「未连接 QuotaHub」，其他部分正常', () => {
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 合成项目', rootPath: null, description: null });

    const without = snapshotOf(db);
    expect(without.sources.quotas.status).toBe('missing');
    expect(without.sources.quotas.note).toBe('未连接 QuotaHub');
    expect(without.quotas).toEqual([]);
    expect(without.sources.projects.status).toBe('ok');
    expect(without.projects.active).toHaveLength(1);
    expect(without.sources.relay.status).toBe('missing');
    expect(Number.isNaN(Date.parse(without.generatedAt))).toBe(false);

    // 空串也是「没配」：默认空表示关闭。
    setSetting(db, QUOTA_URL, '');
    const empty = snapshotOf(db);
    expect(empty.sources.quotas.status).toBe('missing');
    expect(empty.sources.quotas.note).toBe('未连接 QuotaHub');
    expect(empty.quotas).toEqual([]);
    expect(empty.sources.projects.status).toBe('ok');
  });

  it('条件 2：合成服务返回 2 个账号 → 字段映射正确，resetAt 原样给出', async () => {
    const service = await startQuotaHub(
      jsonHandler({
        server_time: '2026-10-31T04:00:00.000Z',
        refreshing: false,
        accounts: [CODEX_ACCOUNT, VOLC_ACCOUNT],
      }),
    );
    const db = freshDb();
    setSetting(db, QUOTA_URL, service.url);

    const snap = snapshotOf(db);

    expect(snap.sources.quotas.status).toBe('ok');
    expect(Number.isNaN(Date.parse(snap.sources.quotas.readAt))).toBe(false);
    expect(service.requests).toEqual([{ method: 'GET', url: '/api/snapshots' }]);
    expect(snap.quotas).toHaveLength(2);

    const byAccount = new Map(snap.quotas.map((q) => [q.account, q]));
    expect(byAccount.get('合成 Codex 账号')).toEqual({
      source: 'quotahub',
      provider: 'codex',
      account: '合成 Codex 账号',
      status: 'ok',
      plan: 'Plus',
      expiresAt: '2026-12-01T00:00:00.000Z',
      windows: [
        { name: '5 小时', usedPercent: 42.5, resetAt: '2026-10-31T07:00:00.000Z' },
        { name: '每周', usedPercent: null, resetAt: null },
      ],
      collectedAt: '2026-10-31T03:55:00.000Z',
    });
    expect(byAccount.get('合成火山账号')).toEqual({
      source: 'quotahub',
      provider: 'volcengine',
      account: '合成火山账号',
      status: 'cookie_expired',
      plan: 'coding_plan',
      expiresAt: null,
      windows: [{ name: '每周', usedPercent: 0, resetAt: '2026-11-01T00:00:00.000Z' }],
      collectedAt: '2026-10-31T03:50:00.000Z',
    });

    // 倒计时由界面按 resetAt 算；快照里给的是可解析的 ISO 时刻。
    const resetAt = byAccount.get('合成 Codex 账号')!.windows[0]!.resetAt!;
    expect(Number.isNaN(Date.parse(resetAt))).toBe(false);
    expect(Date.parse(resetAt)).toBe(Date.parse('2026-10-31T07:00:00.000Z'));
  });

  it('条件 3：quotahub_url 是别的机器（http://example.com）→ 拒绝，没有发出请求', () => {
    const db = freshDb();
    setSetting(db, QUOTA_URL, 'http://example.com');
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error('别的机器不该被请求');
    });

    const snap = snapshotOf(db);
    expect(calls).toEqual([]);
    expect(snap.quotas).toEqual([]);
    expect(snap.sources.quotas.status).not.toBe('ok');
  });

  it('条件 4：合成服务 5 秒才响应 → 3 秒超时，来源 error，快照照常返回', async () => {
    const service = await startQuotaHub((_req, res) => {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accounts: [CODEX_ACCOUNT] }));
        } catch {
          /* 已经超时断开 */
        }
      }, 5_000);
      timer.unref();
    });
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 超时项目', rootPath: null, description: null });
    setSetting(db, QUOTA_URL, service.url);

    const started = Date.now();
    const snap = snapshotOf(db);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(4_700);
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    // 快照照常返回：别的来源和部分都在。
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
    expect(snap.sources.relay.status).toBe('missing');
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  }, 20_000);

  it('条件 5：返回里夹带 cookie / token / 别的没列出的字段 → 快照里找不到', async () => {
    const service = await startQuotaHub(
      jsonHandler({
        server_time: '2026-10-31T04:00:00.000Z',
        refreshing: false,
        cookie: 'COOKIE-XYZ',
        token: 'TOKEN-XYZ',
        credentials: { cookie: 'COOKIE-XYZ', token: 'TOKEN-XYZ' },
        accounts: [
          {
            ...CODEX_ACCOUNT,
            cookie: 'COOKIE-XYZ',
            token: 'TOKEN-XYZ',
            credentials: { token: 'TOKEN-XYZ' },
            health: { cookie: 'COOKIE-XYZ' },
            reminders: [{ token: 'TOKEN-XYZ' }],
          },
        ],
      }),
    );
    const db = freshDb();
    setSetting(db, QUOTA_URL, service.url);

    const snap = snapshotOf(db);
    const json = JSON.stringify(snap);

    expect(json).not.toContain('COOKIE-XYZ');
    expect(json).not.toContain('TOKEN-XYZ');
    expect(json).not.toContain('remaining_percent');
    expect(json).not.toContain('server_time');
    expect(json).not.toContain('refreshing');
    expect(snap.quotas).toHaveLength(1);

    // 契约只列了这些字段：多一个都算把 QuotaHub 的返回原样搬进来了。
    const card = snap.quotas[0]!;
    expect(Object.keys(card).sort()).toEqual([
      'account',
      'collectedAt',
      'expiresAt',
      'plan',
      'provider',
      'source',
      'status',
      'windows',
    ]);
    expect(Object.keys(card.windows[0]!).sort()).toEqual(['name', 'resetAt', 'usedPercent']);
    expect(card.account).toBe('合成 Codex 账号');
    expect(card.windows[0]!.usedPercent).toBe(42.5);
  });

  it('条件 6：手动登记一条 Claude 额度 → 出现在 quotas，source = manual', () => {
    const db = freshDb();
    setSetting(
      db,
      MANUAL_QUOTAS,
      JSON.stringify([
        {
          account: 'Claude 合成账号',
          window: '5 小时',
          resetAt: '2026-10-31T17:00:00.000Z',
          expiresAt: '2026-11-30T00:00:00.000Z',
          registeredAt: '2026-10-28T12:00:00.000Z',
          note: 'NOTE-XYZ 合成备注',
        },
      ]),
    );

    const snap = snapshotOf(db);
    expect(snap.quotas).toHaveLength(1);
    const card = snap.quotas[0]!;
    expect(card).toMatchObject({
      source: 'manual',
      account: 'Claude 合成账号',
      expiresAt: '2026-11-30T00:00:00.000Z',
      windows: [{ name: '5 小时', usedPercent: null, resetAt: '2026-10-31T17:00:00.000Z' }],
      // 「登记于 N 天前」要有登记时刻；用 registeredAt，不拿快照时间冒充。
      collectedAt: '2026-10-28T12:00:00.000Z',
    });
    expect(typeof card.provider).toBe('string');
    expect(Object.keys(card).sort()).toEqual([
      'account',
      'collectedAt',
      'expiresAt',
      'plan',
      'provider',
      'source',
      'status',
      'windows',
    ]);
    // 备注只留在设置项里；契约没有这个字段，快照不该带出去。
    expect(JSON.stringify(snap)).not.toContain('NOTE-XYZ');
  });

  it('条件 8：地址带路径（/api/refresh）或用户名密码 → 拒绝，没发请求', async () => {
    const service = await startQuotaHub(jsonHandler({ accounts: [] }));
    const db = freshDb();
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error('被拒绝的地址不该发请求');
    });

    const rejected = [
      `${service.url}/api/refresh`,
      `${service.url}/?x=1`,
      `http://user:pw@127.0.0.1:${service.port}`,
    ];
    for (const url of rejected) {
      setSetting(db, QUOTA_URL, url);
      const snap = snapshotOf(db);
      expect(service.requests, url).toEqual([]);
      expect(snap.quotas, url).toEqual([]);
      expect(snap.sources.quotas.status, url).not.toBe('ok');
    }
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 规格「约束」里写了、编号条件没单列的：手动额度 JSON 坏了不能抛错
// ---------------------------------------------------------------------------

describe('K4 额度（约束：手动额度坏了不抛错）', () => {
  it('不是 JSON：当没有、quotas 来源 error 写原因，其他来源照常', () => {
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 坏 JSON 项目', rootPath: null, description: null });
    setSetting(db, MANUAL_QUOTAS, '{这不是 JSON');

    const snap = snapshotOf(db);
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
  });

  it('形状不对（字段类型错）：zod 校验不通过，同样记 error，不抛错', () => {
    const db = freshDb();
    setSetting(
      db,
      MANUAL_QUOTAS,
      JSON.stringify([{ account: 123, window: ['不是字符串'], resetAt: '不是时间' }]),
    );

    const snap = snapshotOf(db);
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });
});