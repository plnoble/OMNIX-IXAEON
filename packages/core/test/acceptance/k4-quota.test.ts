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
 * 整合方审测试时（2026-10-31）：快照改成异步（`Promise<CockpitSnapshot>`，同步等不到同进程合成服务的回答）；
 * 请求经全局 fetch 发；被拒的地址记 error；补了别的主机带端口、https、没端口、500、两边都有等几条。
 * 详见规格末尾「整合方审测试时的改正与补充」。
 *
 * 实现接缝：`buildCockpitSnapshot(db, { relayDir, ixaeonRepo, now? })` 参数照 K2 不变；K4 新加的两个
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

// 整合方审测试时改（2026-10-31）：快照要等 QuotaHub 的 HTTP 回答，改成异步。同步实现在这里跑不通——
// 合成服务和快照在同一个进程，同步等待会卡住事件循环，服务永远回不了话。
type BuildCockpitSnapshot = (
  db: CoreDatabase,
  opts: { relayDir: string; ixaeonRepo: string; now?: Date },
) => Promise<CockpitSnapshot>;

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

function snapshotOf(db: CoreDatabase): Promise<CockpitSnapshot> {
  return build()(db, { relayDir: noRelayDir(), ixaeonRepo: '', now: NOW });
}

/**
 * 整合方补：请求一律经全局 `fetch` 发（条件 2 里钉住），条件 3 拦 `fetch` 才证明得了「没发请求」——
 * 不然实现换成 node:http 发到 example.com，替身一次也没被调，测试照样绿。
 */
function blockFetch(): unknown[] {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', (...args: unknown[]) => {
    calls.push(args[0]);
    return Promise.reject(new Error('被拒绝的地址不该发请求'));
  });
  return calls;
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
  /** 连上来的 TCP 连接数：https、坏请求这类到不了 request 事件的也算（整合方补）。 */
  connections: { count: number };
}

