/**
 * 记忆桥（三周任务单 F1，2026-09-18）：聊天里的 Hermes 经 MCP 查 IXAEON 记忆。
 *
 * 验收要点（任务单原文 + 设计修正）：
 * - 默认关闭；关着时就算拿着对的令牌也进不来；
 * - Hermes 用单独的服务端凭证，受众等同聊天注入（含个人结论、不含个人聊天原文）；
 * - 编码客户端的 localToken 进不了记忆桥，Hermes 令牌也进不了 /api/mcp/*；
 * - 只提供三个工具，编码类工具不给聊天引擎。
 *
 * 全程走真实 HTTP 入口（fastify inject）→ 真实运行时 → 真实选材 → 真实数据库。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ItemService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
  type CoreDatabase,
  type HermesLocator,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { LocalServer } from '../../src/main/server/localServer.js';
import { AppRuntime } from '../../src/main/appRuntime.js';

const LOCAL_TOKEN = 'local-token-'.padEnd(64, '1');
const BRIDGE_TOKEN = 'bridge-token-'.padEnd(64, '2');

let dir: string;
let db: CoreDatabase;
let app: FastifyInstance;
let config: AppConfig;
let items: ItemService;
let projects: ProjectService;

interface BridgeRuntime {
  hermesTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-bridge-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  items = new ItemService(db);
  projects = new ProjectService(db);
  config = {
    ...defaultAppConfig(),
    localToken: LOCAL_TOKEN,
    hermesBridge: { enabled: true, token: BRIDGE_TOKEN },
  };

  const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
  rt['db'] = db;
  rt['items'] = items;
  rt['search'] = new SearchService(db);
  rt['projects'] = projects;
  rt['coding'] = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
  rt['semanticIndex'] = null; // 关键词选材路径即可：这里测的是受众与入口，不是检索质量
  rt['semanticBackfillRun'] = null;
  const runtime = rt as unknown as BridgeRuntime;

  const server = new LocalServer({
    db,
    permissions: new PermissionService(db),
    sources: new SourceStore(db),
    vault: new Vault(join(dir, 'vault')),
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    hermesTool: (name, args) => runtime.hermesTool(name, args),
  });
  app = Fastify();
  await server.register(app);
});

afterEach(async () => {
  await app.close();
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function callBridge(token: string, name: string, args: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/hermes/tool',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: { name, args },
  });
}

/** 个人条目；disclosed=true 表示用户允许把它给模型看（与聊天注入同一道门）。 */
function personal(statement: string, disclosed: boolean): string {
  const item = items.createManual({
    projectId: null,
    scope: 'personal',
    type: 'goal',
    statement,
    rationale: null,
  });
  if (disclosed) items.grantDisclosure({ itemId: item.id, audience: 'model', note: '测试' });
  return item.id;
}

