/**
 * MP2 验收（主进程/配置侧）——规格 docs/委派/MP2-多个模型供应商.md 验收条件：
 * - 条件 1：旧配置（只有 config.model，没有 providers / uses）照样能读；
 *   listModelProviders() 返回一家 default，地址与模型清单跟旧字段一样；
 *   getProvider() / chatLaunchOptions() 的结果跟改之前完全一样。
 * - 条件 2：新加一家（Key 用 sk-synthetic-a1b2c3d4）：
 *   config.json 文本里找不到明文 Key；**IPC getSettings 的真实返回**里找不到完整 Key、也找不到密文；
 *   那一家的 apiKeyTail 是 c3d4；config.json 里没有单独存后四位的字段；
 *   Key 是 magpie（不到 8 个字符）时 apiKeyTail 为 null；密文解不开时 apiKeyUnreadable=true、apiKeyTail=null。
 * - 条件 3：同一家改了地址来源又没填新 Key → 那家 Key 被清掉、keyCleared=true，别家不受影响。
 * - 条件 5：两家各自勾选保存互不影响；**先让 B 有过检测时间**，再获取 A，B 的检测时间不变。
 * - 条件 8：删除——被用着→拒绝且提示写用途；删 default→拒绝；没人用的删掉且密文从 config.json 消失。
 * - 条件 9：magpie——保存一家 magpie 类型把数据库设置 cockpit.magpie_url 写成它地址的来源；
 *   第二家 magpie 拒绝；magpie 类型、地址不是本机 → 拒绝且不发请求。
 * - 条件 10：审计里有保存、删除记录，记录里没有 Key、没有密文。
 *
 * 不联网：地址全是 127.0.0.1 的合成值，Key 全是合成的。读配置用 getConfig()，
 * 读 magpie 地址用 core 的 getSetting()，读界面视图走真的 IPC getSettings 处理函数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    // 复审意见 4：替身必须「解不开」才测得出解不开的分支——不是 enc: 开头就抛
    decryptString: (b: Buffer) => {
      const text = Buffer.from(b).toString();
      if (!text.startsWith('enc:')) throw new Error('解不开');
      return text.slice(4);
    },
  },
}));

import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  ItemService,
  ProjectService,
  SearchService,
  TodoStore,
  getSetting,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

const KEY_A = 'sk-synthetic-a1b2c3d4';
const KEY_B = 'sk-synthetic-b9f8e7d6';
const ADDR_A = 'http://127.0.0.1:18081/v1';
const ADDR_B = 'http://127.0.0.1:18082/v1';
const MAGPIE_ADDR = 'http://127.0.0.1:39123/v1';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});

afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 旧配置：只有 config.model，没有 providers / uses。 */
function legacyConfig(): AppConfig {
  const base = defaultAppConfig();
  return {
    ...base,
    model: {
      ...base.model,
      modelName: 'demo-a',
      chatModelName: '',
      apiBaseUrl: ADDR_A,
      apiKeyEncrypted: Buffer.from(`enc:${KEY_A}`).toString('base64'),
      apiKeyPresent: true,
      savedModels: ['demo-a'],
    },
  };
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
    // 复审意见 2：不覆盖 getProvider —— 要测真的那条实现
  });
  return runtime;
}

/** 规格说 chatLaunchOptions() 是私有的；测试按契约形状直接调它，不额外发明公开方法。 */
function launchOf(runtime: AppRuntime): {
  chatModel: string | null;
  chatBaseUrl: string | null;
  chatApiKey: string | null;
} {
  return (
    runtime as unknown as {
      chatLaunchOptions(): {
        chatModel: string | null;
        chatBaseUrl: string | null;
        chatApiKey: string | null;
      };
    }
  ).chatLaunchOptions();
}

function configText(): string {
  return readFileSync(join(dir, 'config.json'), 'utf8');
}

/** 走真的 IPC：注册后从 ipcMain.handle 的调用里取出处理函数再调（照 d7b 的做法）。 */
async function ipcHandler(
  runtime: AppRuntime,
  channel: string,
): Promise<(...args: unknown[]) => unknown> {
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  const entry = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  expect(entry, `没有注册 IPC：${channel}`).toBeTruthy();
  return entry![1] as (...args: unknown[]) => unknown;
}

function auditRows(): Array<{ kind: string; detail: string }> {
  return db
    .prepare('SELECT kind, detail_json AS detail FROM audit_events ORDER BY rowid DESC')
    .all() as Array<{ kind: string; detail: string }>;
}

describe('MP2 条件 1：旧配置照样能读', () => {
  it('listModelProviders() 返回一家 default，地址与模型清单跟旧字段一样', () => {
    const runtime = runtimeWith(legacyConfig());
    const providers = runtime.listModelProviders();
    expect(providers).toHaveLength(1);
    const def = providers[0]!;
    expect(def.id).toBe('default');
    expect(def.kind).toBe('openai');
    expect(def.apiBaseUrl).toBe(ADDR_A);
    expect(def.savedModels).toEqual(['demo-a']);
    expect(def.apiKeyPresent).toBe(true);
  });

  it('getProvider() 与 chatLaunchOptions() 跟改之前一样（真实现，不是替身）', () => {
    const runtime = runtimeWith(legacyConfig());
    expect(runtime.getProvider()?.modelName).toBe('demo-a');
    const launch = launchOf(runtime);
    expect(launch.chatBaseUrl).toBe(ADDR_A);
    expect(launch.chatApiKey).toBe(KEY_A);
  });
});

