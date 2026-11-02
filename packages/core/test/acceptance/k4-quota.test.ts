/**
 * K4 验收（额度）：规格 docs/委派/K4-额度与项目活动.md，B 档。
 *
 * 整合方 2026-11-02（SUB1b 并入）：额度来源从 QuotaHub 改成本机 magpie（`GET /v1/magpie/quotas/cards`，
 * 设置项 `cockpit.magpie_url`，默认 http://127.0.0.1:3425）。K4 原来的每一条条件都留着，只换了来源、
 * 字段名和文字；新增的 magpie 专有条件（used 就是百分比、user 不进快照、刷新）在
 * `sub1b-magpie-quotas.test.ts`。
 *
 * 每个 it 对应 K4 规格「验收条件」里的一条：
 * 条件 1：没连上 magpie → quotas 来源 missing，note「没连上 magpie」；其他部分正常。
 *         默认就开：设置项为空时请求的是默认地址 `http://127.0.0.1:3425`（测试里拦住 fetch，不碰真 magpie）。
 * 条件 2：合成 HTTP 服务返回 2 张卡 → 字段按契约映射；`resetAt` 原样给出。
 * 条件 3：`magpie_url` 是 `http://example.com:3425` → 被拒绝，测试证明没有发出请求。
 * 条件 4：合成服务 5 秒才响应 → 3 秒超时，来源 error，快照照常返回。
 * 条件 5：返回里夹带 cookie / token / user（以及别的没列出的字段）→ 快照 JSON 里找不到这些值或字段。
 * 条件 6：手动登记一条 Claude 额度 → 出现在 quotas 里，`source = 'manual'`。
 * 条件 8：`magpie_url` 带路径或用户名密码 → 被拒绝，没发请求。
 * 约束：手动额度 JSON 坏了（不是 JSON / 形状不对）→ 当没有、quotas 来源记 error 写原因、不抛错。
 *
 * 实现接缝：`buildCockpitSnapshot(db, { relayDir, ixaeonRepo, now? })`；设置项从 `app_settings` 读：
 * `cockpit.magpie_url`、`cockpit.manual_quotas`。手动额度的 JSON 是一个数组，每项照设置页表单：
 *   { account, window, resetAt, expiresAt, registeredAt, note? }
 * 「登记于 N 天前」用 `registeredAt`，映射到 `QuotaCard.collectedAt`。
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
  display: string | null;
}

interface QuotaCard {
  source: 'magpie' | 'manual';
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

// 快照要等 magpie 的 HTTP 回答，所以是异步。同步实现在这里跑不通——
// 合成服务和快照在同一个进程，同步等待会卡住事件循环，服务永远回不了话。
type BuildCockpitSnapshot = (
  db: CoreDatabase,
  opts: { relayDir: string; ixaeonRepo: string; now?: Date },
) => Promise<CockpitSnapshot>;

let buildSnapshot: BuildCockpitSnapshot | null = null;

beforeAll(async () => {
  try {
    const mod = (await import('../../src/cockpit/snapshot.js')) as unknown as {
      buildCockpitSnapshot?: BuildCockpitSnapshot;
    };
    buildSnapshot =
      typeof mod.buildCockpitSnapshot === 'function' ? mod.buildCockpitSnapshot : null;
  } catch {
    buildSnapshot = null;
  }
});

/** 拿到实现；没有实现时给出能看懂的原因，而不是一句 undefined is not a function。 */
function build(): BuildCockpitSnapshot {
  if (!buildSnapshot) throw new Error('buildCockpitSnapshot 没有导出（见规格 K4）');
  return buildSnapshot;
}

/** 合成的 cookie 值（条件 5：它不许出现在快照里）。 */
const FAKE_COOKIE = 'COOKIE-' + 'XYZ';

const MAGPIE_URL = 'cockpit.magpie_url';
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
 * 请求一律经全局 `fetch` 发（条件 2 里钉住），条件 3 拦 `fetch` 才证明得了「没发请求」——
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
// 合成 magpie 服务
// ---------------------------------------------------------------------------

interface TestServer {
  url: string;
  port: number;
  requests: Array<{ method: string; url: string }>;
  /** 连上来的 TCP 连接数：https、坏请求这类到不了 request 事件的也算。 */
  connections: { count: number };
}

