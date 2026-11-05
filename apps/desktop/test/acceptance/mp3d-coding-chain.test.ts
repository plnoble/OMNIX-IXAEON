/**
 * MP3d 验收条件 7：`saveCodingChain` 的校验与「没存过时的旧行为」。
 *
 * 拒绝：超过 5 项、有重复；供应商那一项的模型没保存过；Codex / DSH 填了模型；
 *       Claude Code 的模型不在 opus / sonnet / haiku 里。传空数组清空。
 * 没存过 codingChain 时行为跟现在一样（coding.executor=codex → 交 Codex；=model → 交那个模型）。
 *
 * 条件 8–12（派发换下一个的判定、5 分钟、ClaudeCodeExecutor 的 argv）依赖实现才有的
 * 候选串 plan 与执行器构造，规格没写死这些接口；见交付说明「写不成测试 / 有问题」一节，未自行发明接口。
 *
 * 现在 `saveCodingChain` 还没实现，本文件红在「不是函数」。
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

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3d-chain-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});
afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Choice =
  | { kind: 'tool'; tool: 'codex' | 'claude' | 'dsh'; model?: string }
  | { kind: 'provider'; providerId: string; model: string };

function runtime(): AppRuntime {
  const rt = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(rt as unknown as Record<string, unknown>, {
    db,
    conversations: new ConversationStore(db),
    todos: new TodoStore(db),
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    dataDir: dir,
    config: defaultAppConfig() as AppConfig,
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
  return rt;
}

function saveChain(rt: AppRuntime, list: Choice[]): unknown {
  const fn = (rt as unknown as Record<string, unknown>)['saveCodingChain'];
  if (typeof fn !== 'function') throw new Error('NOT_IMPLEMENTED：saveCodingChain 还不存在');
  return (fn as (this: AppRuntime, l: Choice[]) => unknown).call(rt, list);
}

function expectRejected(fn: () => void): void {
  let msg = '';
  try {
    fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  expect(msg, '应当被拒绝').toBeTruthy();
  expect(msg).not.toContain('NOT_IMPLEMENTED');
}

/** 加一家供应商并勾一个模型（供应商那一项要用「已保存的模型」）。 */
function withProvider(rt: AppRuntime): string {
  const p = rt.saveModelProvider({
    name: '合成甲',
    kind: 'openai',
    apiBaseUrl: 'http://127.0.0.1:18081/v1',
    apiKey: 'sk-synthetic-a1b2c3d4',
    savedModels: ['demo-a'],
  });
  return p.id;
}

describe('MP3d 条件 7：saveCodingChain 拒绝与清空', () => {
  it('超过 5 项 → 拒绝', () => {
    const rt = runtime();
    const six: Choice[] = [
      { kind: 'tool', tool: 'codex' },
      { kind: 'tool', tool: 'claude', model: 'opus' },
      { kind: 'tool', tool: 'claude', model: 'sonnet' },
      { kind: 'tool', tool: 'claude', model: 'haiku' },
      { kind: 'tool', tool: 'dsh' },
      { kind: 'tool', tool: 'codex' },
    ];
    expectRejected(() => saveChain(rt, six));
  });

  it('有重复（同工具同模型） → 拒绝', () => {
    const rt = runtime();
    expectRejected(() =>
      saveChain(rt, [
        { kind: 'tool', tool: 'claude', model: 'sonnet' },
        { kind: 'tool', tool: 'claude', model: 'sonnet' },
      ]),
    );
  });

  it('供应商那一项的模型没保存过 → 拒绝', () => {
    const rt = runtime();
    const id = withProvider(rt);
    expectRejected(() => saveChain(rt, [{ kind: 'provider', providerId: id, model: '没勾过' }]));
  });

  it('Codex / DSH 填了模型 → 拒绝', () => {
    const rt = runtime();
    expectRejected(() => saveChain(rt, [{ kind: 'tool', tool: 'codex', model: 'x' }]));
    expectRejected(() => saveChain(rt, [{ kind: 'tool', tool: 'dsh', model: 'y' }]));
  });

  it('Claude Code 的模型不在 opus / sonnet / haiku → 拒绝；在这三个里可以', () => {
    const rt = runtime();
    expectRejected(() => saveChain(rt, [{ kind: 'tool', tool: 'claude', model: 'gpt-4' }]));
    expect(() => saveChain(rt, [{ kind: 'tool', tool: 'claude', model: 'sonnet' }])).not.toThrow();
  });

  it('传空数组清空', () => {
    const rt = runtime();
    saveChain(rt, [{ kind: 'tool', tool: 'codex' }]);
    saveChain(rt, []);
    const cfg = rt.getConfig() as unknown as { codingChain?: unknown[] };
    expect(cfg.codingChain ?? []).toEqual([]);
  });
});