async function startQuotaHub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const requests: Array<{ method: string; url: string }> = [];
  const connections = { count: 0 };
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    handler(req, res);
  });
  server.on('connection', () => {
    connections.count += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('合成服务没拿到端口');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port, requests, connections };
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
  it('条件 1：没配 quotahub_url → quotas 来源 missing，note「未连接 QuotaHub」，其他部分正常', async () => {
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 合成项目', rootPath: null, description: null });

    const without = await snapshotOf(db);
    expect(without.sources.quotas.status).toBe('missing');
    expect(without.sources.quotas.note).toBe('未连接 QuotaHub');
    expect(without.quotas).toEqual([]);
    expect(without.sources.projects.status).toBe('ok');
    expect(without.projects.active).toHaveLength(1);
    expect(without.sources.relay.status).toBe('missing');
    expect(Number.isNaN(Date.parse(without.generatedAt))).toBe(false);

    // 空串也是「没配」：默认空表示关闭。
    setSetting(db, QUOTA_URL, '');
    const empty = await snapshotOf(db);
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
    // 整合方补：经全局 fetch 发（照转给真 fetch），条件 3 拦 fetch 才算数。
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return realFetch(input, init);
    });

    const snap = await snapshotOf(db);

    expect(snap.sources.quotas.status).toBe('ok');
    expect(Number.isNaN(Date.parse(snap.sources.quotas.readAt))).toBe(false);
    expect(service.requests).toEqual([{ method: 'GET', url: '/api/snapshots' }]);
    expect(fetched).toEqual([`${service.url}/api/snapshots`]);
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

  it('条件 3：quotahub_url 是别的机器（http://example.com）→ 拒绝，没有发出请求', async () => {
    const db = freshDb();
    setSetting(db, QUOTA_URL, 'http://example.com');
    const calls = blockFetch();

    const snap = await snapshotOf(db);
    expect(calls).toEqual([]);
    expect(snap.quotas).toEqual([]);
    // 整合方改严：配了却被拒，是 error（写原因），不是「没配」的 missing。
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
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
    const snap = await snapshotOf(db);
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

    const snap = await snapshotOf(db);
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

  it('条件 6：手动登记一条 Claude 额度 → 出现在 quotas，source = manual', async () => {
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

    const snap = await snapshotOf(db);
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
    const calls = blockFetch();

    const rejected = [
      `${service.url}/api/refresh`,
      `${service.url}/api/snapshots`,
      `${service.url}/?x=1`,
      `${service.url}#x`,
      `http://user:pw@127.0.0.1:${service.port}`,
      `http://user@127.0.0.1:${service.port}`,
      // 整合方补：只认 http，https 也拒（规格「只认 http://127.0.0.1:<端口> 或 http://localhost:<端口>」）。
      `https://127.0.0.1:${service.port}`,
      // 整合方补：没写端口的也拒（规格要「<端口>」；不写就是 80 端口上别的服务）。
      'http://127.0.0.1',
      'http://localhost',
      // 整合方补（变异检查：去掉主机判断，只靠「没写端口」也拒得掉 example.com）：别的主机带上端口照样拒。
      `http://example.com:${service.port}`,
      `http://192.168.1.10:${service.port}`,
      `http://127.0.0.2:${service.port}`,
    ];
    for (const url of rejected) {
      setSetting(db, QUOTA_URL, url);
      const snap = await snapshotOf(db);
      expect(service.requests, url).toEqual([]);
      expect(service.connections.count, url).toBe(0);
      expect(snap.quotas, url).toEqual([]);
      expect(snap.sources.quotas.status, url).toBe('error');
      expect(snap.sources.quotas.note, url).toBeTruthy();
    }
    expect(calls).toEqual([]);
  });

  it('整合方补：QuotaHub 回 500 或回的不是 JSON → 来源 error，不抛错，快照照常', async () => {
    // 500 那次回的是一份像样的快照（变异检查：只靠「解析失败」拦不住不看状态码的实现）。
    const cases = [
      { code: 500, body: JSON.stringify({ accounts: [CODEX_ACCOUNT] }) },
      { code: 200, body: '{不是 JSON' },
    ];
    for (const { code, body } of cases) {
      const service = await startQuotaHub((_req, res) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(body);
      });
      const db = freshDb();
      new ProjectService(db).create({ name: 'K4 坏回答项目', rootPath: null, description: null });
      setSetting(db, QUOTA_URL, service.url);

      const snap = await snapshotOf(db);
      expect(service.requests, body).toHaveLength(1);
      expect(snap.sources.quotas.status, body).toBe('error');
      expect(snap.sources.quotas.note, body).toBeTruthy();
      expect(snap.quotas, body).toEqual([]);
      expect(snap.projects.active, body).toHaveLength(1);
    }
  });

  it('整合方补：QuotaHub 和手动登记都有 → 两边的卡都在，手动的那张 source = manual', async () => {
    const service = await startQuotaHub(jsonHandler({ accounts: [CODEX_ACCOUNT] }));
    const db = freshDb();
    setSetting(db, QUOTA_URL, service.url);
    setSetting(
      db,
      MANUAL_QUOTAS,
      JSON.stringify([
        {
          account: 'Claude 合成账号',
          window: '每周',
          resetAt: '2026-11-05T04:00:00.000Z',
          expiresAt: '2026-11-30T00:00:00.000Z',
          registeredAt: '2026-10-30T12:00:00.000Z',
        },
      ]),
    );

    const snap = await snapshotOf(db);
    expect(snap.sources.quotas.status).toBe('ok');
    expect(snap.quotas.map((q) => [q.source, q.account]).sort()).toEqual([
      ['manual', 'Claude 合成账号'],
      ['quotahub', '合成 Codex 账号'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 规格「约束」里写了、编号条件没单列的：手动额度 JSON 坏了不能抛错
// ---------------------------------------------------------------------------

describe('K4 额度（约束：手动额度坏了不抛错）', () => {
  it('不是 JSON：当没有、quotas 来源 error 写原因，其他来源照常', async () => {
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 坏 JSON 项目', rootPath: null, description: null });
    setSetting(db, MANUAL_QUOTAS, '{这不是 JSON');

    const snap = await snapshotOf(db);
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
  });

  it('形状不对（字段类型错）：zod 校验不通过，同样记 error，不抛错', async () => {
    const db = freshDb();
    setSetting(
      db,
      MANUAL_QUOTAS,
      JSON.stringify([{ account: 123, window: ['不是字符串'], resetAt: '不是时间' }]),
    );

    const snap = await snapshotOf(db);
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });
});
