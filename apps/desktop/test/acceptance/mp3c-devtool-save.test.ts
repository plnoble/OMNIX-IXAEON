/**
 * MP3c 验收条件 4：`saveDevToolPath` 的校验与审计。
 *
 * - 相对路径拒绝；不在的位置拒绝，提示带工具名；
 * - `null` 或空串删掉手填；
 * - 审计里没有路径（只记工具名和「手填 / 恢复自动」）。
 *
 * 现在 `saveDevToolPath` / `getDevTools` 还没实现，本文件红在「不是函数」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3c-save-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env['IXAEON_DATA_DIR'] = dir;
});
afterEach(() => {
  delete process.env['IXAEON_DATA_DIR'];
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

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

function save(
  rt: AppRuntime,
  input: { tool: 'codex' | 'claude' | 'dsh'; path: string | null },
): unknown {
  const fn = (rt as unknown as Record<string, unknown>)['saveDevToolPath'];
  if (typeof fn !== 'function') throw new Error('NOT_IMPLEMENTED：saveDevToolPath 还不存在');
  return (fn as (this: AppRuntime, i: unknown) => unknown).call(rt, input);
}

function expectNotImplementedNot(fn: () => void): string {
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

function auditText(): string {
  const rows = db
    .prepare('SELECT detail_json AS d FROM audit_events ORDER BY rowid DESC')
    .all() as Array<{ d: string }>;
  return rows.map((r) => r.d).join('\n');
}

describe('MP3c 条件 4：saveDevToolPath', () => {
  it('相对路径拒绝', () => {
    const rt = runtime();
    expectNotImplementedNot(() => save(rt, { tool: 'codex', path: 'tools/codex.exe' }));
  });

  it('不在的位置拒绝，提示带工具名', () => {
    const rt = runtime();
    const msg = expectNotImplementedNot(() =>
      save(rt, { tool: 'claude', path: join(dir, 'nope', 'claude.exe') }),
    );
    expect(msg).toContain('Claude');
  });

  it('在的位置能存；null / 空串删掉手填；审计里没有路径', () => {
    const rt = runtime();
    const exe = join(dir, 'tools', 'codex.exe');
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(exe, 'fake', 'utf8');

    save(rt, { tool: 'codex', path: exe });
    const audited = auditText();
    expect(audited).toContain('codex');
    expect(audited).toContain('手填');
    expect(audited).not.toContain(exe);
    expect(audited).not.toContain(dir);

    save(rt, { tool: 'codex', path: null });
    expect(auditText()).toContain('恢复自动');
    save(rt, { tool: 'codex', path: '' });
  });
});
