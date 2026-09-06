/** Independent whole-project audit: synthetic data only; production code is unchanged. */
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AskService,
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  JobQueue,
  McpService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, prepareTaskInputSchema } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { encryptApiKey } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));
const databases: CoreDatabase[] = [];
const queues: JobQueue[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) {
    queue.stop();
    await queue.idle();
  }
  for (const db of databases.splice(0)) if (db.open) db.close();
  vi.restoreAllMocks();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-project-audit-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  databases.push(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, vault, permissions, sources);
  const items = new ItemService(db);
  const projects = new ProjectService(db);
  const a = projects.create({ name: 'Audit A', rootPath: null, description: null });
  const b = projects.create({ name: 'Audit B', rootPath: null, description: null });
  const mcp = new McpService(db);
  function source() {
    const path = join(dir, `${randomUUID()}.md`);
    writeFileSync(path, '# Audit\n\nAUDIT_EVIDENCE\n', 'utf8');
    return imports.importFile(path, {
      projectId: a.id,
      permissionId: permissions.grantFile(path).id,
    }).created[0]!;
  }
  return { dir, db, vault, permissions, sources, imports, items, projects, a, b, mcp, source };
}
type Fixture = ReturnType<typeof fixture>;
function row(statement: string, type: 'decision' | 'constraint' | 'goal' = 'decision') {
  return {
    type,
    statement,
    excerpt: 'AUDIT_EVIDENCE',
    segment_ref: 'S2',
    rationale: null,
    confidence: 0.9,
    project_hint: null,
  };
}
async function extract(
  f: Fixture,
  sourceId: string,
  statement: string,
  type: 'decision' | 'constraint' = 'decision',
) {
  await new Extractor(
    f.db,
    new FakeProvider().enqueueStructured({ items: [row(statement, type)] }),
  ).extractSource(sourceId);
  return f.items
    .list({ projectId: null })
    .find((i) => i.extracted_from_source_id === sourceId && i.statement === statement)!;
}
function runtimeFor(f: Fixture) {
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
  const config = defaultAppConfig();
  config.capture.enabled = true;
  config.capture.autoAnalyze = true;
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    ...f,
    config,
    jobs,
    logger,
    dataDir: f.dir,
    configFile: join(f.dir, 'config.json'),
  });
  (runtime as unknown as { registerJobHandlers(): void }).registerJobHandlers();
  return runtime;
}

it('A01: re-extraction must not clone a manually moved item back into the source project', async () => {
  const f = fixture();
  const s = f.source();
  const original = await extract(f, s.id, 'MANUAL_PROJECT_ONLY_B');
  f.items.assignToProject(original.id, f.b.id);
  await extract(f, s.id, 'MANUAL_PROJECT_ONLY_B');
  expect.soft(f.items.get(original.id).project_id).toBe(f.b.id);
  expect(
    f.items.list({ projectId: f.a.id }).filter((i) => i.statement === original.statement),
  ).toHaveLength(0);
});

it('A02: binding a source must not clear pending confirmation of its important decision', async () => {
  const f = fixture();
  const s = f.source();
  const i = await extract(f, s.id, 'PENDING_SOURCE_BIND');
  expect(i.needs_review).toBe(true);
  f.sources.bindProject(s.id, f.b.id);
  expect.soft(f.items.get(i.id).confirmation).toBe('none');
  expect(f.items.get(i.id).needs_review).toBe(true);
});

it('A03: assigning one item to a project is not confirmation and must keep it in Inbox', async () => {
  const f = fixture();
  const s = f.source();
  const i = await extract(f, s.id, 'PENDING_ITEM_ASSIGN');
  f.items.assignToProject(i.id, f.b.id);
  expect.soft(f.items.get(i.id).confirmation).toBe('none');
  expect(f.items.list({ projectId: null, needsReview: true }).some((x) => x.id === i.id)).toBe(
    true,
  );
});

it('A04: conflict detection must follow the new user correction, not just its superseded predecessor', async () => {
  const f = fixture();
  const s = f.source();
  const old = await extract(f, s.id, '日志保留期限为三十天', 'constraint');
  const corrected = '项目日志可以发送到远程服务器保存和分析';
  f.items.correct({ itemId: old.id, userText: corrected });
  const opposite = await extract(f, s.id, '项目日志不可以发送到远程服务器保存和分析', 'constraint');
  expect(opposite.needs_review || opposite.state === 'disputed').toBe(true);
});

it('A05: correcting while a model request is in flight must not revive the old decision', async () => {
  const f = fixture();
  const s = f.source();
  const old = await extract(f, s.id, 'INFLIGHT_OLD_DECISION');
  const provider = new FakeProvider().enqueueStructured({ items: [row(old.statement)] });
  const originalCall = provider.chatStructured.bind(provider);
  vi.spyOn(provider, 'chatStructured').mockImplementation(async (input) => {
    const result = await originalCall(input);
    f.items.correct({ itemId: old.id, userText: 'INFLIGHT_NEW_USER_DECISION' });
    return result;
  });
  await new Extractor(f.db, provider).extractSource(s.id);
  expect(
    f.items
      .list({ projectId: f.a.id })
      .filter((i) => i.state === 'current' && i.statement === old.statement),
  ).toHaveLength(0);
});

