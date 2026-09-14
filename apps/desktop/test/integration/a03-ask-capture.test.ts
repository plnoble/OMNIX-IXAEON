import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ItemService,
  ProjectService,
  HermesRuntimeAdapter,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a03-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

describe('A03 问答存档独立状态与显式开关控制', () => {
  it('初始状态为 enabled；disableAskCapture 显式撤销并记录审计', () => {
    const runtime = Object.create(AppRuntime.prototype) as unknown as Record<string, unknown> & {
      askCaptureStatus: () => 'enabled' | 'revoked';
      disableAskCapture: () => 'revoked';
      enableAskCapture: () => 'enabled';
    };
    const items = new ItemService(db);
    const projects = new ProjectService(db);
    const perms = {
      grantDomain: (domain: string) => {
        const id = 'perm-1';
        db.prepare(
          `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
           VALUES (?, 'domain', ?, 'continuous', 'active', ?, NULL)`,
        ).run(id, domain, new Date().toISOString());
        return { id, locator: domain, status: 'active' };
      },
      revoke: (id: string) => {
        db.prepare(`UPDATE permissions SET status='revoked', revoked_at=? WHERE id=?`).run(
          new Date().toISOString(),
          id,
        );
      },
    };

    Object.assign(runtime, { db, items, projects, permissions: perms });

    // 初始状态
    expect(runtime.askCaptureStatus()).toBe('enabled');

    // 显式停用
    const statusAfterDisable = runtime.disableAskCapture();
    expect(statusAfterDisable).toBe('revoked');
    expect(runtime.askCaptureStatus()).toBe('revoked');

    // 审计日志中有记录
    const audits = db.prepare('SELECT kind FROM audit_events').all() as Array<{ kind: string }>;
    expect(audits.some((a) => a.kind === 'ask.capture_disabled')).toBe(true);

    // 显式恢复
    const statusAfterEnable = runtime.enableAskCapture();
    expect(statusAfterEnable).toBe('enabled');
    expect(runtime.askCaptureStatus()).toBe('enabled');

    const audits2 = db.prepare('SELECT kind FROM audit_events').all() as Array<{ kind: string }>;
    expect(audits2.some((a) => a.kind === 'ask.capture_enabled')).toBe(true);
  });

  it('撤销后提问不自动重新授权（保持 revoked）', async () => {
    const runtime = Object.create(AppRuntime.prototype) as unknown as Record<string, unknown> & {
      askCaptureStatus: () => 'enabled' | 'revoked';
      disableAskCapture: () => 'revoked';
      ask: (projectId: string | null, question: string) => Promise<unknown>;
    };
    const items = new ItemService(db);
    const projects = new ProjectService(db);
    const perms = {
      grantDomain: (domain: string) => {
        const id = 'perm-2';
        db.prepare(
          `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
           VALUES (?, 'domain', ?, 'continuous', 'active', ?, NULL)`,
        ).run(id, domain, new Date().toISOString());
        return { id, locator: domain, status: 'active' };
      },
      revoke: (id: string) => {
        db.prepare(`UPDATE permissions SET status='revoked', revoked_at=? WHERE id=?`).run(
          new Date().toISOString(),
          id,
        );
      },
    };

    vi.spyOn(HermesRuntimeAdapter.prototype, 'probe').mockReturnValue({
      locator: { found: true, exe: 'hermes.exe', cwd: null, home: null, reason: 'ok' },
      engine: 'hermes',
      session: true,
      stop: true,
      toolAllowlist: true,
      usage: true,
      resume: true,
      streaming: true,
      probedAt: new Date().toISOString(),
    });
    vi.spyOn(HermesRuntimeAdapter.prototype, 'start').mockResolvedValue({
      events: [],
      answer: '测试回答',
      status: 'terminal',
      modelName: 'fake',
      providerName: 'fake',
      sessionId: 'fake-session',
    });

    Object.assign(runtime, {
      db,
      items,
      projects,
      permissions: perms,
      getProvider: () => null,
      config: {
        capture: { enabled: true, autoAnalyze: false },
        webSearch: { provider: 'none', apiKeyPresent: false },
      },
      getConfig: () => ({ capture: { enabled: true, autoAnalyze: false } }),
      enqueueExtract: () => undefined,
      coding: { executorName: 'fake' },
      adapter: new HermesRuntimeAdapter(),
      broker: () => ({ invoke: async () => ({}) }),
    });

    // 显式撤销
    runtime.disableAskCapture();
    expect(runtime.askCaptureStatus()).toBe('revoked');

    // 发起提问
    await runtime.ask(null, '今天天气怎么样？');

    // 授权不得自动复活
    expect(runtime.askCaptureStatus()).toBe('revoked');
    const sources = db.prepare("SELECT * FROM sources WHERE provider='ask_session'").all();
    expect(sources).toHaveLength(0);
  });
});
