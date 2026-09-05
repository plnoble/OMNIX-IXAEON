/**
 * Independent acceptance checks, 2026-09-05.
 * Assertions describe required behavior, so failures reproduce release blockers.
 * No real user database, API key, browser profile, or model service is used.
 * Run: node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.config.ts
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

const fault = vi.hoisted(() => ({ stage: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const source = String(from).replace(/\\/g, '/');
      const target = String(to).replace(/\\/g, '/');
      if (
        (fault.stage === 'backup-vault' && target.includes('.bak-') && target.endsWith('/vault')) ||
        (fault.stage === 'install-vault' &&
          source.includes('.restore-staging-') &&
          source.endsWith('/vault'))
      ) {
        fault.stage = '';
        throw new Error('REVIEW_INJECTED_RENAME_FAILURE');
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

const databases: CoreDatabase[] = [];
const servers: FastifyInstance[] = [];

afterEach(async () => {
  fault.stage = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  // Preserve uniquely named temporary fixtures for inspection; never remove user data.
});

function fixture(name = 'old', body = 'REVIEW_PRIVATE_ORIGINAL_7349') {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-independent-review-'));
  const dbPath = join(dir, 'ixaeon.db');
  const db = openDatabase(dbPath);
  databases.push(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const project = new ProjectService(db).create({ name, rootPath: null, description: null });
  const path = join(dir, 'seed.md');
  writeFileSync(path, `# ${name}\n\n${body}`, 'utf8');
  const permission = permissions.grantFile(path);
  const source = new ImportService(db, vault, permissions, sources).importFile(path, {
    projectId: project.id,
    permissionId: permission.id,
  }).created[0]!;
  const items = new ItemService(db);
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
    project,
    permission,
    source,
    items,
    archive,
  };
}

function response(segmentRef = 'S2', excerpt = 'REVIEW_PRIVATE_ORIGINAL_7349') {
  return {
    items: [
      {
        type: 'decision',
        statement: '保留的原有结论',
        rationale: null,
        confidence: 0.9,
        segment_ref: segmentRef,
        project_hint: null,
        excerpt,
      },
    ],
  };
}

async function seedUnderstanding(f: ReturnType<typeof fixture>) {
  await new Extractor(f.db, new FakeProvider().enqueueStructured(response())).extractSource(
    f.source.id,
  );
  return f.items.list({ projectId: f.project.id })[0]!;
}

function runtimeFor(f: ReturnType<typeof fixture>) {
  // Exercise actual runtime methods; only HTTP lifecycle and logging are isolated.
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db: f.db,
    vault: f.vault,
    dataDir: f.dir,
    jobs: { stop: vi.fn() },
    logger: { error: vi.fn(), info: vi.fn() },
    stopServer: vi.fn(async () => {}),
    startServer: vi.fn(async () => {}),
  });
  return runtime;
}

it('R1: desktop preview then confirm accepts its own one-use restore token', async () => {
  const f = fixture();
  const zip = join(f.dir, 'export.zip');
  await f.archive.exportData(zip);
  const runtime = runtimeFor(f);
  const preview = await runtime.previewRestore(zip);
  await expect(runtime.restoreData(preview.previewToken)).resolves.toEqual({
    ok: true,
    restartRequired: true,
  });
});

it('R2a: vault backup rename failure restores the already-moved old database', async () => {
  const old = fixture('old');
  const incoming = fixture('incoming', 'INCOMING_DIFFERENT_RAW');
  const zip = join(incoming.dir, 'incoming.zip');
  await incoming.archive.exportData(zip);
  fault.stage = 'backup-vault';
  await expect(old.archive.restoreData(zip)).rejects.toThrow('REVIEW_INJECTED_RENAME_FAILURE');
  expect(existsSync(old.dbPath), 'old database must remain at its original path').toBe(true);
});

it('R2b: new vault rename failure rolls database back too, not new DB plus old vault', async () => {
  const old = fixture('old');
  const incoming = fixture('incoming', 'INCOMING_DIFFERENT_RAW');
  const zip = join(incoming.dir, 'incoming.zip');
  await incoming.archive.exportData(zip);
  fault.stage = 'install-vault';
  await expect(old.archive.restoreData(zip)).rejects.toThrow('REVIEW_INJECTED_RENAME_FAILURE');
  const reopened = openDatabase(old.dbPath);
  databases.push(reopened);
  expect(reopened.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'old' }]);
});

it('R3a: revoked evidence never returns source text or quoted excerpts', async () => {
  const f = fixture();
  const item = await seedUnderstanding(f);
  expect(f.items.getEvidence(item.id)[0]!.segment.text).toContain('REVIEW_PRIVATE_ORIGINAL_7349');
  f.permissions.revoke(f.permission.id);
  expect(() => f.sources.getSegments(f.source.id, 0, 20)).toThrow(); // control: other boundary works
  let serialized = '';
  try {
    serialized = JSON.stringify(f.items.getEvidence(item.id));
  } catch {
    /* rejection is valid */
  }
  expect(serialized).not.toContain('REVIEW_PRIVATE_ORIGINAL_7349');
});