it('A06: enabling capture during a live job then cancelling must still prevent result commit', async () => {
  const f = fixture();
  const s = f.source();
  const runtime = runtimeFor(f);
  const provider = new FakeProvider().enqueueStructured({ items: [row('CANCEL_AFTER_SWEEP')] });
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  const job = runtime.jobs.enqueue('extract', { sourceId: s.id });
  const originalCall = provider.chatStructured.bind(provider);
  vi.spyOn(provider, 'chatStructured').mockImplementation(async (input) => {
    const result = await originalCall(input);
    // This same public sweep is called by setCaptureEnabled(true)/setAutoAnalyze(true) IPC.
    runtime.sweepPendingAnalysis();
    runtime.jobs.cancel(job.id);
    return result;
  });
  await (runtime.jobs as unknown as { tick(): Promise<void> }).tick();
  expect.soft(runtime.jobs.get(job.id)?.status).toBe('cancelled');
  expect.soft(f.sources.getRevisions(s.id).analyzed).toBe(0);
  expect(f.items.list({ projectId: f.a.id })).toHaveLength(0);
});

it('A07: a schema-valid long task must not exceed the complete briefing character budget', () => {
  const f = fixture();
  const input = prepareTaskInputSchema.parse({
    project_ref: f.a.id,
    task: 'T'.repeat(4000),
    max_chars: 2000,
  });
  const brief = f.mcp.prepareTask(input);
  expect(JSON.stringify(brief).length).toBeLessThanOrEqual(input.max_chars);
});

it('A08: briefing must not discard half the decisions when all of them fit the budget', () => {
  const f = fixture();
  for (let n = 0; n < 12; n++)
    f.items.createManual({
      projectId: f.a.id,
      type: 'decision',
      statement: `BUDGET_${n}:` + 'x'.repeat(500),
      rationale: null,
    });
  const brief = f.mcp.prepareTask({ project_ref: f.a.id, task: 'audit', max_chars: 12000 });
  expect.soft(JSON.stringify(brief).length).toBeLessThan(12000);
  expect(brief.decisions).toHaveLength(12);
});

it('A09: chars_used must report the complete serialized response, including metadata and notices', () => {
  const f = fixture();
  const brief = f.mcp.prepareTask({ project_ref: f.a.id, task: 'audit', max_chars: 12000 });
  expect(brief.chars_used).toBe(JSON.stringify(brief).length);
});

it('A10: rejected suggestions must not reappear as unmarked current items in MCP or desktop search', async () => {
  const f = fixture();
  const s = f.source();
  const i = await extract(f, s.id, 'REJECTED_AUDIT_MARKER');
  f.items.reject(i.id);
  const mcp = f.mcp.searchContext({ project_ref: f.a.id, query: i.statement, limit: 8 });
  const desktop = new SearchService(f.db).searchItems(i.statement, { projectId: f.a.id });
  expect.soft(mcp.results.filter((r) => r.ref === i.id)).toHaveLength(0);
  expect(desktop.filter((r) => r.ref === i.id)).toHaveLength(0);
});

it('A11: Ask must tell the model whether the same AI proposal is pending or user-confirmed', async () => {
  const f = fixture();
  const s = f.source();
  const i = await extract(f, s.id, 'ASK_PROPOSAL');
  const pendingProvider = new FakeProvider().enqueueText('synthetic answer');
  await new AskService(f.db, pendingProvider).ask(f.a.id, '当前方案？');
  f.items.confirm(i.id);
  const confirmedProvider = new FakeProvider().enqueueText('synthetic answer');
  await new AskService(f.db, confirmedProvider).ask(f.a.id, '当前方案？');
  expect(pendingProvider.textCalls[0]!.user).not.toBe(confirmedProvider.textCalls[0]!.user);
});

it('A12: Ask must retain distinct items even when they share the same evidence segment', async () => {
  const f = fixture();
  const s = f.source();
  const provider = new FakeProvider().enqueueStructured({
    items: [row('ALPHA_GOAL', 'goal'), row('BETA_CONSTRAINT', 'constraint')],
  });
  await new Extractor(f.db, provider).extractSource(s.id);
  const askProvider = new FakeProvider().enqueueText('synthetic answer');
  await new AskService(f.db, askProvider).ask(f.a.id, '总结当前项目');
  expect.soft(askProvider.textCalls[0]!.user).toContain('ALPHA_GOAL');
  expect(askProvider.textCalls[0]!.user).toContain('BETA_CONSTRAINT');
});

it('A13: references returned for recent work must have an expandable evidence path', () => {
  const f = fixture();
  const result = f.mcp.recordWorkResult({
    project_ref: f.a.id,
    agent_name: 'audit-agent',
    task: 'audit task',
    outcome: 'success',
    summary: 'self-report, not user acceptance',
    changes: [],
    tests: [],
    open_loops: [],
  });
  const brief = f.mcp.prepareTask({ project_ref: f.a.id, task: 'audit', max_chars: 12000 });
  expect(brief.recent_work.some((e) => e.ref === result.work_run_id)).toBe(true);
  expect(() => f.mcp.getSourceExcerpt(result.work_run_id, 2000)).not.toThrow();
});

it('A14: control - ordinary allowed extraction and exact work-result retry still work', async () => {
  const f = fixture();
  const s = f.source();
  const i = await extract(f, s.id, 'ALLOWED_CONTROL');
  expect(i.needs_review).toBe(true);
  const input = {
    project_ref: f.a.id,
    client_ref: 'audit-control-key',
    agent_name: 'audit-agent',
    task: 'audit task',
    outcome: 'success' as const,
    summary: 'self-report',
    changes: [],
    tests: [],
    open_loops: [],
  };
  const first = f.mcp.recordWorkResult(input);
  const second = f.mcp.recordWorkResult(input);
  expect(second.work_run_id).toBe(first.work_run_id);
  expect(second.deduplicated).toBe(true);
});

it('A15: unavailable system encryption must not silently turn API-key storage into reversible base64', () => {
  // Deliberately synthetic text, not a real credential. A safe implementation can refuse
  // persistent storage and offer an explicitly non-persistent session-only option.
  expect(() => encryptApiKey('AUDIT_DUMMY_NOT_A_REAL_API_KEY')).toThrow();
});