describe('记忆桥入口：谁能进', () => {
  it('开着 + Hermes 令牌：能进', async () => {
    const res = await callBridge(BRIDGE_TOKEN, 'search_memory', { query: '随便' });
    expect(res.statusCode).toBe(200);
  });

  it('关着：就算拿着对的令牌也进不来（默认关闭）', async () => {
    config = { ...config, hermesBridge: { enabled: false, token: BRIDGE_TOKEN } };
    const res = await callBridge(BRIDGE_TOKEN, 'search_memory', { query: '随便' });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/记忆桥未开启/);
  });

  it('编码客户端的 localToken 进不了记忆桥（受众不同）', async () => {
    const res = await callBridge(LOCAL_TOKEN, 'search_memory', { query: '随便' });
    expect(res.statusCode).toBe(401);
  });

  it('Hermes 令牌进不了编码客户端的 /api/mcp/*', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/search-context',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
      payload: { query: '随便', limit: 5 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('只提供三个工具：编码类工具不给聊天引擎', async () => {
    for (const name of [
      'prepare_task',
      'record_work_result',
      'search_context',
      'dispatch_coding_task',
    ]) {
      const res = await callBridge(BRIDGE_TOKEN, name, {});
      expect(res.statusCode, name).toBe(400);
    }
  });
});

describe('记忆桥取材：受众等同聊天注入', () => {
  it('search_memory：给模型看过的个人结论能查到，没授权的查不到；每条带记录日期', async () => {
    const shared = personal('半程马拉松训练计划', true);
    const hidden = personal('半程马拉松的体检报告', false);
    const res = await callBridge(BRIDGE_TOKEN, 'search_memory', { query: '半程马拉松' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      today: string;
      items: Array<{ id: string; recordedAt: string; origin: string }>;
    };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(hidden);
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.items[0]!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.items[0]!.origin).toBe('用户指定');
  });

  it('get_evidence：没授权给模型的条目被拒', async () => {
    const hidden = personal('不想让模型看到的事', false);
    const res = await callBridge(BRIDGE_TOKEN, 'get_evidence', { itemId: hidden });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().message).toMatch(/未获准外发给模型/);
  });

  it('record_observation：写成待确认的记录，不冒充用户的目标', async () => {
    const res = await callBridge(BRIDGE_TOKEN, 'record_observation', {
      statement: '用户下周三下午要去看牙',
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json() as { id: string };
    const row = db.prepare('SELECT origin, type FROM items WHERE id = ?').get(id) as {
      origin: string;
      type: string;
    };
    expect(row.origin).not.toBe('user');
    expect(row.type).toBe('open_loop');
    const audit = db
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'hermes_bridge.tool'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });
});

describe('开关流程（设置页）', () => {
  interface ToggleRuntime {
    config: AppConfig;
    setHermesBridge(
      enabled: boolean,
      deps: {
        locate?: () => HermesLocator;
        write?: (locator: unknown, entry: { enabled: boolean }) => Promise<string>;
        execPath?: string;
      },
    ): Promise<{ enabled: boolean; backupPath: string | null; warning: string | null }>;
    hermesBridgeStatus(locate: () => HermesLocator): {
      enabled: boolean;
      blockedReason: string | null;
    };
  }

  function toggleRuntime(gatewayUrl: string) {
    const home = mkdtempSync(join(tmpdir(), 'ixaeon-bridge-home-'));
    writeFileSync(join(home, 'config.yaml'), `model:\n  base_url: ${gatewayUrl}\n`);
    const rt = Object.create(AppRuntime.prototype) as Record<string, unknown>;
    let invalidated = 0;
    rt['db'] = db;
    rt['config'] = { ...defaultAppConfig(), localToken: LOCAL_TOKEN };
    rt['configFile'] = join(dir, 'config.json');
    rt['askSessions'] = new Map([['c1', { invalidateContext: () => invalidated++ }]]);
    rt['conversations'] = { clearEngineSessions: () => undefined };
    const writes: boolean[] = [];
    const deps = {
      locate: () => ({ found: true, exe: 'py', cwd: 'repo', home, reason: 't' }),
      write: async (_l: unknown, entry: { enabled: boolean }) => {
        writes.push(entry.enabled);
        return join(home, 'config.yaml.bak');
      },
      execPath: process.execPath,
    };
    return {
      rt: rt as unknown as ToggleRuntime,
      deps,
      writes,
      home,
      invalidated: () => invalidated,
    };
  }

  it('开：网关是 HTTPS → 登记到 Hermes → 生成新令牌 → 丢掉旧会话', async () => {
    const t = toggleRuntime('https://gateway.example.com/v1');
    const r = await t.rt.setHermesBridge(true, t.deps);
    expect(r.enabled).toBe(true);
    expect(t.writes).toEqual([true]);
    expect(t.rt.config.hermesBridge.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.rt.config.hermesBridge.token).not.toBe(LOCAL_TOKEN);
    expect(t.invalidated()).toBe(1);
    expect(t.rt.hermesBridgeStatus(t.deps.locate)).toEqual({ enabled: true, blockedReason: null });
    rmSync(t.home, { recursive: true, force: true });
  });

  it('网关还是明文 HTTP：不让开，也不去动 Hermes 配置', async () => {
    const t = toggleRuntime('http://203.0.113.10:3001/v1');
    await expect(t.rt.setHermesBridge(true, t.deps)).rejects.toThrow(/明文 HTTP/);
    expect(t.writes).toEqual([]);
    expect(t.rt.config.hermesBridge.enabled).toBe(false);
    expect(t.rt.hermesBridgeStatus(t.deps.locate).blockedReason).toMatch(/明文 HTTP/);
    rmSync(t.home, { recursive: true, force: true });
  });

  it('关：先作废令牌；Hermes 配置改失败也已经关上，只给提示', async () => {
    const t = toggleRuntime('https://gateway.example.com/v1');
    await t.rt.setHermesBridge(true, t.deps);
    const failing = {
      ...t.deps,
      write: async () => {
        throw new Error('磁盘满了');
      },
    };
    const r = await t.rt.setHermesBridge(false, failing);
    expect(r.enabled).toBe(false);
    expect(r.warning).toMatch(/已关闭.*磁盘满了/);
    expect(t.rt.config.hermesBridge).toEqual({ enabled: false, token: null });
    rmSync(t.home, { recursive: true, force: true });
  });

  it('每次开启都换新令牌：关掉再开，旧令牌作废', async () => {
    const t = toggleRuntime('https://gateway.example.com/v1');
    await t.rt.setHermesBridge(true, t.deps);
    const first = t.rt.config.hermesBridge.token;
    await t.rt.setHermesBridge(false, t.deps);
    await t.rt.setHermesBridge(true, t.deps);
    expect(t.rt.config.hermesBridge.token).not.toBe(first);
    rmSync(t.home, { recursive: true, force: true });
  });
});