describe('MP2 条件 2：Key 只在主进程里，视图只给后四位', () => {
  it('新加一家：明文 Key 不进 config.json，视图没有完整 Key 也没有密文，后四位是 c3d4', () => {
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_A,
    });
    expect(saved.ok).toBe(true);

    const text = configText();
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain('c3d4');

    const view = runtime.listModelProviders().find((p) => p.id === saved.id)!;
    expect(view.apiKeyTail).toBe('c3d4');
    expect(view.apiKeyPresent).toBe(true);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(KEY_A);
    const encrypted = JSON.parse(text) as { providers: Array<{ apiKeyEncrypted: string }> };
    const cipher = encrypted.providers[0]?.apiKeyEncrypted ?? '';
    expect(cipher.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(cipher);

    // config.json 里没有单独存后四位的字段
    expect(text).not.toMatch(/apiKeyTail|keyTail|tail/);
  });

  it('IPC getSettings 的真实返回里没有完整 Key、也没有密文，并且带上 uses', async () => {
    const runtime = runtimeWith(legacyConfig());
    runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_A,
    });
    const onDisk = JSON.parse(configText()) as { providers: Array<{ apiKeyEncrypted: string }> };
    const cipher = onDisk.providers[0]?.apiKeyEncrypted ?? '';
    expect(cipher.length).toBeGreaterThan(0);

    const handler = await ipcHandler(runtime, 'ixaeon:getSettings');
    const view = await handler();
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain(cipher);
    // 规格 11-03 补：getSettings 返回的 config 里带 uses（只有 providerId 与 model）
    expect(serialized).toContain('uses');
  });

  it('Key 不到 8 个字符（magpie）→ apiKeyTail 是 null', () => {
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成 magpie',
      kind: 'magpie',
      apiBaseUrl: MAGPIE_ADDR,
      apiKey: 'magpie',
    });
    const view = runtime.listModelProviders().find((p) => p.id === saved.id)!;
    expect(view.apiKeyTail).toBeNull();
    expect(view.apiKeyPresent).toBe(true);
  });

  it('密文解不开 → apiKeyUnreadable 是 true、apiKeyTail 是 null', () => {
    const runtime = runtimeWith(legacyConfig());
    const saved = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_B,
    });
    // 把它那份密文换成解不开的（不是 enc: 开头，替身会抛）
    const config = runtime.getConfig();
    const providers = (config.providers ?? []).map((p) =>
      p.id === saved.id
        ? { ...p, apiKeyEncrypted: Buffer.from('broken-cipher').toString('base64') }
        : p,
    );
    Object.assign(runtime as unknown as { config: AppConfig }, {
      config: { ...config, providers } as AppConfig,
    });

    // 复审意见 5：必须找到那一家，不允许「找不到也算过」
    const view = runtime.listModelProviders().find((p) => p.id === saved.id);
    expect(view, '应当能找到刚存的那一家').toBeDefined();
    expect(view!.apiKeyUnreadable).toBe(true);
    expect(view!.apiKeyTail).toBeNull();
  });
});

describe('MP2 条件 3：改地址来源又没填新 Key → 那家 Key 被清掉', () => {
  it('keyCleared 是 true，别家的 Key 不受影响', () => {
    const runtime = runtimeWith(legacyConfig());
    const a = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: ADDR_A,
      apiKey: KEY_A,
    });
    const b = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_B,
    });
    // 改甲的地址来源（端口变），不填新 Key
    const again = runtime.saveModelProvider({
      id: a.id,
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: 'http://127.0.0.1:18099/v1',
    });
    expect(again.keyCleared).toBe(true);
    const viewA = runtime.listModelProviders().find((p) => p.id === a.id)!;
    expect(viewA.apiKeyPresent).toBe(false);
    expect(viewA.apiKeyTail).toBeNull();
    // 乙不受影响
    const viewB = runtime.listModelProviders().find((p) => p.id === b.id)!;
    expect(viewB.apiKeyPresent).toBe(true);
    expect(viewB.apiKeyTail).toBe('e7d6');
  });
});

