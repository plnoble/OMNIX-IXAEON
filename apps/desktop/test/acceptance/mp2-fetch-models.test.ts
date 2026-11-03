/**
 * MP2 验收（条件 4 与条件 9 最后一条）：获取模型 / 不发额度请求。
 * 用本机随机端口的假 OpenAI 兼容服务，不连真网关。
 *
 * - 条件 4 主句：假服务收到的是 `GET /models`，带的是那一家的 Key；只取出 `id`，去重。
 * - 条件 4：302 指向另一个端口 → 返回 error，另一个端口一次请求都没收到（不跟跳转）。
 * - 条件 4：超时（10 秒）→ 返回 error，不抛错。
 * - 条件 4：Key 留空、地址来源没变 → 用已保存的 Key；**地址来源变了（换成另一个端口的假服务）**
 *   → 不带旧 Key，并且原来那个服务一次新请求都没收到。
 * - 条件 9 最后一条：一家 openai 类型走完「获取模型 → 保存勾选 → listModelProviders()」，
 *   假服务只收到 `/v1/models`，没有任何额度请求（没有含 `magpie` 的路径）。
 *
 * 地址是 127.0.0.1 的合成端口，Key 是合成的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {},
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const text = Buffer.from(b).toString();
      if (!text.startsWith('enc:')) throw new Error('解不开');
      return text.slice(4);
    },
  },
}));

import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const KEY_A = 'sk-synthetic-a1b2c3d4';

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
}

let dir: string;
let db: CoreDatabase;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp2-fetch-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(async () => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** 起一个假服务：记录每次请求，按 handler 回话。 */
async function fakeServer(
  handler: (recorded: Recorded[], res: ServerResponse) => void,
): Promise<{ base: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    recorded.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: (req.headers['authorization'] as string | undefined) ?? null,
    });
    handler(recorded, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { base: `http://127.0.0.1:${String(port)}/v1`, recorded };
}

function runtimeWith(config: AppConfig): AppRuntime {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime as unknown as Record<string, unknown>, {
    db,
    conversations: new ConversationStore(db),
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    dataDir: dir,
    config,
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    awaitSemanticBackfill: () => Promise.resolve(),
    jobs: { hold: () => () => undefined },
    imports: { captureAsk: () => ({ created: true, source: { id: 'src-x' } }) },
    enqueueExtract: () => undefined,
    ensureAskCapturePermission: () => ({ id: 'perm-1', status: 'active' }),
    newAskSession: () => ({ session: { getEngineSessionId: () => 's' }, adapter: {} }),
    hermesFound: () => false,
    disposeWarmSession: () => undefined,
    warm: null,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
  });
  return runtime;
}

function legacyConfig(): AppConfig {
  const base = defaultAppConfig();
  return {
    ...base,
    model: {
      ...base.model,
      modelName: 'demo-a',
      apiBaseUrl: '',
      apiKeyEncrypted: null,
      apiKeyPresent: false,
      savedModels: [],
    },
  };
}

function jsonModels(ids: string[]): (recorded: Recorded[], res: ServerResponse) => void {
  return (_recorded, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  };
}

describe('MP2 条件 4：获取模型', () => {
  it('发的是 GET /models，带那一家的 Key，只取 id 并去重', async () => {
    const { base, recorded } = await fakeServer(jsonModels(['demo-a', 'demo-a', 'demo-a2']));
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: base,
      apiKey: KEY_A,
    });

    const result = await runtime.fetchProviderModels(saved.id);

    expect(result.error).toBeNull();
    expect(result.models).toEqual(['demo-a', 'demo-a2']);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.method).toBe('GET');
    expect(recorded[0]!.url).toBe('/v1/models');
    expect(recorded[0]!.authorization).toBe(`Bearer ${KEY_A}`);
  });

  it('302 指向另一个端口 → 返回 error，另一个端口一次请求都没收到', async () => {
    const other = await fakeServer(jsonModels(['demo-leak']));
    const { base } = await fakeServer((_r, res) => {
      res.writeHead(302, { location: `${other.base}/models` });
      res.end();
    });
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: base,
      apiKey: KEY_A,
    });

    const result = await runtime.fetchProviderModels(saved.id);
    expect(result.models).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(other.recorded).toHaveLength(0);
  });

  it('超时 → 返回 error，不抛错', async () => {
    // 接受连接但一直不回
    const { base } = await fakeServer(() => undefined);
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: base,
      apiKey: KEY_A,
    });

    const result = await runtime.fetchProviderModels(saved.id);
    expect(result.error).toBeTruthy();
    expect(result.models).toEqual([]);
  }, 20_000);

  it('Key 留空且地址来源没变 → 用已保存的 Key；地址来源变了 → 不带旧 Key，老服务不再收到请求', async () => {
    const first = await fakeServer(jsonModels(['demo-a']));
    const second = await fakeServer(jsonModels(['demo-a']));
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: first.base,
      apiKey: KEY_A,
    });

    // 地址没变、Key 留空 → 用已保存的
    await runtime.fetchProviderModels(saved.id, { apiBaseUrl: first.base });
    expect(first.recorded[0]!.authorization).toBe(`Bearer ${KEY_A}`);
    const firstCountAfterSameAddress = first.recorded.length;

    // 地址来源变了（另一个端口的假服务）、Key 留空 → 不带旧 Key
    await runtime.fetchProviderModels(saved.id, { apiBaseUrl: second.base });
    expect(second.recorded).toHaveLength(1);
    expect(second.recorded[0]!.authorization).toBeNull();
    // 老服务没有多收一次请求
    expect(first.recorded).toHaveLength(firstCountAfterSameAddress);
  });
});

describe('MP2 条件 9 最后一条：openai 类型不发任何额度请求', () => {
  it('获取模型 → 保存勾选 → 读视图，假服务只收到 /v1/models', async () => {
    const { base, recorded } = await fakeServer(jsonModels(['demo-a', 'demo-a2']));
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: base,
      apiKey: KEY_A,
    });

    const listed = await runtime.fetchProviderModels(saved.id);
    expect(listed.error).toBeNull();
    runtime.saveModelProvider({
      id: saved.id,
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: base,
      savedModels: ['demo-a'],
    });
    runtime.listModelProviders();

    expect(recorded.length).toBeGreaterThan(0);
    for (const call of recorded) {
      expect(call.url).toBe('/v1/models');
      expect(call.url).not.toMatch(/magpie|quota|usage|balance/i);
    }
  });
});
