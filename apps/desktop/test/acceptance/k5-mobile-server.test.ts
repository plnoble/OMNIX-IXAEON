/**
 * K5 验收（规格 docs/委派/K5-手机只读页.md，B 档：先只推测试）。
 *
 * 每个 it 对应规格「验收条件」里的一条：
 * 条件 1：开关关闭（默认）时，43192 端口没有监听。
 * 条件 2：打开后只监听 127.0.0.1:43192（检查绑定地址）。
 * 条件 3：GET /m、GET /m/snapshot 返回 200；GET /api/cockpit、GET /api/health 等其它路径返回 404；
 *          POST /m/snapshot（以及其它非 GET）返回 405。
 * 条件 4：同一时刻 /m/snapshot 和 buildCockpitSnapshot 的结果一致（generatedAt 除外）。
 * 条件 6：关掉开关后端口立即关闭。
 * 条件 7：Host: evil.example 请求 /m/snapshot → 421、没有快照内容；Host: 机器名.某某.ts.net → 200；
 *          任何响应都没有 Access-Control-Allow-Origin。
 *
 * 实现按规格落在 `apps/desktop/src/main/server/mobileServer.ts`：一个 `MobileServer`，
 * `apply()` 按设置项起停、`stop()` 关掉、`address` 给当前绑定地址；主进程直接调
 * `buildCockpitSnapshot`，不起第二个服务栈。整合方锁定这些测试之后才写实现。
 *
 * 设置项与 IPC 是另一份（k5-mobile-settings-ipc.test.ts / k5-mobile-settings.test.ts）。
 * 动态 import 上的 `@ts-ignore` 只为了在实现还不存在时让门禁里的 typecheck-acceptance 过得去；
 * 测试本身在实现写出来之前逐条是红的（不是靠类型检查过的）。
 */
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import {
  buildCockpitSnapshot,
  migrate,
  openDatabase,
  setSetting,
  type CoreDatabase,
} from '@ixaeon/core';
import type { CockpitSnapshot } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\合成\\ixaeon.exe' },
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
  shell: {},
}));

interface MobileAddress {
  host: string;
  port: number;
}

interface MobileServerLike {
  readonly address: MobileAddress | null;
  apply(): Promise<void>;
  stop(): Promise<void>;
}

type MobileServerCtor = new (opts: { db: CoreDatabase }) => MobileServerLike;

let MobileServer: MobileServerCtor | null = null;

beforeAll(async () => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- 实现还没写；@ts-ignore 在实现写出来后也不报「多余指令」
    // @ts-ignore 实现在 apps/desktop/src/main/server/mobileServer.ts，锁定测试之后才写（B 档先只推测试）
    const mod = (await import('../../src/main/server/mobileServer.js')) as {
      MobileServer?: MobileServerCtor;
    };
    MobileServer = typeof mod.MobileServer === 'function' ? mod.MobileServer : null;
  } catch {
    MobileServer = null;
  }
});

const DEFAULT_PORT = 43192;
const FIXED_NOW = new Date('2026-11-01T12:00:00.000Z');

const dirs: string[] = [];
let db: CoreDatabase | null = null;
let server: MobileServerLike | null = null;
let relayDir = '';

/** 拿到实现；还没有实现时给出能看懂的原因，而不是一句 undefined is not a function。 */
function serverCtor(): MobileServerCtor {
  if (!MobileServer) {
    throw new Error(
      'MobileServer 还没实现：本任务是 B 档，先只推测试，实现等整合方锁定后写（见规格 K5）',
    );
  }
  return MobileServer;
}

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function makeDb(): CoreDatabase {
  const dir = tempDir('ixaeon-k5-server-');
  const next = openDatabase(join(dir, 'ixaeon.db'));
  migrate(next);
  db = next;
  return next;
}

function makeServer(database: CoreDatabase): MobileServerLike {
  const next = new (serverCtor())({ db: database });
  server = next;
  return next;
}

