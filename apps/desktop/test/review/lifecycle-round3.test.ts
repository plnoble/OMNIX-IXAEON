/** Third acceptance review: adjacent cases not covered by the original 11 regressions.
 * Only synthetic records in uniquely created temporary directories are used.
 * Production files and the previous review tests are intentionally unchanged.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ArchiveService,
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  JobQueue,
  PermissionService,
  ProjectService,
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

const fault = vi.hoisted(() => ({ mode: '', failures: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const a = String(from).replace(/\\/g, '/');
      const b = String(to).replace(/\\/g, '/');
      const installingVault = a.includes('.restore-staging-') && a.endsWith('/vault');
      const restoringVault = a.includes('.bak-') && a.endsWith('/vault') && b.endsWith('/vault');
      if (
        (fault.mode === 'once' && installingVault) ||
        (fault.mode === 'install-and-rollback' && (installingVault || restoringVault))
      ) {
        fault.failures++;
        if (fault.mode === 'once') fault.mode = '';
        throw new Error('ROUND3_INJECTED_VAULT_RENAME_FAILURE');
      }
      return actual.renameSync(from, to);
    },
  };
});
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

const dbs = new Set<CoreDatabase>();
const queues = new Set<JobQueue>();
const servers: FastifyInstance[] = [];
const runtimes: AppRuntime[] = [];

afterEach(async () => {
  fault.mode = '';
  fault.failures = 0;
  // Include replacement connections and queues created by actual runtime rebuilds.
  for (const runtime of runtimes.splice(0)) {
    dbs.add(runtime.db);
    queues.add(runtime.jobs);
  }
  for (const queue of queues) queue.stop();
  queues.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.close();
  for (const db of dbs) if (db.open) db.close();
  dbs.clear();
  vi.restoreAllMocks();
  // Small temporary fixtures are preserved for evidence, no recursive deletion.
});

function fixture(name = 'old') {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-round3-'));
  const dbPath = join(dir, 'ixaeon.db');
  const db = openDatabase(dbPath);
  dbs.add(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const projects = new ProjectService(db);
  const project = projects.create({ name, rootPath: null, description: null });
  const file = join(dir, 'seed.md');
  writeFileSync(file, `# ${name}\n\nROUND3_SYNTHETIC_${name}\n`);
  new ImportService(db, vault, permissions, sources).importFile(file, {
    permissionId: permissions.grantFile(file).id,
    projectId: project.id,
  });
  let config = defaultAppConfig();
  config.capture.enabled = true;
  config.capture.autoAnalyze = true;
  config.extension = { token: 'round3-test-token', pairedAt: new Date().toISOString() };
  config.localToken = 'round3-local-token';
  permissions.grantDomain('chatgpt.com');
  const onCaptured = vi.fn();
  const localServer = new LocalServer({
    db,
    vault,
    permissions,
    sources,
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    onCaptured,
  });
  const archive = new ArchiveService(db, {
    dataDir: dir,
    dbPath,
    vault,
    closeCurrentDb: () => db.close(),
  });
  return {
    dir,
    dbPath,
    db,
    vault,
    permissions,
    sources,
    projects,
    project,
    localServer,
    config,
    onCaptured,
    archive,
  };
}

async function captureFixture() {
  const f = fixture();
  const http = Fastify();
  servers.push(http);
  await f.localServer.register(http);
  await http.ready();
  const headers = {
    authorization: 'Bearer round3-test-token',
    origin: 'chrome-extension://round3',
  };
  const capture = (externalId: string, texts: string[], sessionId = 'session-a-123456') =>
    http.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers,
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
  const pause = (externalId: string, paused: boolean) =>
    http.inject({
      method: 'POST',
      url: '/api/extension/pause-conversation',
      headers,
      payload: { externalId, paused },
    });
  return { ...f, http, capture, pause };
}

function runtimeFor(f: ReturnType<typeof fixture>) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this;
    },
  };
  const jobs = new JobQueue(f.db, logger);
  queues.add(jobs);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    ...f,
    dataDir: f.dir,
    configFile: join(f.dir, 'config.json'),
    items: new ItemService(f.db),
    logger,
    jobs,
    fastify: null,
    stopServer: vi.fn(async () => {}),
    startServer: vi.fn(async () => {}),
  });
  runtimes.push(runtime);
  return runtime;
}

it('T1: persist draft sessionId and reject a merge from a different session with the same first message', async () => {
  const f = await captureFixture();
  const first = await f.capture('page:draft-a', ['你好'], 'session-a-123456');
  expect(first.statusCode).toBe(200);
  const stored = f.sources.get(first.json().sourceId)!;
  expect.soft(JSON.parse(stored.metadata_json).sessionId).toBe('session-a-123456');
  const second = await f.capture(
    '/c/formal-b-123456',
    ['你好', 'Different conversation'],
    'session-b-123456',
  );
  expect(second.statusCode).toBe(200);
  expect(f.db.prepare("SELECT id FROM sources WHERE provider='chatgpt_web'").all()).toHaveLength(2);
});

it('T2: two draft tabs with identical page/title but distinct sessions stay separate', async () => {
  const f = await captureFixture();
  const a = await f.capture('page:same-path-and-title', ['DRAFT_A_PRIVATE'], 'session-a-123456');
  const b = await f.capture('page:same-path-and-title', ['DRAFT_B_PRIVATE'], 'session-b-123456');
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  expect(a.json().sourceId).not.toBe(b.json().sourceId);
});

it('T3: paused draft remains paused on promotion even when its visible answer changed', async () => {
  const f = await captureFixture();
  expect((await f.capture('page:draft-a', ['你好', 'Original visible answer'])).statusCode).toBe(
    200,
  );
  expect((await f.pause('page:draft-a', true)).statusCode).toBe(200);
  const result = await f.capture('/c/formal-a-123456', ['你好', 'NEW_MUST_REMAIN_UNCAPTURED']);
  expect.soft(result.statusCode).toBe(403);
  expect(JSON.stringify(f.db.prepare('SELECT text FROM segments').all())).not.toContain(
    'NEW_MUST_REMAIN_UNCAPTURED',
  );
});

it('T4: explicitly resuming a promoted conversation clears its inherited pause', async () => {
  const f = await captureFixture();
  await f.capture('page:draft-a', ['你好']);
  await f.pause('page:draft-a', true);
  expect((await f.capture('/c/formal-a-123456', ['你好', 'New answer'])).statusCode).toBe(403);
  expect((await f.pause('/c/formal-a-123456', false)).statusCode).toBe(200);
  expect((await f.capture('/c/formal-a-123456', ['你好', 'New answer'])).statusCode).toBe(200);
});

it('T5: pausing a conversation prevents its pending automatic trailing analysis', async () => {
  const f = await captureFixture();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  await f.capture('/c/trailing-123456', ['你好']);
  await vi.advanceTimersByTimeAsync(10_000);
  await f.capture('/c/trailing-123456', ['你好', 'New answer']);
  await f.pause('/c/trailing-123456', true);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(f.onCaptured).toHaveBeenCalledTimes(1);
});

it('T6: successful restore stops pending timers before closing the current database', async () => {
  const f = await captureFixture();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  await f.capture('/c/trailing-123456', ['你好']);
  await vi.advanceTimersByTimeAsync(10_000);
  await f.capture('/c/trailing-123456', ['你好', 'New answer']);
  const zip = join(f.dir, 'export.zip');
  await f.archive.exportData(zip);
  const runtime = runtimeFor(f);
  const preview = await runtime.previewRestore(zip);
  await expect(runtime.restoreData(preview.previewToken)).resolves.toMatchObject({
    restartRequired: true,
  });
  await expect(vi.advanceTimersByTimeAsync(61_000)).resolves.not.toThrow();
});

it('T7: rejecting an invalid restore token does not leave a second live database and job queue', async () => {
  const f = fixture();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const runtime = runtimeFor(f);
  const originalQueue = runtime.jobs;
  originalQueue.start();
  await expect(runtime.restoreData('invalid-review-token')).rejects.toThrow('恢复凭证无效');
  // Either reuse the untouched runtime, or close/stop it before replacing it.
  expect.soft(runtime.db === f.db || !f.db.open).toBe(true);
  expect(runtime.jobs === originalQueue || Reflect.get(originalQueue, 'timer') === null).toBe(true);
});

it('T7b: a valid restore can still succeed after a previously invalid token was rejected', async () => {
  const f = fixture();
  const zip = join(f.dir, 'export.zip');
  await f.archive.exportData(zip);
  const runtime = runtimeFor(f);
  await expect(runtime.restoreData('invalid-review-token')).rejects.toThrow('恢复凭证无效');
  dbs.add(runtime.db);
  queues.add(runtime.jobs);
  const preview = await runtime.previewRestore(zip);
  await expect(runtime.restoreData(preview.previewToken)).resolves.toMatchObject({
    restartRequired: true,
  });
});

it('T8: incomplete disk rollback must not initialize an empty replacement database and restart service', async () => {
  const f = fixture('old');
  const incoming = fixture('incoming');
  const zip = join(incoming.dir, 'incoming.zip');
  await incoming.archive.exportData(zip);
  const runtime = runtimeFor(f);
  const preview = await runtime.previewRestore(zip);
  fault.mode = 'install-and-rollback';
  await expect(runtime.restoreData(preview.previewToken)).rejects.toThrow('回滚未完成');
  expect(fault.failures).toBe(2);
  expect.soft(Reflect.get(runtime, 'startServer')).not.toHaveBeenCalled();
  if (existsSync(f.dbPath)) {
    const db = openDatabase(f.dbPath);
    dbs.add(db);
    expect(db.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'old' }]);
  }
});

it('T9 CONTROL: a single vault-install failure restores old data and rebuilds a usable runtime', async () => {
  const f = fixture('old');
  const incoming = fixture('incoming');
  const zip = join(incoming.dir, 'incoming.zip');
  await incoming.archive.exportData(zip);
  const runtime = runtimeFor(f);
  const preview = await runtime.previewRestore(zip);
  fault.mode = 'once';
  await expect(runtime.restoreData(preview.previewToken)).rejects.toThrow('ROUND3_INJECTED');
  expect(runtime.projects.list().map((p) => p.name)).toEqual(['old']);
  const http = Fastify();
  servers.push(http);
  await runtime.localServer.register(http);
  const result = await http.inject({
    method: 'POST',
    url: '/api/mcp/prepare-task',
    headers: { authorization: 'Bearer round3-local-token' },
    payload: { project_ref: 'old', task: 'Control after rollback', max_chars: 4000 },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().project_name).toBe('old');
});

it('T10: complete wrapped blocks still respect 8000 characters after role-preserving long splitting', () => {
  const f = fixture();
  const blocks = new Extractor(f.db, new FakeProvider()).buildBlocks([
    { id: 's', sequence: 0, role: 'user', text: 'Z'.repeat(30_000) },
  ]);
  expect(Math.max(...blocks.map((b) => b.userText.length))).toBeLessThanOrEqual(8000);
});
