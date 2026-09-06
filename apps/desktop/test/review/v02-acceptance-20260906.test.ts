/** Independent v0.2 review. Synthetic temporary data only; no real model/account.
 * Existing tests and production code are unchanged. Keep fixtures for inspection.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  JobQueue,
  McpService,
  MIGRATIONS,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  sha256,
  type CoreDatabase,
} from '@ixaeon/core';
import {
  defaultAppConfig,
  getSourceExcerptInputSchema,
  prepareTaskOutputSchema,
  recordWorkResultInputSchema,
} from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
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
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v02-review-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  databases.push(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, vault, permissions, sources);
  const items = new ItemService(db);
  const projects = new ProjectService(db);
  const a = projects.create({ name: 'Review A', rootPath: null, description: null });
  const b = projects.create({ name: 'Review B', rootPath: null, description: null });
  const c = projects.create({ name: 'Review C', rootPath: null, description: null });
  const mcp = new McpService(db);
  function source(raw = 'REVIEW_EVIDENCE', projectId: string | null = a.id) {
    const path = join(dir, `${randomUUID()}.md`);
    writeFileSync(path, `# Review\n\n${raw}\n`, 'utf8');
    return imports.importFile(path, { projectId, permissionId: permissions.grantFile(path).id })
      .created[0]!;
  }
  const brief = (projectId = a.id, maxChars = 12000) =>
    mcp.prepareTask({ project_ref: projectId, task: 'Review task', max_chars: maxChars });
  return {
    dir,
    db,
    vault,
    permissions,
    sources,
    imports,
    items,
    projects,
    a,
    b,
    c,
    mcp,
    source,
    brief,
  };
}
type Fixture = ReturnType<typeof fixture>;

function output(statement: string, excerpt = 'REVIEW_EVIDENCE', segmentRef = 'S2') {
  return {
    items: [
      {
        type: 'decision',
        statement,
        excerpt,
        segment_ref: segmentRef,
        rationale: null,
        confidence: 0.9,
        project_hint: null,
      },
    ],
  };
}
async function extract(
  f: Fixture,
  sourceId: string,
  statement: string,
  excerpt = 'REVIEW_EVIDENCE',
  segmentRef = 'S2',
) {
  const provider = new FakeProvider().enqueueStructured(output(statement, excerpt, segmentRef));
  return new Extractor(f.db, provider).extractSource(sourceId);
}
function aiItem(f: Fixture, sourceId: string) {
  return f.items.list({ projectId: null }).find((x) => x.extracted_from_source_id === sourceId)!;
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
async function tick(queue: JobQueue) {
  await (queue as unknown as { tick(): Promise<void> }).tick();
}

it('V01: queue cancellation during a model request prevents committing its result and analyzed revision', async () => {
  const f = fixture();
  const source = f.source();
  const runtime = runtimeFor(f);
  const provider = new FakeProvider().enqueueStructured(output('CANCELLED_RESULT_MUST_NOT_COMMIT'));
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  const job = runtime.jobs.enqueue('extract', { sourceId: source.id });
  const original = provider.chatStructured.bind(provider);
  vi.spyOn(provider, 'chatStructured').mockImplementation(async (input) => {
    const result = await original(input);
    runtime.jobs.cancel(job.id);
    return result;
  });
  await tick(runtime.jobs);
  expect(runtime.jobs.get(job.id)?.status).toBe('cancelled');
  expect.soft(f.sources.getRevisions(source.id).analyzed).toBe(0);
  expect(f.items.list({ projectId: f.a.id })).toHaveLength(0);
});

it('V02: an orphan running job left by a crash must not permanently block pending analysis on startup', async () => {
  const f = fixture();
  const source = f.source();
  // Persist the exact database state left when a process dies after queued -> running.
  const oldQueue = new JobQueue(f.db);
  const interrupted = oldQueue.enqueue('extract', { sourceId: source.id });
  f.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(interrupted.id);
  const runtime = runtimeFor(f); // fresh queue: there is no in-memory owner of the running job
  const provider = new FakeProvider().enqueueStructured(output('RECOVERED_RESULT'));
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  runtime.sweepPendingAnalysis();
  await runtime.jobs.idle();
  await tick(runtime.jobs);
  expect.soft(provider.structuredCalls).toHaveLength(1);
  expect(f.sources.getRevisions(source.id).analyzed).toBe(
    f.sources.getRevisions(source.id).content,
  );
});

it('V03: returning to an old answer branch increments content revision and leaves analysis pending', () => {
  const f = fixture();
  const source = f.source();
  const append = (text: string) =>
    f.sources.appendCapturedTurns(source.id, [{ order: 10, role: 'assistant', text }]);
  append('Branch A');
  append('Branch B');
  const before = f.sources.getRevisions(source.id).content;
  f.sources.advanceAnalyzedRevision(source.id, before);
  append('Branch A');
  const current = f.db
    .prepare(
      "SELECT text FROM segments WHERE source_id = ? AND external_node_id = '10' AND is_active_branch = 1",
    )
    .get(source.id);
  expect(current).toEqual({ text: 'Branch A' });
  expect(f.sources.getRevisions(source.id).content).toBeGreaterThan(before);
});

it('V04: one fully analyzed source cannot hide another source whose content is still unanalyzed', () => {
  const f = fixture();
  const analyzed = f.source('ALREADY_ANALYZED');
  f.sources.advanceAnalyzedRevision(analyzed.id, 1);
  const pending = f.source('STILL_UNANALYZED');
  expect(f.sources.getRevisions(pending.id)).toEqual({ content: 1, analyzed: 0 });
  expect(f.brief().coverage.hasUnanalyzedContent).toBe(true);
});

it('V05: upgrading a v1 database must not label a never-analyzed source as successfully analyzed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-v02-legacy-review-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  databases.push(db);
  const initial = MIGRATIONS.find((m) => m.id === 1)!;
  db.exec(initial.sql);
  db.exec(
    'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(
    initial.name,
    new Date().toISOString(),
  );
  const permission = new PermissionService(db).grantDomain('chatgpt.com');
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path, imported_at, permission_id, metadata_json)
    VALUES (?, 'conversation', 'chatgpt_web', '/c/legacy-review', 'Never analyzed', ?, ?, ?, ?, '{}')`,
  ).run(
    sourceId,
    sha256('NEVER_ANALYZED'),
    Vault.relativePathFor(sha256('NEVER_ANALYZED')),
    now,
    permission.id,
  );
  db.prepare(
    `INSERT INTO segments (id, source_id, sequence, role, is_active_branch, text, content_hash, metadata_json)
    VALUES (?, ?, 0, 'user', 1, 'NEVER_ANALYZED', ?, '{}')`,
  ).run(randomUUID(), sourceId, sha256('NEVER_ANALYZED'));
  expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  migrate(db);
  const revisions = new SourceStore(db).getRevisions(sourceId);
  expect(revisions.analyzed).toBeLessThan(revisions.content);
});

it('V06: re-extraction cannot revive a corrected old decision as an unqualified current decision', async () => {
  const f = fixture();
  const source = f.source();
  const oldStatement = 'Enable remote project logging';
  await extract(f, source.id, oldStatement);
  const correction = f.items.correct({
    itemId: aiItem(f, source.id).id,
    userText: 'Do not use remote logging; keep all project logs local.',
  });
  await extract(f, source.id, oldStatement);
  expect(f.items.get(correction.newItem.id).state).toBe('current');
  const revived = f
    .brief()
    .decisions.filter((e) => e.text === oldStatement && e.state === 'current');
  expect(revived).toHaveLength(0);
});

it('V07: a newly grounded contradiction must not be discarded merely for resembling a confirmed statement', async () => {
  const f = fixture();
  const oldStatement = '允许把项目记录上传到远程服务器保存';
  const newStatement = '不允许把项目记录上传到远程服务器保存';
  const source = f.source(oldStatement);
  await extract(f, source.id, oldStatement, oldStatement);
  f.items.confirm(aiItem(f, source.id).id);
  f.sources.appendCapturedTurns(source.id, [{ order: 10, role: 'user', text: newStatement }]);
  await extract(f, source.id, newStatement, newStatement, 'S3');
  const contradiction = f.items
    .list({ projectId: f.a.id })
    .find((i) => i.statement === newStatement);
  expect(
    contradiction,
    'The newly stated opposite decision must remain inspectable, not be silently skipped.',
  ).toBeDefined();
});

it('V08: moving a source must preserve a separately assigned item project', async () => {
  const f = fixture();
  const source = f.source();
  await extract(f, source.id, 'SEPARATELY_ASSIGNED');
  const itemId = aiItem(f, source.id).id;
  f.items.assignToProject(itemId, f.b.id);
  f.sources.bindProject(source.id, f.c.id);
  expect(f.sources.get(source.id)?.project_id).toBe(f.c.id);
  expect(f.items.get(itemId).project_id).toBe(f.b.id);
});

it('V09: changing a source project while extraction awaits a model must not insert new knowledge into the old project', async () => {
  const f = fixture();
  const source = f.source();
  const provider = new FakeProvider().enqueueStructured(output('MOVED_SOURCE_KNOWLEDGE'));
  const original = provider.chatStructured.bind(provider);
  vi.spyOn(provider, 'chatStructured').mockImplementation(async (input) => {
    const result = await original(input);
    f.sources.bindProject(source.id, f.b.id);
    return result;
  });
  // Rejecting this stale extraction is also valid. In neither case may A receive its output.
  try {
    await new Extractor(f.db, provider).extractSource(source.id);
  } catch {
    /* cancelled stale snapshot */
  }
  expect(f.sources.get(source.id)?.project_id).toBe(f.b.id);
  expect(f.brief(f.a.id).decisions.some((e) => e.text.includes('MOVED_SOURCE_KNOWLEDGE'))).toBe(
    false,
  );
});

