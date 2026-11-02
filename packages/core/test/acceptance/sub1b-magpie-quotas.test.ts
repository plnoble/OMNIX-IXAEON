/**
 * SUB1b 验收（核心：驾驶舱额度改读 magpie；规格 docs/委派/SUB1-直接接magpie.md 条件 4–8）。
 *
 * 条件 4：合成 magpie 的 `quotas/cards` 回 2 张卡（窗口 `used` 分别是 10.13（带 `limit: 6900`）、
 *         0、缺）→ 快照 quotas 来源 ok、2 张卡，usedPercent 分别是 10.13、0、null（不拿 limit 去除），
 *         display 原样；快照 JSON 里找不到合成卡片的 user 值。
 *         （整合方 11-02 改：原测试按「有 limit 就除」的旧口径写，与规格更正相反。）
 * 条件 5：合成服务没起 → 来源 missing、note 含「没连上 magpie」，快照其余照常。
 * 条件 6：`cockpit.magpie_url` 设成 `http://example.com:3425` → 拒绝、不发请求。
 * 条件 7：刷新 → 合成服务收到一次 `POST /v1/magpie/quotas/refresh`；30 秒内再点 → 不再发。
 * 条件 8（核心半）：快照里没有 source='quotahub' 的卡；手动登记照旧出现。
 */
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCockpitSnapshot,
  migrate,
  openDatabase,
  refreshMagpieQuotas,
  setSetting,
  type CoreDatabase,
} from '../../src/index.js';

const NOW = new Date('2026-11-01T12:00:00+08:00');
const USER_EMAIL = 'someone@example.invalid';
const MANUAL_KEY = 'cockpit.manual_quotas';

const dirs: string[] = [];
const dbs: CoreDatabase[] = [];
const servers: Server[] = [];

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

function freshDb(): CoreDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-sub1b-db-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  dbs.push(db);
  return db;
}

function noRelayDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-sub1b-relay-'));
  dirs.push(dir);
  return join(dir, '根本没有这个目录');
}

interface SyntheticMagpie {
  url: string;
  requests: Array<{ method: string; url: string; authorization: string; body: string }>;
}