it('R3b: revocation during extraction prevents all subsequent model uploads', async () => {
  const f = fixture('long', 'Z'.repeat(20_000));
  const fake = new FakeProvider();
  for (let i = 0; i < 20; i++) fake.enqueueStructured({ items: [] });
  const original = fake.chatStructured.bind(fake);
  const calls = vi.spyOn(fake, 'chatStructured').mockImplementation(async (input) => {
    const output = await original(input);
    if (fake.structuredCalls.length === 1) f.permissions.revoke(f.permission.id);
    return output;
  });
  await new Extractor(f.db, fake).extractSource(f.source.id).catch(() => {});
  expect(calls).toHaveBeenCalledTimes(1);
});

it('R4: invalid evidence references do not erase previously valid understanding', async () => {
  const f = fixture();
  const item = await seedUnderstanding(f);
  await new Extractor(f.db, new FakeProvider().enqueueStructured(response('S999')))
    .extractSource(f.source.id)
    .catch(() => {});
  expect(f.items.list({ projectId: f.project.id }).map((x) => x.id)).toContain(item.id);
});

it('R5: a real segment ID does not make a fabricated quotation valid evidence', async () => {
  const f = fixture();
  await new Extractor(
    f.db,
    new FakeProvider().enqueueStructured(response('S1', 'FABRICATED_NOT_IN_SOURCE')),
  )
    .extractSource(f.source.id)
    .catch(() => {});
  const evidence = f.db.prepare('SELECT excerpt FROM item_evidence').all();
  expect(JSON.stringify(evidence)).not.toContain('FABRICATED_NOT_IN_SOURCE');
});

it('R6: model input preserves who said what (user vs assistant)', () => {
  const f = fixture();
  const blocks = new Extractor(f.db, new FakeProvider()).buildBlocks([
    { id: 'u', sequence: 0, role: 'user', text: '我尚未同意执行。' },
    { id: 'a', sequence: 1, role: 'assistant', text: '这是我的建议。' },
  ]);
  expect.soft(blocks[0]!.userText).toContain('（user）');
  expect(blocks[0]!.userText).toContain('（assistant）');
});

async function captureFixture() {
  const f = fixture();
  let config = defaultAppConfig();
  config.capture.enabled = true;
  config.capture.autoAnalyze = true;
  config.extension = { token: 'review-token', pairedAt: new Date().toISOString() };
  f.permissions.grantDomain('chatgpt.com');
  const onCaptured = vi.fn();
  const server = new LocalServer({
    ...f,
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    onCaptured,
  });
  const http = Fastify();
  servers.push(http);
  await server.register(http);
  await http.ready();
  const capture = (externalId: string, text: string[]) =>
    http.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: { authorization: 'Bearer review-token', origin: 'chrome-extension://review' },
      payload: {
        conversation: { externalId, title: 'review' },
        clientTimestamp: new Date().toISOString(),
        turns: text.map((t, order) => ({
          order,
          role: order % 2 === 0 ? 'user' : 'assistant',
          text: t,
          contentHash: sha256(t),
        })),
      },
    });
  return { ...f, config, http, capture, onCaptured };
}

it('R7: new turns arriving within 60 seconds receive a trailing automatic analysis', async () => {
  const f = await captureFixture();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
  expect((await f.capture('/c/auto-123456', ['你好'])).statusCode).toBe(200);
  expect(f.onCaptured).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await f.capture('/c/auto-123456', ['你好', '新增的重要决定'])).statusCode).toBe(200);
  await vi.advanceTimersByTimeAsync(120_000);
  expect((await f.capture('/c/auto-123456', ['你好', '新增的重要决定'])).statusCode).toBe(200);
  expect(f.onCaptured).toHaveBeenCalledTimes(2);
});

it('R8a: unrelated conversations with the same opening are not destructively merged', async () => {
  const f = await captureFixture();
  expect(
    (await f.capture('page:unrelated-draft', ['你好', 'ONLY_IN_OTHER_CONVERSATION'])).statusCode,
  ).toBe(200);
  const formal = await f.capture('/c/formal-123456', ['你好', 'A_DIFFERENT_ANSWER']);
  expect(formal.statusCode).toBe(200);
  expect
    .soft(f.db.prepare("SELECT id FROM sources WHERE provider='chatgpt_web'").all())
    .toHaveLength(2);
  const formalId = formal.json<{ sourceId: string }>().sourceId;
  expect(JSON.stringify(f.sources.getSegments(formalId, 0, 50))).not.toContain(
    'ONLY_IN_OTHER_CONVERSATION',
  );
});

it('R8b: a paused temporary conversation stays paused when its URL becomes formal', async () => {
  const f = await captureFixture();
  expect((await f.capture('page:paused-draft', ['你好'])).statusCode).toBe(200);
  f.config.capture.pausedConversations.push('page:paused-draft');
  const result = await f.capture('/c/paused-123456', ['你好', 'MUST_NOT_CAPTURE_WHILE_PAUSED']);
  expect.soft(result.statusCode).toBe(403);
  expect(JSON.stringify(f.db.prepare('SELECT text FROM segments').all())).not.toContain(
    'MUST_NOT_CAPTURE_WHILE_PAUSED',
  );
});