it('V10: an unconfirmed important AI decision belongs in pending review and must be labeled pending in the briefing', async () => {
  const f = fixture();
  const source = f.source();
  await extract(f, source.id, 'UNCONFIRMED_IMPORTANT_DECISION');
  const candidate = aiItem(f, source.id);
  expect(candidate.confirmation).toBe('none');
  expect.soft(candidate.needs_review).toBe(true);
  const brief = f.brief();
  const pending = [...brief.risks, ...brief.decisions].find((e) => e.ref === candidate.id);
  const structuredPending = pending as
    (typeof pending & { confirmation?: string; needs_review?: boolean }) | undefined;
  expect(
    /待确认|未确认/.test(pending?.text ?? '') ||
      structuredPending?.confirmation === 'none' ||
      structuredPending?.needs_review === true ||
      brief.risks.some((e) => e.ref === candidate.id),
    'Pending may be explicit structured data, a risk entry, or a readable label; ai origin alone is not confirmation state.',
  ).toBe(true);
});

function work(projectRef: string) {
  return {
    project_ref: projectRef,
    agent_name: 'review-agent',
    task: 'Synthetic work',
    outcome: 'success' as const,
    summary: 'Synthetic result',
    changes: ['test-only.txt'],
    tests: [{ name: 'synthetic test', result: 'not_run' as const }],
    open_loops: [],
  };
}