async function startMagpie(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<SyntheticMagpie> {
  const requests: SyntheticMagpie['requests'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        body,
      });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('合成 magpie 没拿到端口');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function json(res: ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const CARD_ONE = {
  provider: 'prov-a',
  name: '合成卡一',
  icon: 'ICON-MARK',
  plan: 'Pro',
  user: USER_EMAIL,
  kind: 'subscription',
  readAt: '2026-11-01T03:55:00.000Z',
  windows: [
    {
      name: '5 小时',
      used: 42.5,
      limit: 100,
      unit: '%',
      resetsAt: '2026-11-01T07:00:00.000Z',
      display: '42.5%',
    },
  ],
  daily: { since: '2026-10-28', window: '5 小时', days: [{ day: '2026-11-01', used: 1 }] },
};

const CARD_TWO = {
  provider: 'prov-b',
  name: '合成卡二',
  icon: 'ICON-MARK',
  plan: null,
  user: USER_EMAIL,
  kind: 'plan',
  readAt: '2026-11-01T03:50:00.000Z',
  windows: [
    // 11-01 本机实测的 workbuddy 卡：used 本身就是百分比，不拿 limit 去除。
    {
      name: '按量',
      used: 10.13,
      limit: 6900,
      unit: 'credits',
      resetsAt: null,
      display: '699.25 / 6900',
    },
    { name: '零用量', used: 0, limit: 100, unit: 'credits', resetsAt: null, display: '0 / 100' },
    { name: '没有 used', resetsAt: null, display: null },
  ],
};

async function snapshot(db: CoreDatabase) {
  return buildCockpitSnapshot(db, { relayDir: noRelayDir(), ixaeonRepo: '', now: NOW });
}

describe('SUB1b 驾驶舱额度从 magpie 读（条件 4、5、6、8 核心半）', () => {
  it('条件 4：2 张卡三种 usedPercent 各自对、display 原样，user / icon / daily 不进快照', async () => {
    const magpie = await startMagpie((req, res) => {
      expect(req.url).toBe('/v1/magpie/quotas/cards');
      expect(req.headers.authorization).toBe('Bearer magpie');
      json(res, { object: 'list', data: [CARD_ONE, CARD_TWO] });
    });
    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', magpie.url);

    const snap = await snapshot(db);
    expect(snap.sources.quotas?.status).toBe('ok');
    expect(snap.quotas).toHaveLength(2);

    const byAccount = new Map(snap.quotas!.map((q) => [q.account, q]));
    expect(byAccount.get('合成卡一')).toEqual({
      source: 'magpie',
      provider: 'prov-a',
      account: '合成卡一',
      status: 'ok',
      plan: 'Pro',
      expiresAt: null,
      windows: [
        {
          name: '5 小时',
          usedPercent: 42.5,
          resetAt: '2026-11-01T07:00:00.000Z',
          display: '42.5%',
        },
      ],
      collectedAt: '2026-11-01T03:55:00.000Z',
    });
    const second = byAccount.get('合成卡二')!;
    // 10.13（带 limit: 6900，不除）、0、缺 → null
    expect(second.windows.map((w) => w.usedPercent)).toEqual([10.13, 0, null]);
    expect(second.windows.map((w) => w.display)).toEqual(['699.25 / 6900', '0 / 100', null]);
    expect(second.plan).toBeNull();
    expect(second.collectedAt).toBe('2026-11-01T03:50:00.000Z');

    const raw = JSON.stringify(snap);
    expect(raw).not.toContain(USER_EMAIL);
    expect(raw).not.toContain('ICON-MARK');
    expect(raw).not.toContain('daily');
    expect(snap.quotas!.some((q) => (q.source as string) === 'quotahub')).toBe(false);
  });

  it('条件 5：magpie 没起 → 来源 missing、note 含「没连上 magpie」，快照其余照常', async () => {
    // 先起一个服务拿端口再关掉：这个端口上确定没人听。
    const temp = await startMagpie((_req, res) => json(res, { data: [] }));
    const url = temp.url;
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', url);
    const snap = await snapshot(db);

    expect(snap.sources.quotas?.status).toBe('missing');
    expect(snap.sources.quotas?.note).toContain('没连上 magpie');
    expect(snap.quotas).toEqual([]);
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
    expect(snap.sources.projects.status).toBe('ok');
  });

  it('条件 6：magpie_url 是别的机器 → 拒绝，不发请求', async () => {
    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', 'http://example.com:3425');
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args[0]);
      return Promise.reject(new Error('被拒绝的地址不该发请求'));
    });

    const snap = await snapshot(db);
    expect(calls).toEqual([]);
    expect(snap.sources.quotas?.status).toBe('error');
    expect(snap.sources.quotas?.note).toBeTruthy();
    expect(snap.quotas).toEqual([]);
  });

  it('条件 6 周边：https / 没端口 / 带路径 / 用户名密码都拒绝，不发请求', async () => {
    const db = freshDb();
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args[0]);
      return Promise.reject(new Error('被拒绝的地址不该发请求'));
    });
    for (const url of [
      'https://127.0.0.1:3425',
      'http://127.0.0.1',
      'http://127.0.0.1:3425/v1',
      'http://user:pw@127.0.0.1:3425',
      'http://192.168.1.10:3425',
    ]) {
      setSetting(db, 'cockpit.magpie_url', url);
      const snap = await snapshot(db);
      expect(snap.sources.quotas?.status, url).toBe('error');
      expect(snap.quotas, url).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('条件 8（核心半）：手动登记照旧出现，和 magpie 的卡一起；快照里没有 quotahub 卡', async () => {
    const magpie = await startMagpie((_req, res) => json(res, { data: [CARD_ONE] }));
    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', magpie.url);
    setSetting(
      db,
      MANUAL_KEY,
      JSON.stringify([
        {
          account: '手动合成账号',
          window: '每周',
          resetAt: '2026-11-05T04:00:00.000Z',
          expiresAt: null,
          registeredAt: '2026-10-30T12:00:00.000Z',
        },
      ]),
    );

    const snap = await snapshot(db);
    expect(snap.sources.quotas?.status).toBe('ok');
    expect(snap.quotas!.map((q) => [q.source, q.account]).sort()).toEqual([
      ['magpie', '合成卡一'],
      ['manual', '手动合成账号'],
    ]);
    expect(snap.quotas!.find((q) => q.source === 'manual')!.windows).toEqual([
      {
        name: '每周',
        usedPercent: null,
        resetAt: '2026-11-05T04:00:00.000Z',
        display: null,
      },
    ]);
  });
});

describe('SUB1b 刷新（条件 7）', () => {
  it('点刷新 → POST /v1/magpie/quotas/refresh 一次；30 秒内再点 → 不再发', async () => {
    const magpie = await startMagpie((_req, res) => json(res, { data: [] }));
    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', magpie.url);

    const first = await refreshMagpieQuotas(db, NOW);
    expect(first).toEqual({ ok: true });
    expect(magpie.requests).toHaveLength(1);
    expect(magpie.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/magpie/quotas/refresh',
      authorization: 'Bearer magpie',
    });

    const second = await refreshMagpieQuotas(db, new Date(NOW.getTime() + 10_000));
    expect(second).toEqual({ ok: true });
    expect(magpie.requests).toHaveLength(1);
  });

  it('刷新回 30x 指到别处 → 不跟过去，报错（整合方 11-02 补）', async () => {
    const elsewhere = await startMagpie((_req, res) => json(res, { ok: true }));
    const magpie = await startMagpie((_req, res) => {
      res.writeHead(302, { location: `${elsewhere.url}/v1/magpie/quotas/refresh` });
      res.end();
    });
    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', magpie.url);

    // 上一条测试刚刷过：隔一小时再点，避开 30 秒限流。
    await expect(refreshMagpieQuotas(db, new Date(NOW.getTime() + 3_600_000))).rejects.toThrow();
    expect(magpie.requests).toHaveLength(1);
    expect(elsewhere.requests).toEqual([]);
  });

  it('地址不合法 → 抛校验错误、不发请求', async () => {
    const db = freshDb();
    setSetting(db, 'cockpit.magpie_url', 'https://127.0.0.1:3425');
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args[0]);
      return Promise.reject(new Error('不该发'));
    });

    await expect(refreshMagpieQuotas(db, NOW)).rejects.toThrow(/只认 http/);
    expect(calls).toEqual([]);
  });
});