async function startMagpie(
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

/** 先起一个服务拿端口再关掉：这个端口上确定没人听（也确保测试不碰用户本机真的 magpie）。 */
async function deadMagpieUrl(): Promise<string> {
  const temp = await startMagpie((_req, res) => res.end());
  const server = servers.pop()!;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return temp.url;
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

const CODEX_CARD = {
  provider: 'codex',
  name: '合成 Codex 账号',
  icon: 'ICON-XYZ',
  plan: 'Plus',
  user: 'someone@example.invalid',
  kind: 'subscription',
  readAt: '2026-10-31T03:55:00.000Z',
  windows: [
    {
      name: '5 小时',
      used: 42.5,
      limit: 100,
      unit: '%',
      resetsAt: '2026-10-31T07:00:00.000Z',
      display: '42.5%',
    },
    { name: '每周', resetsAt: null, display: null },
  ],
  daily: { since: '2026-10-28', window: '5 小时', days: [] },
};

const VOLC_CARD = {
  provider: 'volcengine',
  name: '合成火山账号',
  icon: 'ICON-XYZ',
  plan: 'coding_plan',
  user: 'someone@example.invalid',
  kind: 'plan',
  readAt: '2026-10-31T03:50:00.000Z',
  windows: [
    {
      name: '每周',
      used: 0,
      limit: 100,
      unit: '%',
      resetsAt: '2026-11-01T00:00:00.000Z',
      display: '0%',
    },
  ],
};

// ---------------------------------------------------------------------------

describe('K4 额度（验收条件 1–6、8）', () => {
  it('条件 1：没连上 magpie → quotas 来源 missing，note「没连上 magpie」，其他部分正常；设置为空时请求默认地址', async () => {
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 合成项目', rootPath: null, description: null });
    setSetting(db, MAGPIE_URL, await deadMagpieUrl());

    const without = await snapshotOf(db);
    expect(without.sources.quotas.status).toBe('missing');
    expect(without.sources.quotas.note).toContain('没连上 magpie');
    expect(without.quotas).toEqual([]);
    expect(without.sources.projects.status).toBe('ok');
    expect(without.projects.active).toHaveLength(1);
    expect(without.sources.relay.status).toBe('missing');
    expect(Number.isNaN(Date.parse(without.generatedAt))).toBe(false);

    // 空串 = 默认地址（默认就开）：拦住 fetch，只看它请求了哪里，不碰真 magpie。
    setSetting(db, MAGPIE_URL, '');
    const asked: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : String(input));
      // 和真 fetch 拒绝连接时一样：TypeError('fetch failed')，原因里带 ECONNREFUSED。
      return Promise.reject(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
      );
    });
    const empty = await snapshotOf(db);
    expect(asked).toEqual(['http://127.0.0.1:3425/v1/magpie/quotas/cards']);
    expect(empty.sources.quotas.status).toBe('missing');
    expect(empty.sources.quotas.note).toContain('没连上 magpie');
    expect(empty.quotas).toEqual([]);
    expect(empty.sources.projects.status).toBe('ok');
  });

  it('条件 2：合成服务返回 2 张卡 → 字段映射正确，resetAt 原样给出', async () => {
    const service = await startMagpie(jsonHandler({ object: 'list', data: [CODEX_CARD, VOLC_CARD] }));
    const db = freshDb();
    setSetting(db, MAGPIE_URL, service.url);
    // 经全局 fetch 发（照转给真 fetch），条件 3 拦 fetch 才算数。
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return realFetch(input, init);
    });

    const snap = await snapshotOf(db);

    expect(snap.sources.quotas.status).toBe('ok');
    expect(Number.isNaN(Date.parse(snap.sources.quotas.readAt))).toBe(false);
    expect(service.requests).toEqual([{ method: 'GET', url: '/v1/magpie/quotas/cards' }]);
    expect(fetched).toEqual([`${service.url}/v1/magpie/quotas/cards`]);
    expect(snap.quotas).toHaveLength(2);

    const byAccount = new Map(snap.quotas.map((q) => [q.account, q]));
    expect(byAccount.get('合成 Codex 账号')).toEqual({
      source: 'magpie',
      provider: 'codex',
      account: '合成 Codex 账号',
      status: 'ok',
      plan: 'Plus',
      expiresAt: null,
      windows: [
        {
          name: '5 小时',
          usedPercent: 42.5,
          resetAt: '2026-10-31T07:00:00.000Z',
          display: '42.5%',
        },
        { name: '每周', usedPercent: null, resetAt: null, display: null },
      ],
      collectedAt: '2026-10-31T03:55:00.000Z',
    });
    expect(byAccount.get('合成火山账号')).toEqual({
      source: 'magpie',
      provider: 'volcengine',
      account: '合成火山账号',
      status: 'ok',
      plan: 'coding_plan',
      expiresAt: null,
      windows: [
        { name: '每周', usedPercent: 0, resetAt: '2026-11-01T00:00:00.000Z', display: '0%' },
      ],
      collectedAt: '2026-10-31T03:50:00.000Z',
    });

    // 倒计时由界面按 resetAt 算；快照里给的是可解析的 ISO 时刻。
    const resetAt = byAccount.get('合成 Codex 账号')!.windows[0]!.resetAt!;
    expect(Number.isNaN(Date.parse(resetAt))).toBe(false);
    expect(Date.parse(resetAt)).toBe(Date.parse('2026-10-31T07:00:00.000Z'));
  });

  it('条件 3：magpie_url 是别的机器（http://example.com:3425）→ 拒绝，没有发出请求', async () => {
    const db = freshDb();
    setSetting(db, MAGPIE_URL, 'http://example.com:3425');
    const calls = blockFetch();

    const snap = await snapshotOf(db);
    expect(calls).toEqual([]);
    expect(snap.quotas).toEqual([]);
    // 配了却被拒，是 error（写原因），不是「没连上」的 missing。
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
  });

  it('条件 4：合成服务 5 秒才响应 → 3 秒超时，来源 error，快照照常返回', async () => {
    const service = await startMagpie((_req, res) => {
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [CODEX_CARD] }));
        } catch {
          /* 已经超时断开 */
        }
      }, 5_000);
      timer.unref();
    });
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 超时项目', rootPath: null, description: null });
    setSetting(db, MAGPIE_URL, service.url);

    const started = Date.now();
    const snap = await snapshotOf(db);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(4_700);
    // 请求发出去了、对面没回：不是「没开」，记 error（和没连上的 missing 分开）。
    expect(service.requests).toHaveLength(1);
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    // 快照照常返回：别的来源和部分都在。
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
    expect(snap.sources.relay.status).toBe('missing');
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  }, 20_000);

  it('条件 5：返回里夹带 cookie / token / user / 别的没列出的字段 → 快照里找不到', async () => {
    const service = await startMagpie(
      jsonHandler({
        object: 'list',
        cookie: FAKE_COOKIE,
        token: 'TOKEN-XYZ',
        credentials: { cookie: FAKE_COOKIE, token: 'TOKEN-XYZ' },
        data: [
          {
            ...CODEX_CARD,
            cookie: FAKE_COOKIE,
            token: 'TOKEN-XYZ',
            credentials: { token: 'TOKEN-XYZ' },
            health: { cookie: FAKE_COOKIE },
          },
        ],
      }),
    );
    const db = freshDb();
    setSetting(db, MAGPIE_URL, service.url);

    const snap = await snapshotOf(db);
    const json = JSON.stringify(snap);

    expect(json).not.toContain(FAKE_COOKIE);
    expect(json).not.toContain('TOKEN-XYZ');
    expect(json).not.toContain('someone@example.invalid');
    expect(json).not.toContain('ICON-XYZ');
    expect(json).not.toContain('daily');
    expect(snap.quotas).toHaveLength(1);

    // 契约只列了这些字段：多一个都算把 magpie 的返回原样搬进来了。
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
    expect(Object.keys(card.windows[0]!).sort()).toEqual([
      'display',
      'name',
      'resetAt',
      'usedPercent',
    ]);
    expect(card.account).toBe('合成 Codex 账号');
    expect(card.windows[0]!.usedPercent).toBe(42.5);
  });

  it('条件 6：手动登记一条 Claude 额度 → 出现在 quotas，source = manual', async () => {
    const db = freshDb();
    setSetting(db, MAGPIE_URL, await deadMagpieUrl());
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

  it('条件 8：地址带路径或用户名密码 → 拒绝，没发请求', async () => {
    const service = await startMagpie(jsonHandler({ data: [] }));
    const db = freshDb();
    const calls = blockFetch();

    const rejected = [
      `${service.url}/api/refresh`,
      `${service.url}/v1`,
      `${service.url}/?x=1`,
      `${service.url}#x`,
      `http://user:pw@127.0.0.1:${service.port}`,
      `http://user@127.0.0.1:${service.port}`,
      // 只认 http，https 也拒（只认 http://127.0.0.1:<端口> 或 http://localhost:<端口>）。
      `https://127.0.0.1:${service.port}`,
      // 没写端口的也拒（不写就是 80 端口上别的服务）。
      'http://127.0.0.1',
      'http://localhost',
      // 别的主机带上端口照样拒。
      `http://example.com:${service.port}`,
      `http://192.168.1.10:${service.port}`,
      `http://127.0.0.2:${service.port}`,
    ];
    for (const url of rejected) {
      setSetting(db, MAGPIE_URL, url);
      const snap = await snapshotOf(db);
      expect(service.requests, url).toEqual([]);
      expect(service.connections.count, url).toBe(0);
      expect(snap.quotas, url).toEqual([]);
      expect(snap.sources.quotas.status, url).toBe('error');
      expect(snap.sources.quotas.note, url).toBeTruthy();
    }
    expect(calls).toEqual([]);
  });

  it('magpie 回 500 或回的不是 JSON / 格式不对 → 来源 error，不抛错，快照照常', async () => {
    // 500 那次回的是一份像样的卡片（变异检查：只靠「解析失败」拦不住不看状态码的实现）。
    const cases = [
      { code: 500, body: JSON.stringify({ data: [CODEX_CARD] }) },
      { code: 200, body: '{不是 JSON' },
      { code: 200, body: JSON.stringify({ object: 'list' }) },
    ];
    for (const { code, body } of cases) {
      const service = await startMagpie((_req, res) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(body);
      });
      const db = freshDb();
      new ProjectService(db).create({ name: 'K4 坏回答项目', rootPath: null, description: null });
      setSetting(db, MAGPIE_URL, service.url);

      const snap = await snapshotOf(db);
      expect(service.requests, body).toHaveLength(1);
      expect(snap.sources.quotas.status, body).toBe('error');
      expect(snap.sources.quotas.note, body).toBeTruthy();
      expect(snap.quotas, body).toEqual([]);
      expect(snap.projects.active, body).toHaveLength(1);
    }
  });

  it('magpie 和手动登记都有 → 两边的卡都在，手动的那张 source = manual', async () => {
    const service = await startMagpie(jsonHandler({ data: [CODEX_CARD] }));
    const db = freshDb();
    setSetting(db, MAGPIE_URL, service.url);
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
      ['magpie', '合成 Codex 账号'],
      ['manual', 'Claude 合成账号'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 约束里写了、编号条件没单列的：手动额度 JSON 坏了不能抛错
// ---------------------------------------------------------------------------

describe('K4 额度（约束：手动额度坏了不抛错）', () => {
  it('不是 JSON：当没有、quotas 来源 error 写原因，其他来源照常', async () => {
    const db = freshDb();
    new ProjectService(db).create({ name: 'K4 坏 JSON 项目', rootPath: null, description: null });
    setSetting(db, MAGPIE_URL, await deadMagpieUrl());
    setSetting(db, MANUAL_QUOTAS, '{这不是 JSON');

    const snap = await snapshotOf(db);
    // 手动登记坏了是配置错误：即使 magpie 也没开，也记 error，不被 missing 盖住。
    expect(snap.sources.quotas.status).toBe('error');
    expect(snap.sources.quotas.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
    expect(snap.sources.projects.status).toBe('ok');
    expect(snap.projects.active).toHaveLength(1);
  });

  it('形状不对（字段类型错）：zod 校验不通过，同样记 error，不抛错', async () => {
    const db = freshDb();
    setSetting(db, MAGPIE_URL, await deadMagpieUrl());
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