/**
 * 真的按 IPC 保存手机设置，再让 MobileServer 按库里的设置起停（主进程里就是这个顺序：
 * 设置页保存 → saveMobileSettings → runtime.mobileServer.apply()）。
 */
function ipcFor(database: CoreDatabase, target: MobileServerLike) {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db: database, mobileServer: target });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async <T>(name: string, arg?: unknown): Promise<T> => {
    const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === `ixaeon:${name}`);
    if (!entry) throw new Error(`没有注册 IPC：${name}`);
    const handler = entry[1] as (event: unknown, input?: unknown) => Promise<T>;
    return handler({}, arg);
  };
}

async function setMobile(
  saved: (name: string, arg?: unknown) => Promise<unknown>,
  enabled: boolean,
  port = DEFAULT_PORT,
): Promise<void> {
  await saved('saveMobileSettings', { enabled, port });
}

function isListening(port: number, timeoutMs = 400, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  path: string,
  opts: { method?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.host ? { Host: opts.host } : {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  try {
    await server?.stop();
  } catch {
    /* 已经停了 */
  }
  server = null;
  try {
    if (db?.open) db.close();
  } catch {
    /* 已关 */
  }
  db = null;
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

describe('条件 1：开关关闭时端口不监听', () => {
  it('默认（没有设置项）apply 之后 address 为 null，43192 连不上', async () => {
    const database = makeDb();
    relayDir = tempDir('ixaeon-k5-relay-');
    process.env.IXAEON_RELAY_DIR = relayDir;
    const target = makeServer(database);
    const saved = ipcFor(database, target);

    await target.apply();

    expect(target.address).toBeNull();
    expect(await isListening(DEFAULT_PORT)).toBe(false);
    // 保存一次「关」也不该起监听
    await setMobile(saved, false, DEFAULT_PORT);
    expect(target.address).toBeNull();
    expect(await isListening(DEFAULT_PORT)).toBe(false);
  });
});

describe('条件 2：只绑 127.0.0.1:43192', () => {
  it('打开后 address 是 127.0.0.1:43192，从回环地址能打开 /m', async () => {
    const database = makeDb();
    relayDir = tempDir('ixaeon-k5-relay-');
    process.env.IXAEON_RELAY_DIR = relayDir;
    const target = makeServer(database);
    const saved = ipcFor(database, target);

    await setMobile(saved, true, DEFAULT_PORT);

    expect(target.address).toEqual({ host: '127.0.0.1', port: DEFAULT_PORT });
    const res = await request(DEFAULT_PORT, '/m', {
      host: `127.0.0.1:${DEFAULT_PORT}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toContain('text/html');

    // 整合方补（2026-10-31）：address 是实现自己报的，绑了 0.0.0.0 / :: 也能报 127.0.0.1。
    // 真去连本机的其他地址：IPv6 回环和每块网卡的地址都必须连不上。
    const others = ['::1'];
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) {
        if (!info.internal && info.family === 'IPv4') others.push(info.address);
      }
    }
    for (const host of others) {
      expect(await isListening(DEFAULT_PORT, 400, host), host).toBe(false);
    }
  });
});

describe('条件 3：只提供 /m 和 /m/snapshot，其它 404、非 GET 405', () => {
  it('两个页面 200；/api/cockpit、/api/health、/nope 404；POST 405', async () => {
    const database = makeDb();
    relayDir = tempDir('ixaeon-k5-relay-');
    process.env.IXAEON_RELAY_DIR = relayDir;
    const target = makeServer(database);
    const saved = ipcFor(database, target);
    await setMobile(saved, true, DEFAULT_PORT);

    const page = await request(DEFAULT_PORT, '/m', { host: `127.0.0.1:${DEFAULT_PORT}` });
    expect(page.status).toBe(200);

    const snapshot = await request(DEFAULT_PORT, '/m/snapshot', {
      host: `127.0.0.1:${DEFAULT_PORT}`,
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers['content-type'] ?? '').toContain('application/json');
    expect(() => JSON.parse(snapshot.body) as unknown).not.toThrow();

    for (const path of ['/api/cockpit', '/api/health', '/nope', '/m/other']) {
      const res = await request(DEFAULT_PORT, path, {
        host: `127.0.0.1:${DEFAULT_PORT}`,
      });
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('generatedAt');
    }

    for (const path of ['/m', '/m/snapshot']) {
      const res = await request(DEFAULT_PORT, path, {
        method: 'POST',
        host: `127.0.0.1:${DEFAULT_PORT}`,
      });
      expect(res.status, path).toBe(405);
    }

    // 整合方补（2026-10-31）：「非 GET」不只是 POST
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await request(DEFAULT_PORT, '/m/snapshot', {
        method,
        host: `127.0.0.1:${DEFAULT_PORT}`,
      });
      expect(res.status, method).toBe(405);
      expect(res.body, method).not.toContain('generatedAt');
    }
  });
});

describe('条件 4：快照和桌面版同一份', () => {
  it('/m/snapshot 与 buildCockpitSnapshot 的内容一致（generatedAt 除外）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    try {
      const database = makeDb();
      relayDir = tempDir('ixaeon-k5-relay-');
      process.env.IXAEON_RELAY_DIR = relayDir;
      // 合成一条项目，让快照不是空壳
      database
        .prepare(
          'INSERT INTO projects (id, name, status, description, current_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'p1',
          '合成项目',
          'active',
          null,
          null,
          FIXED_NOW.toISOString(),
          FIXED_NOW.toISOString(),
        );
      // 整合方补（2026-10-31）：桌面版驾驶舱读设置项里的仓库路径，手机页也要读同一项。
      // 合成的空目录（不是 git 仓库）：队列那一路的结果和「没设路径」不同，写死空串会被看出来。
      const repo = tempDir('ixaeon-k5-repo-');
      setSetting(database, 'cockpit.ixaeon_repo', repo);
      const target = makeServer(database);
      const saved = ipcFor(database, target);
      await setMobile(saved, true, DEFAULT_PORT);

      const res = await request(DEFAULT_PORT, '/m/snapshot', {
        host: `127.0.0.1:${DEFAULT_PORT}`,
      });
      expect(res.status).toBe(200);
      const served = JSON.parse(res.body) as CockpitSnapshot;
      const direct = await buildCockpitSnapshot(database, {
        relayDir,
        ixaeonRepo: repo,
        now: FIXED_NOW,
      });
      expect(direct.sources.queue.status).not.toBe('missing');

      const withoutGeneratedAt = (s: CockpitSnapshot): Omit<CockpitSnapshot, 'generatedAt'> => {
        const copy = { ...s } as Partial<CockpitSnapshot> & Record<string, unknown>;
        delete copy.generatedAt;
        return copy as Omit<CockpitSnapshot, 'generatedAt'>;
      };
      expect(withoutGeneratedAt(served)).toEqual(withoutGeneratedAt(direct));
      expect(served.projects.active.map((p) => p.name)).toContain('合成项目');
      expect(served.sources).toBeDefined();
      expect(served.attention).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('条件 6：关掉开关后端口立即关闭', () => {
  it('开着 → 关 → 连不上；再开 → 又能用', async () => {
    const database = makeDb();
    relayDir = tempDir('ixaeon-k5-relay-');
    process.env.IXAEON_RELAY_DIR = relayDir;
    const target = makeServer(database);
    const saved = ipcFor(database, target);

    await setMobile(saved, true, DEFAULT_PORT);
    expect(await isListening(DEFAULT_PORT)).toBe(true);

    const startedAt = Date.now();
    await setMobile(saved, false, DEFAULT_PORT);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(target.address).toBeNull();
    expect(await waitFor(async () => !(await isListening(DEFAULT_PORT)), 1_000)).toBe(true);

    await setMobile(saved, true, DEFAULT_PORT);
    expect(await isListening(DEFAULT_PORT)).toBe(true);
  });

  it('端口可以在设置里改：改完旧端口关掉、新端口打开', async () => {
    const database = makeDb();
    relayDir = tempDir('ixaeon-k5-relay-');
    process.env.IXAEON_RELAY_DIR = relayDir;
    const target = makeServer(database);
    const saved = ipcFor(database, target);

    await setMobile(saved, true, DEFAULT_PORT);
    expect(target.address).toEqual({ host: '127.0.0.1', port: DEFAULT_PORT });

    // 43194：避开条件 2 的 43192 和手机页那份并行时用的 43193
    await setMobile(saved, true, 43194);
    expect(target.address).toEqual({ host: '127.0.0.1', port: 43194 });
    expect(await waitFor(async () => !(await isListening(DEFAULT_PORT)), 1_000)).toBe(true);
    const res = await request(43194, '/m', { host: '127.0.0.1:43194' });
    expect(res.status).toBe(200);
  });
});

describe('条件 7：Host 白名单与 CORS', () => {
  it('evil.example → 421 且没有快照；.ts.net → 200；任何响应都没有 ACAO 头', async () => {
    const database = makeDb();
    relayDir = tempDir('ixaeon-k5-relay-');
    process.env.IXAEON_RELAY_DIR = relayDir;
    const target = makeServer(database);
    const saved = ipcFor(database, target);
    await setMobile(saved, true, DEFAULT_PORT);

    const allowed = [
      `127.0.0.1:${DEFAULT_PORT}`,
      `localhost:${DEFAULT_PORT}`,
      'my-machine.some-tailnet.ts.net',
      `my-machine.some-tailnet.ts.net:${DEFAULT_PORT}`,
    ];
    for (const host of allowed) {
      const res = await request(DEFAULT_PORT, '/m/snapshot', { host });
      expect(res.status, host).toBe(200);
      expect(res.body, host).toContain('generatedAt');
      expect(res.headers['access-control-allow-origin'], host).toBeUndefined();
    }

    const rejected = [
      'evil.example',
      `127.0.0.1:${DEFAULT_PORT + 1}`,
      'my-machine.some-tailnet.ts.net.evil.example',
      `evil.example:${DEFAULT_PORT}`,
      // 整合方补（2026-10-31）：只认「.ts.net」结尾，不是「ts.net」结尾；前缀匹配也不行
      'evilts.net',
      `evilts.net:${DEFAULT_PORT}`,
      `localhost:${DEFAULT_PORT + 1}`,
      `127.0.0.1.evil.example:${DEFAULT_PORT}`,
      `localhost.evil.example:${DEFAULT_PORT}`,
    ];
    for (const host of rejected) {
      const res = await request(DEFAULT_PORT, '/m/snapshot', { host });
      expect(res.status, host).toBe(421);
      expect(res.body, host).not.toContain('generatedAt');
      expect(res.body, host).not.toContain('"attention"');
      expect(res.headers['access-control-allow-origin'], host).toBeUndefined();
    }

    // /m、405、404 的响应同样不能带 CORS 头
    const page = await request(DEFAULT_PORT, '/m', { host: 'evil.example' });
    expect(page.status).toBe(421);
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    const notFound = await request(DEFAULT_PORT, '/api/cockpit', {
      host: `127.0.0.1:${DEFAULT_PORT}`,
    });
    expect(notFound.status).toBe(404);
    expect(notFound.headers['access-control-allow-origin']).toBeUndefined();
    const notAllowedMethod = await request(DEFAULT_PORT, '/m/snapshot', {
      method: 'POST',
      host: `127.0.0.1:${DEFAULT_PORT}`,
    });
    expect(notAllowedMethod.status).toBe(405);
    expect(notAllowedMethod.headers['access-control-allow-origin']).toBeUndefined();
  });
});
