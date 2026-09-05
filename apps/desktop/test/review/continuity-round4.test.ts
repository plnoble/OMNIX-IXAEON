/** Fourth review: normal refresh, interleaved tabs and queued-work lifecycle.
 * Synthetic data only. No network model, actual browser account, or real user database.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  FakeProvider,
  JobQueue,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  sha256,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { LocalServer } from '../../src/main/server/localServer.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));
const dbs: CoreDatabase[] = [];
const servers: FastifyInstance[] = [];
const locals: LocalServer[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const local of locals.splice(0)) local.stopBackgroundTasks();
  for (const queue of queues.splice(0)) queue.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  vi.restoreAllMocks();
  // Keep small, uniquely named temporary fixtures for inspection.
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-round4-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  dbs.push(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  permissions.grantDomain('chatgpt.com');
  let config = defaultAppConfig();
  config.capture.enabled = true;
  config.capture.autoAnalyze = true;
  config.extension = { token: 'round4-synthetic-token', pairedAt: new Date().toISOString() };
  const getConfig = () => config;
  const onCaptured = vi.fn();
  const localServer = new LocalServer({
    db,
    vault,
    permissions,
    sources,
    getConfig,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    onCaptured,
  });
  locals.push(localServer);
  const http = Fastify();
  servers.push(http);
  await localServer.register(http);
  await http.ready();
  const capture = (externalId: string, texts: string[], sessionId = 'tab-a-session-0001') =>
    http.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: {
        authorization: 'Bearer round4-synthetic-token',
        origin: 'chrome-extension://round4',
      },
      payload: {
        conversation: { externalId, sessionId, title: 'ChatGPT' },
        clientTimestamp: new Date().toISOString(),
        turns: texts.map((text, order) => ({
          order,
          role: order % 2 === 0 ? 'user' : 'assistant',
          text,
          contentHash: sha256(text),
        })),
      },
    });
  return {
    dir,
    db,
    vault,
    permissions,
    sources,
    getConfig,
    onCaptured,
    localServer,
    http,
    capture,
  };
}

function runtimeFor(f: Awaited<ReturnType<typeof fixture>>) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this;
    },
  };
  const jobs = new JobQueue(f.db, logger);
  queues.push(jobs);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    ...f,
    dataDir: f.dir,
    configFile: join(f.dir, 'config.json'),
    config: f.getConfig(),
    logger,
    jobs,
    stopServer: vi.fn(async () => {}),
    startServer: vi.fn(async () => {}),
  });
  return runtime;
}

it('U1: refreshing an existing formal conversation is accepted and does not create another source', async () => {
  const f = await fixture();
  const a = await f.capture(
    '/c/formal-123456',
    ['First question', 'Answer'],
    'before-refresh-session',
  );
  expect(a.statusCode).toBe(200);
  const b = await f.capture(
    '/c/formal-123456',
    ['First question', 'Answer'],
    'after-refresh-session',
  );
  expect.soft(b.statusCode, b.body).toBe(200);
  expect.soft(b.json().sourceId).toBe(a.json().sourceId);
  expect(f.db.prepare("SELECT id FROM sources WHERE provider='chatgpt_web'").all()).toHaveLength(1);
});

it('U2: reopening a formal conversation with new text preserves its original source ID', async () => {
  const f = await fixture();
  const a = await f.capture('/c/formal-123456', ['First question'], 'before-refresh-session');
  const b = await f.capture(
    '/c/formal-123456',
    ['First question', 'New answer'],
    'after-refresh-session',
  );
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  expect(b.json().sourceId).toBe(a.json().sourceId);
});

it('U3: draft A then draft B then draft A continues A instead of creating a third source', async () => {
  const f = await fixture();
  const a = await f.capture('page:same-draft-path', ['A question'], 'draft-a-session');
  const b = await f.capture('page:same-draft-path', ['B question'], 'draft-b-session');
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  expect(a.json().sourceId).not.toBe(b.json().sourceId);
  const again = await f.capture(
    'page:same-draft-path',
    ['A question', 'A answer'],
    'draft-a-session',
  );
  expect(again.statusCode).toBe(200);
  expect.soft(again.json().sourceId).toBe(a.json().sourceId);
  expect(f.db.prepare("SELECT id FROM sources WHERE provider='chatgpt_web'").all()).toHaveLength(2);
});

it('U4: three separate draft sources eventually all get automatic analysis despite sharing the same page URL', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const a = await f.capture('page:same-draft-path', ['A question'], 'draft-a-session');
  await vi.advanceTimersByTimeAsync(10_000);
  const b = await f.capture('page:same-draft-path', ['B question'], 'draft-b-session');
  await vi.advanceTimersByTimeAsync(10_000);
  const c = await f.capture('page:same-draft-path', ['C question'], 'draft-c-session');
  for (const result of [a, b, c]) expect(result.statusCode).toBe(200);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(new Set(f.onCaptured.mock.calls.map((args) => args[0]))).toEqual(
    new Set([a.json().sourceId, b.json().sourceId, c.json().sourceId]),
  );
});

it('U5: a rejected restore must not discard pending analysis of already accepted new content', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  await f.capture('/c/formal-123456', ['First question']);
  await vi.advanceTimersByTimeAsync(10_000);
  await f.capture('/c/formal-123456', ['First question', 'New answer']);
  const runtime = runtimeFor(f);
  await expect(runtime.restoreData('invalid-review-token')).rejects.toThrow('恢复凭证无效');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.onCaptured).toHaveBeenCalledTimes(2);
});

it('U6: an automatic extraction queued before autoAnalyze was disabled must not call the model afterward', async () => {
  const f = await fixture();
  const result = await f.capture('/c/formal-123456', ['MODEL_UPLOAD_MUST_BE_BLOCKED']);
  const runtime = runtimeFor(f);
  const provider = new FakeProvider().enqueueStructured({ items: [] });
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  // Actual production handler and queue, advanced deterministically without a polling interval.
  const internals = runtime as unknown as { registerJobHandlers(): void };
  internals.registerJobHandlers();
  runtime.jobs.enqueue('extract', { sourceId: result.json().sourceId, auto: true });
  f.getConfig().capture.autoAnalyze = false;
  await (runtime.jobs as unknown as { tick(): Promise<void> }).tick();
  expect(provider.structuredCalls).toHaveLength(0);
});

it('U7 CONTROL: an authorized queued automatic extraction still runs while autoAnalyze is enabled', async () => {
  const f = await fixture();
  const result = await f.capture('/c/formal-123456', ['AUTHORIZED_SYNTHETIC_INPUT']);
  const runtime = runtimeFor(f);
  const provider = new FakeProvider().enqueueStructured({ items: [] });
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  (runtime as unknown as { registerJobHandlers(): void }).registerJobHandlers();
  const job = runtime.jobs.enqueue('extract', { sourceId: result.json().sourceId, auto: true });
  await (runtime.jobs as unknown as { tick(): Promise<void> }).tick();
  expect(provider.structuredCalls).toHaveLength(1);
  expect(runtime.jobs.get(job.id)?.status).toBe('succeeded');
});
