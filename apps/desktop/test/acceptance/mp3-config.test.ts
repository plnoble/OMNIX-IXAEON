/**
 * MP3 验收条件 1、9，以及规格「要什么」第 8 条（审计）。
 *
 * 条件 1（saveModelFallbacks）：
 * - 合法的列表存进 config.fallbacks，getSettings() 原样读回来；
 * - 拒绝（配置不变）：没勾选过的模型、不存在的供应商、超过 4 项、有重复、跟主选相同；
 * - 只传 chat 时 analysis 的列表不变；传空数组清空。
 * 条件 9（删供应商）：某家被替补用着 → deleteModelProvider 拒绝，提示写明是哪个用途的替补。
 * 规格第 8 条（审计）：保存替补记一条，只记用途和项数，不记模型名。
 *
 * 现在 `saveModelFallbacks` 还没实现，本文件会红在「不是函数」——B 档先推测试的预期。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { ipcMain } from 'electron';

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
import { registerIpc } from '../../src/main/ipc.js';
import { IxaError } from '@ixaeon/core';

const KEY_A = Buffer.from('enc:sk-synthetic-a1b2c3d4').toString('base64');
const KEY_B = Buffer.from('enc:sk-synthetic-b9f8e7d6').toString('base64');
const ADDR_A = 'http://127.0.0.1:18081/v1';
const ADDR_B = 'http://127.0.0.1:18082/v1';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3-config-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(ipcMain.handle).mockClear();
});

function makeRuntime(config: AppConfig = defaultAppConfig()): AppRuntime {
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

/** 还没实现的方法：运行时取，缺了就是 TypeError（「不是函数」）。 */
function saveFallbacks(
  runtime: AppRuntime,
  input: {
    analysis?: Array<{ providerId: string; model: string }>;
    chat?: Array<{ providerId: string; model: string }>;
  },
): { ok: true } {
  const fn = (runtime as unknown as Record<string, unknown>)['saveModelFallbacks'];
  if (typeof fn !== 'function') throw new Error('NOT_IMPLEMENTED：saveModelFallbacks 还不存在');
  return (fn as (this: AppRuntime, i: unknown) => { ok: true }).call(runtime, input);
}

function expectRejected(fn: () => void): string {
  let msg = '';
  try {
    fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  expect(msg, '应当被拒绝').toBeTruthy();
  expect(msg).not.toContain('NOT_IMPLEMENTED');
  return msg;
}

function withTwoProviders(runtime: AppRuntime): { a: string; b: string } {
  const a = runtime.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: ADDR_A,
    apiKey: 'sk-synthetic-a1b2c3d4',
    savedModels: ['demo-a'],
  });
  const b = runtime.saveModelProvider({
    name: '合成乙',
    kind: 'openai',
    apiBaseUrl: ADDR_B,
    apiKey: 'sk-synthetic-b9f8e7d6',
    savedModels: ['demo-b'],
  });
  return { a: a.id, b: b.id };
}

async function ipcHandler(
  runtime: AppRuntime,
  channel: string,
): Promise<(...a: unknown[]) => unknown> {
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  expect(entry, `没有注册 IPC：${channel}`).toBeTruthy();
  return entry![1] as (...a: unknown[]) => unknown;
}

function auditRows(): Array<{ kind: string; detail: string }> {
  return db
    .prepare('SELECT kind, detail_json AS detail FROM audit_events ORDER BY rowid DESC')
    .all() as Array<{ kind: string; detail: string }>;
}

