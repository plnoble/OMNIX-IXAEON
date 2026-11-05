/**
 * MP3 验收条件 8：后台分析换替补（本机两个 HTTP 假服务，走真的后台提炼）。
 *
 * - 第一个回 429、第二个正常回答：导入一条合成资料、跑提炼，提炼成功，建出的条目来自第二个服务；
 * - 日志里有一条「换替补」，带两边的供应商和模型、原因；日志里没有地址、Key、提示词；
 *   （`warn`、`info` 都收，不限定在哪一级。）
 * - 两个都不行：不建条目，后台任务按现有失败处理收尾；并且第二个服务确实收到过请求（真的换过）。
 *
 * 现在功能还没实现（getProvider 还没按替补链返回），本文件应当红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
  },
}));

import {
  CodingOrchestrator,
  ConversationStore,
  Extractor,
  FakeCodingExecutor,
  ImportService,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

const KEY_A = Buffer.from('sk-synthetic-a1b2c3d4').toString('base64');
const KEY_B = Buffer.from('sk-synthetic-b9f8e7d6').toString('base64');
const BODY = '合成资料正文甲，用来提炼一条结论。';

let dir: string;
let db: CoreDatabase;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3-analysis-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(async () => {
  delete process.env['IXAEON_DATA_DIR'];
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 起一个本机假服务，返回端口；同时把收到的请求数记在 counter 上。 */
function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; counter: { n: number } }> {
  const counter = { n: 0 };
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      counter.n += 1;
      handler(req, res);
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () =>
      resolve({ port: (s.address() as { port: number }).port, counter }),
    );
  });
}

function tooMany() {
  return (_req: unknown, res: ServerResponse) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '额度用完' } }));
  };
}

function extractJson(statement: string) {
  const payload = {
    items: [
      {
        type: 'decision',
        statement,
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S1',
        project_hint: null,
        excerpt: BODY,
      },
    ],
  };
  return (_req: unknown, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ content: [{ text: JSON.stringify(payload) }] }] }));
  };
}

function providerRow(id: string, name: string, port: number, enc: string, models: string[]) {
  return {
    id,
    name,
    kind: 'openai' as const,
    apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEncrypted: enc,
    apiKeyPresent: true,
    savedModels: models,
    modelsCheckedAt: null,
  };
}

function makeRuntime(config: AppConfig, logs: unknown[]): AppRuntime {
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
    logger: {
      warn: (...args: unknown[]) => logs.push(args),
      info: (...args: unknown[]) => logs.push(args),
      debug: () => undefined,
    },
    fakeProvider: null,
    fakeScriptLoaded: false,
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

/** 导入一条合成资料，返回来源 id。 */
function seedSource(): string {
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, vault, permissions, sources);
  const path = join(dir, '合成资料.md');
  // 整合方改：只放一段正文，S1 就是这段（原来带标题时 S1 是标题，摘录对不上）
  writeFileSync(path, `${BODY}\n`, 'utf8');
  const result = imports.importFile(path, {
    projectId: null,
    permissionId: permissions.grantFile(path).id,
  });
  return result.created[0]!.id;
}

function itemsOf(sourceId: string): Array<{ statement: string }> {
  return db
    .prepare('SELECT statement FROM items WHERE extracted_from_source_id = ?')
    .all(sourceId) as Array<{ statement: string }>;
}

function analysisConfig(port1: number, port2: number): AppConfig {
  const base = defaultAppConfig();
  return {
    ...base,
    model: { ...base.model, modelName: '' },
    providers: [
      providerRow('p-a', '合成甲', port1, KEY_A, ['demo-a']),
      providerRow('p-b', '合成乙', port2, KEY_B, ['demo-b']),
    ],
    uses: { analysis: { providerId: 'p-a', model: 'demo-a' } },
    ...({
      fallbacks: { analysis: [{ providerId: 'p-b', model: 'demo-b' }] },
    } as Record<string, unknown>),
  } as AppConfig;
}

describe('MP3 条件 8：后台分析换替补', () => {
  it('第一个 429、第二个正常 → 提炼成功、条目来自第二个，日志有换替补、不记地址/Key/提示词', async () => {
    const s1 = await listen(tooMany());
    const s2 = await listen(extractJson('来自第二个的提炼结论'));
    const logs: unknown[] = [];
    const runtime = makeRuntime(analysisConfig(s1.port, s2.port), logs);
    const provider = runtime.getProvider();
    expect(provider).toBeTruthy();

    const sourceId = seedSource();
    const extractor = new Extractor(db, provider!);
    const stats = await extractor.extractSource(sourceId);

    expect(stats.inserted).toBeGreaterThanOrEqual(1);
    const rows = itemsOf(sourceId);
    expect(rows.map((r) => r.statement).join('|')).toContain('来自第二个的提炼结论');
    expect(s2.counter.n).toBeGreaterThanOrEqual(1);

    const logText = JSON.stringify(logs);
    expect(logText).toContain('合成甲');
    expect(logText).toContain('合成乙');
    expect(logText).toContain('demo-b');
    expect(logText).toMatch(/429|额度用完/);
    expect(logText).not.toContain(`127.0.0.1:${s1.port}`);
    expect(logText).not.toContain(BODY);
    expect(logText).not.toContain('sk-synthetic-a1b2c3d4');
  });

  it('两个都不行 → 不建条目，第二个服务确实收到过请求（真的换过）', async () => {
    const s1 = await listen(tooMany());
    const s2 = await listen(tooMany());
    const logs: unknown[] = [];
    const runtime = makeRuntime(analysisConfig(s1.port, s2.port), logs);
    const provider = runtime.getProvider();
    expect(provider).toBeTruthy();

    const sourceId = seedSource();
    const extractor = new Extractor(db, provider!);
    let threw = false;
    try {
      await extractor.extractSource(sourceId);
    } catch {
      threw = true;
    }
    // 无论抛错还是返回 0 条，都不许建出条目
    expect(itemsOf(sourceId)).toHaveLength(0);
    expect(threw || itemsOf(sourceId).length === 0).toBe(true);
    // 真的换过：第二个服务收到过请求
    expect(s2.counter.n).toBeGreaterThanOrEqual(1);
  });
});