it('V11: an idempotency key reused in another project cannot silently return the first project work record', () => {
  const f = fixture();
  const first = f.mcp.recordWorkResult({ ...work(f.a.id), client_ref: 'review-cross-project-key' });
  let second;
  try {
    second = f.mcp.recordWorkResult({ ...work(f.b.id), client_ref: 'review-cross-project-key' });
  } catch (err) {
    // Global-key conflict and separately scoped project keys are both acceptable designs.
    expect(String(err)).toMatch(/CONFLICT|冲突|client_ref 已被使用/);
    return;
  }
  const stored = f.db
    .prepare('SELECT project_id FROM work_runs WHERE id = ?')
    .get(second.work_run_id);
  expect(stored, `First record was ${first.work_run_id}`).toEqual({ project_id: f.b.id });
});

it('V12: changing commit_ref under the same idempotency key must be rejected as different content', () => {
  const f = fixture();
  f.mcp.recordWorkResult({
    ...work(f.a.id),
    client_ref: 'review-commit-key',
    commit_ref: 'commit-one',
  });
  expect(() =>
    f.mcp.recordWorkResult({
      ...work(f.a.id),
      client_ref: 'review-commit-key',
      commit_ref: 'commit-two',
    }),
  ).toThrow();
});

it('V13: a valid long client_ref must still produce valid briefing and resolvable work references', () => {
  const f = fixture();
  const input = recordWorkResultInputSchema.parse({
    ...work(f.a.id),
    client_ref: 'review-key-' + 'x'.repeat(110),
  });
  const result = f.mcp.recordWorkResult(input);
  expect
    .soft(getSourceExcerptInputSchema.safeParse({ ref: result.work_run_id }).success)
    .toBe(true);
  expect(prepareTaskOutputSchema.safeParse(f.brief()).success).toBe(true);
});

it('V14: the complete serialized briefing including coverage and notices fits max_chars', () => {
  const f = fixture();
  for (let i = 0; i < 8; i++)
    f.items.createManual({
      projectId: f.a.id,
      type: 'goal',
      statement: `${i}:` + 'Budgeted knowledge. '.repeat(16),
      rationale: null,
    });
  const brief = f.brief(f.a.id, 2000);
  expect(prepareTaskOutputSchema.safeParse(brief).success).toBe(true);
  expect(JSON.stringify(brief).length).toBeLessThanOrEqual(2000);
});

it('V15 CONTROL: ordinary authorized extraction writes the result and advances analyzed revision', async () => {
  const f = fixture();
  const source = f.source();
  const runtime = runtimeFor(f);
  const provider = new FakeProvider().enqueueStructured(output('AUTHORIZED_RESULT'));
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  const job = runtime.jobs.enqueue('extract', { sourceId: source.id });
  await tick(runtime.jobs);
  expect(provider.structuredCalls).toHaveLength(1);
  expect(runtime.jobs.get(job.id)?.status).toBe('succeeded');
  expect(f.sources.getRevisions(source.id)).toEqual({ content: 1, analyzed: 1 });
  expect(f.items.list({ projectId: f.a.id })[0]?.statement).toBe('AUTHORIZED_RESULT');
});
