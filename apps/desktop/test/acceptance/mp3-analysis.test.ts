/**
 * MP3 验收条件 8：后台分析换替补（本机两个 HTTP 假服务）。
 *
 * - 第一个回 429，第二个正常回答：提炼成功，结果来自第二个；
 * - 日志里有一条「换替补」，带两边的供应商和模型、原因；日志里没有地址、Key、提示词；
 * - 两个都不行：照现有失败处理走（这一层只断言抛错，不建条目由上层处理）。
 *
 * 现在功能还没实现（getProvider 还没按替补链返回），本文件应当红。
 * 后台分析用本机 127.0.0.1 的 HTTP 假服务，不另开接缝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
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
    decryptString: (b: Buffer) => Buffer.from(b).toString().slice(4),
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

const KEY_A = Buffer.from('enc:sk-synthetic-a1b2c3d4').toString('base64');
const KEY_B = Buffer.from('enc:sk-synthetic-b9f8e7d6').toString('base64');

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

function listen(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port));
  });
}

function okJson(text: string) {
  return (_req: unknown, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ content: [{ text }] }] }));
  };
}

function tooMany(_req: unknown, res: import('node:http').ServerResponse) {
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: '额度用完' } }));
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

function makeRuntime(config: AppConfig, infoLogs: unknown[]): AppRuntime {
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
      warn: () => undefined,
      debug: () => undefined,
      info: (...args: unknown[]) => infoLogs.push(args),
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

describe('MP3 条件 8：后台分析换替补', () => {
  it('第一个回 429、第二个正常 → 结果来自第二个，日志有换替补、不记地址/Key/提示词', async () => {
    const port1 = await listen(tooMany);
    const port2 = await listen(
      okJson(JSON.stringify({ items: [{ statement: '来自第二个的提炼结论' }] })),
    );
    const base = defaultAppConfig();
    const config = {
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

    const infoLogs: unknown[] = [];
    const runtime = makeRuntime(config, infoLogs);
    const provider = runtime.getProvider();
    expect(provider).toBeTruthy();

    const schema = {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
      parse: (v: unknown) => v,
    } as never;
    const out = await provider!.chatStructured({
      system: '合成系统提示',
      user: '合成用户内容',
      schema,
    });
    expect(JSON.stringify(out)).toContain('来自第二个的提炼结论');

    const text = JSON.stringify(infoLogs);
    expect(text).toContain('合成甲');
    expect(text).toContain('合成乙');
    expect(text).toContain('demo-b');
    expect(text).toMatch(/429|额度用完/);
    expect(text).not.toContain(`127.0.0.1:${port1}`);
    expect(text).not.toContain('合成用户内容');
    expect(text).not.toContain('sk-synthetic-a1b2c3d4');
  });

  it('两个都不行 → 抛错（交给上层失败处理）', async () => {
    const port1 = await listen(tooMany);
    const port2 = await listen(tooMany);
    const base = defaultAppConfig();
    const config = {
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

    const runtime = makeRuntime(config, []);
    const provider = runtime.getProvider();
    expect(provider).toBeTruthy();
    const schema = {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
      parse: (v: unknown) => v,
    } as never;
    await expect(provider!.chatStructured({ system: 's', user: 'u', schema })).rejects.toThrow();
  });
});