describe('MP3 条件 1：saveModelFallbacks', () => {
  it('合法的列表存进 config.fallbacks，getSettings() 原样读回来', async () => {
    const runtime = makeRuntime();
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ analysis: { providerId: b, model: 'demo-b' } });

    saveFallbacks(runtime, { analysis: [{ providerId: b, model: 'demo-b' }] });
    expect(runtime.getConfig().fallbacks?.analysis).toEqual([{ providerId: b, model: 'demo-b' }]);

    const handler = await ipcHandler(runtime, 'ixaeon:getSettings');
    const view = (await handler()) as unknown as {
      config?: { fallbacks?: unknown };
      settings?: { fallbacks?: unknown };
    };
    const fb = (view.config?.fallbacks ?? view.settings?.fallbacks) as {
      analysis?: unknown;
    };
    expect(fb?.analysis).toEqual([{ providerId: b, model: 'demo-b' }]);
  });

  it('没勾选过的模型 → 拒绝，配置不变', () => {
    const runtime = makeRuntime();
    const { b } = withTwoProviders(runtime);
    const before = JSON.stringify(runtime.getConfig().fallbacks ?? {});
    expectRejected(() =>
      saveFallbacks(runtime, { analysis: [{ providerId: b, model: '没勾过的' }] }),
    );
    expect(JSON.stringify(runtime.getConfig().fallbacks ?? {})).toBe(before);
  });

  it('不存在的供应商 → 拒绝，配置不变', () => {
    const runtime = makeRuntime();
    saveFallbacks ?? null;
    const before = JSON.stringify(runtime.getConfig().fallbacks ?? {});
    expectRejected(() =>
      saveFallbacks(runtime, { analysis: [{ providerId: 'p-nope', model: 'demo-a' }] }),
    );
    expect(JSON.stringify(runtime.getConfig().fallbacks ?? {})).toBe(before);
  });

  it('超过 4 项 → 拒绝', () => {
    const runtime = makeRuntime();
    const { b } = withTwoProviders(runtime);
    const five = Array.from({ length: 5 }, () => ({ providerId: b, model: 'demo-b' }));
    expectRejected(() => saveFallbacks(runtime, { analysis: five }));
  });

  it('同一列表里有重复 → 拒绝', () => {
    const runtime = makeRuntime();
    const { b } = withTwoProviders(runtime);
    expectRejected(() =>
      saveFallbacks(runtime, {
        analysis: [
          { providerId: b, model: 'demo-b' },
          { providerId: b, model: 'demo-b' },
        ],
      }),
    );
  });

  it('跟这个用途现在的主选相同 → 拒绝，提示写明是哪一项', () => {
    const runtime = makeRuntime();
    const { b } = withTwoProviders(runtime);
    runtime.saveModelUses({ analysis: { providerId: b, model: 'demo-b' } });
    let msg = '';
    try {
      saveFallbacks(runtime, { analysis: [{ providerId: b, model: 'demo-b' }] });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toBeTruthy();
    expect(msg).toContain('demo-b');
  });

  it('只传 chat 时 analysis 的列表不变；传空数组清空', () => {
    const runtime = makeRuntime();
    const { a, b } = withTwoProviders(runtime);
    runtime.saveModelUses({
      analysis: { providerId: a, model: 'demo-a' },
      chat: { providerId: b, model: 'demo-b' },
    });
    saveFallbacks(runtime, { analysis: [{ providerId: b, model: 'demo-b' }] });
    saveFallbacks(runtime, { chat: [{ providerId: a, model: 'demo-a' }] });
    expect(runtime.getConfig().fallbacks?.analysis).toEqual([{ providerId: b, model: 'demo-b' }]);

    saveFallbacks(runtime, { analysis: [] });
    expect(runtime.getConfig().fallbacks?.analysis ?? []).toEqual([]);
  });
});

describe('MP3 条件 9：删供应商（被替补用着）', () => {
  it('聊天替补在用它 → 拒绝，提示写明是聊天的替补', () => {
    const runtime = makeRuntime();
    const { a, b } = withTwoProviders(runtime);
    runtime.saveModelUses({ chat: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { chat: [{ providerId: b, model: 'demo-b' }] });

    let msg = '';
    try {
      runtime.deleteModelProvider(b);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('聊天');
    expect(msg).toContain('替补');
    expect(runtime.listModelProviders().some((p) => p.id === b)).toBe(true);
  });

  it('后台分析替补在用它 → 拒绝，提示写明是后台分析的替补', () => {
    const runtime = makeRuntime();
    const { a, b } = withTwoProviders(runtime);
    runtime.saveModelUses({ analysis: { providerId: a, model: 'demo-a' } });
    saveFallbacks(runtime, { analysis: [{ providerId: b, model: 'demo-b' }] });

    let msg = '';
    try {
      runtime.deleteModelProvider(b);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('后台分析');
    expect(msg).toContain('替补');
  });
});

describe('MP3 规格第 8 条：保存替补的审计', () => {
  it('记一条，只有用途和项数，没有模型名', () => {
    const runtime = makeRuntime();
    const { a, b } = withTwoProviders(runtime);
    runtime.saveModelUses({ analysis: { providerId: a, model: 'demo-a' } });
    const before = auditRows().length;
    saveFallbacks(runtime, { analysis: [{ providerId: b, model: 'demo-b' }] });

    const rows = auditRows();
    expect(rows.length).toBe(before + 1);
    const latest = rows[0]!;
    expect(latest.detail).toContain('analysis');
    expect(latest.detail).toContain('1');
    expect(latest.detail).not.toContain('demo-b');
  });
});
