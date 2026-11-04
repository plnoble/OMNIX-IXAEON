/**
 * MP2 自有回归（**不登记锁定**，放 integration）：
 * default 那一家没配 Key 时——`chatLaunchOptions()` 的 `chatApiKey` 是 null，
 * 聊天**不走直连**（`directChatLaunch()` 返回 null），照旧走 Hermes。
 *
 * 对应规格第 5 条「那家没了、没 Key、Key 解不开：返回 null，行为跟今天『没配模型』一样」。
 * 合成数据，不联网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const ADDR_A = 'http://127.0.0.1:18081/v1';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp2-nokey-'));
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

function runtimeWithoutKey(): AppRuntime {
  const base = defaultAppConfig();
  const config: AppConfig = {
    ...base,
    model: {
      ...base.model,
      modelName: 'demo-a',
      chatModelName: '',
      apiBaseUrl: ADDR_A,
      apiKeyEncrypted: null,
      apiKeyPresent: false,
      savedModels: ['demo-a'],
    },
  };
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
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
  });
  return runtime;
}

describe('MP2 自有回归：default 没 Key 时聊天不走直连', () => {
  it('chatLaunchOptions 的 chatApiKey 是 null，directChatLaunch 返回 null', () => {
    const runtime = runtimeWithoutKey();
    const launch = (
      runtime as unknown as {
        chatLaunchOptions(): {
          chatModel: string | null;
          chatBaseUrl: string | null;
          chatApiKey: string | null;
        };
      }
    ).chatLaunchOptions();
    expect(launch.chatApiKey).toBeNull();
    // 模型名照旧传给 Hermes（SUB1 的行为：地址/Key 都没有时只传模型）
    expect(launch.chatModel).toBe('demo-a');

    const direct = (
      runtime as unknown as {
        directChatLaunch(): { model: string; baseUrl: string; apiKey: string } | null;
      }
    ).directChatLaunch();
    expect(direct).toBeNull();
    // 没 Key 就没有后台分析用的 provider
    expect(runtime.getProvider()).toBeNull();
  });
});

describe('MP2 整合方并入时补的回归', () => {
  it('同一次保存里后台分析和聊天都选 default：两项都写进旧字段，互不覆盖', () => {
    const runtime = runtimeWithoutKey();
    (runtime as unknown as { resetChatSessions: () => void }).resetChatSessions = () => undefined;
    runtime.updateConfig((c) => ({
      ...c,
      model: { ...c.model, savedModels: ['demo-a', 'demo-a2'] },
    }));
    runtime.saveModelUses({
      analysis: { providerId: 'default', model: 'demo-a2' },
      chat: { providerId: 'default', model: 'demo-a' },
    });
    const model = runtime.getConfig().model;
    expect(model.modelName).toBe('demo-a2');
    expect(model.chatModelName).toBe('demo-a');
  });
});