describe('MP2 条件 5：两家各自勾选保存、互不影响', () => {
  it('保存 A 的勾选不改 B 的勾选；先让 B 有检测时间，再获取 A，B 的检测时间不变', async () => {
    const runtime = runtimeWith(legacyConfig());
    const a = runtime.saveModelProvider({
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: ADDR_A,
      apiKey: KEY_A,
    });
    const b = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_B,
    });
    runtime.saveModelProvider({
      id: a.id,
      name: '合成甲',
      kind: 'openai',
      apiBaseUrl: ADDR_A,
      savedModels: ['demo-a'],
    });
    runtime.saveModelProvider({
      id: b.id,
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      savedModels: ['demo-b'],
    });
    expect(runtime.listModelProviders().find((p) => p.id === a.id)!.savedModels).toEqual([
      'demo-a',
    ]);
    expect(runtime.listModelProviders().find((p) => p.id === b.id)!.savedModels).toEqual([
      'demo-b',
    ]);

    // 复审意见 6：先获取一次 B，让它真的有检测时间
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ data: [{ id: 'demo-b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    await runtime.fetchProviderModels(b.id);
    const bChecked = runtime.listModelProviders().find((p) => p.id === b.id)!.modelsCheckedAt;
    expect(bChecked, 'B 家获取过一次，应当有检测时间').toBeTruthy();

    // 再获取 A
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(JSON.stringify({ data: [{ id: 'demo-a' }, { id: 'demo-a2' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    const got = await runtime.fetchProviderModels(a.id);
    expect(got.error).toBeNull();
    expect(got.models).toEqual(['demo-a', 'demo-a2']);

    expect(runtime.listModelProviders().find((p) => p.id === b.id)!.modelsCheckedAt).toBe(bChecked);
    expect(runtime.listModelProviders().find((p) => p.id === a.id)!.modelsCheckedAt).toBeTruthy();
  });
});

describe('MP2 条件 8：删除', () => {
  it('被用途用着的家 → 拒绝，提示里写着用途的名字', () => {
    const runtime = runtimeWith(legacyConfig());
    const b = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_B,
      savedModels: ['demo-b'],
    });
    runtime.saveModelUses({ chat: { providerId: b.id, model: 'demo-b' } });
    expect(() => runtime.deleteModelProvider(b.id)).toThrow(/聊天/);
    expect(runtime.listModelProviders().some((p) => p.id === b.id)).toBe(true);
  });

  it('删 default → 拒绝', () => {
    const runtime = runtimeWith(legacyConfig());
    // 断言是给用户看的中文拒绝理由，不是「方法还没实现」的 TypeError
    expect(() => runtime.deleteModelProvider('default')).toThrow(/默认|default/i);
  });

  it('没人用的家 → 删掉，它的密文从 config.json 里消失', () => {
    const runtime = runtimeWith(legacyConfig());
    const b = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_B,
    });
    const onDisk = JSON.parse(configText()) as {
      providers: Array<{ id: string; apiKeyEncrypted: string | null }>;
    };
    const cipher = onDisk.providers.find((p) => p.id === b.id)!.apiKeyEncrypted!;
    expect(cipher.length).toBeGreaterThan(0);

    runtime.deleteModelProvider(b.id);
    expect(runtime.listModelProviders().some((p) => p.id === b.id)).toBe(false);
    expect(configText()).not.toContain(cipher);
  });
});

describe('MP2 条件 9：magpie 挂在那一家人上', () => {
  it('保存一家 magpie → 数据库设置 cockpit.magpie_url 变成它地址的来源', () => {
    const runtime = runtimeWith(legacyConfig());
    runtime.saveModelProvider({
      name: '合成 magpie',
      kind: 'magpie',
      apiBaseUrl: MAGPIE_ADDR,
      apiKey: 'magpie',
    });
    expect(getSetting(db, 'cockpit.magpie_url')?.value).toBe('http://127.0.0.1:39123');
  });

  it('第二家 magpie → 拒绝', () => {
    const runtime = runtimeWith(legacyConfig());
    runtime.saveModelProvider({
      name: '合成 magpie',
      kind: 'magpie',
      apiBaseUrl: MAGPIE_ADDR,
      apiKey: 'magpie',
    });
    expect(() =>
      runtime.saveModelProvider({
        name: '合成 magpie 二',
        kind: 'magpie',
        apiBaseUrl: 'http://127.0.0.1:39124/v1',
        apiKey: 'magpie',
      }),
    ).toThrow(/magpie/i);
  });

  it('magpie 类型、地址不是本机 → 拒绝，且一个请求都不发', () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = runtimeWith(legacyConfig());
    expect(() =>
      runtime.saveModelProvider({
        name: '合成 magpie 远端',
        kind: 'magpie',
        apiBaseUrl: 'http://gateway.invalid:39123/v1',
        apiKey: 'magpie',
      }),
    ).toThrow(/本机|magpie|地址/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('MP2 条件 10：审计', () => {
  it('保存与删除各记一条，记录里没有 Key、也没有密文', () => {
    const runtime = runtimeWith(legacyConfig());
    const b = runtime.saveModelProvider({
      name: '合成乙',
      kind: 'openai',
      apiBaseUrl: ADDR_B,
      apiKey: KEY_B,
    });
    runtime.deleteModelProvider(b.id);

    const rows = auditRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(KEY_B);
    expect(text).not.toContain('apiKeyEncrypted');
    expect(text).not.toContain(ADDR_B);
  });
});
