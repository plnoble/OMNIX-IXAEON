/** Independent review: synthetic data only; no real model, network, account or user DB. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  PermissionService,
  SourceStore,
  ImportService,
  Vault,
  Extractor,
  FakeProvider,
  AskService,
  McpService,
  buildPersonalOverview,
  CodingOrchestrator,
  CodingTaskStore,
  FakeCodingExecutor,
  ResearchChecker,
  isBlockedResolvedAddress,
  type CoreDatabase,
  type IndependentCheck,
} from '../../../../packages/core/src/index.js';
import { parsePage } from '../../../../packages/core/src/research/parse.js';
import { fetchApprovedSource } from '../../../../packages/core/src/research/fetchApproved.js';

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let items: ItemService;
let sources: SourceStore;
let imports: ImportService;
let permissions: PermissionService;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-audit-20260911-'));
  db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  projects = new ProjectService(db);
  items = new ItemService(db);
  sources = new SourceStore(db);
  permissions = new PermissionService(db);
  imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, sources);
  projectId = projects.create({ name: 'Synthetic project', rootPath: null, description: null }).id;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  const target = resolve(dir);
  if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-audit-20260911-')) {
    throw new Error('Refusing cleanup outside the uniquely created audit directory');
  }
  rmSync(target, { recursive: true, force: true });
});

async function extractedGoal(boundProject: string | null = null) {
  const statement = '用户希望所有工具之间可以共享经过确认的知识。';
  const file = join(dir, 'synthetic-source.txt');
  writeFileSync(file, statement, 'utf8');
  const source = imports.importFile(file, {
    projectId: boundProject,
    permissionId: permissions.grantFile(file).id,
  }).created[0]!;
  const response = {
    items: [{ type: 'goal', statement, rationale: '原文明确', confidence: 0.9,
      segment_ref: 'S1', project_hint: null, excerpt: statement }],
  };
  await new Extractor(db, new FakeProvider().enqueueStructured(response)).extractSource(source.id);
  const item = items.list({ projectId: null, state: 'current' })
    .find((i) => i.extracted_from_source_id === source.id)!;
  return { source, item, response };
}

const passingCheck = async (argv: string[]): Promise<IndependentCheck> => ({
  argv, exitCode: 0, output: 'synthetic check returned zero', ran: true,
});

function taskFor(orch: CodingOrchestrator, commands = [['node', '-e', 'process.exit(0)']]) {
  return orch.create({ projectId, goal: 'Produce the approved note', scope: ['note.txt'], allowedCommands: commands });
}

describe('Personal core and disclosure', () => {
  it('C01 manual personal goals remain visible (control)', () => {
    const item = items.createManual({ projectId: null, scope: 'personal', type: 'goal', statement: 'manual goal', rationale: null });
    expect(buildPersonalOverview(db).goals.some((i) => i.id === item.id)).toBe(true);
  });

  it('RQ01 a user-confirmed extracted goal must appear as a personal goal', async () => {
    const { item } = await extractedGoal();
    items.setScope(item.id, 'personal');
    items.confirm(item.id);
    expect(items.get(item.id).confirmation).toBe('confirmed');
    expect(buildPersonalOverview(db).goals.map((i) => i.id)).toContain(item.id);
  });

  it('RQ02 marking an extracted item personal must survive re-extraction', async () => {
    const { source, item, response } = await extractedGoal();
    items.setScope(item.id, 'personal');
    await new Extractor(db, new FakeProvider().enqueueStructured(response)).extractSource(source.id);
    const current = items.list({ projectId: null, state: 'current' }).filter((i) => i.statement === item.statement);
    expect(current.map((i) => i.scope)).toEqual(['personal']);
  });

  it('C02 unshared personal manual item is denied to MCP (control)', () => {
    const item = items.createManual({ projectId: null, scope: 'personal', type: 'constraint', statement: 'synthetic-private', rationale: null });
    expect(() => new McpService(db).getSourceExcerpt(item.id, 1000)).toThrow();
  });

  it('RQ03 personal data without model disclosure must not reach the model', async () => {
    const marker = 'SYNTHETIC_PRIVATE_MODEL_MARKER_20260911';
    items.createManual({ projectId: null, scope: 'personal', type: 'constraint', statement: marker, rationale: null });
    const provider = new FakeProvider().enqueueText('Synthetic answer');
    await new AskService(db, provider).ask(null, '我的约束是什么？');
    expect(provider.textCalls.map((c) => c.user).join('\n')).not.toContain(marker);
  });

  it('RQ04 personal classification must also protect the source segment reference', async () => {
    const { source, item } = await extractedGoal(projectId);
    items.setScope(item.id, 'personal');
    const segment = db.prepare('SELECT id FROM segments WHERE source_id = ? ORDER BY sequence').get(source.id) as { id: string };
    expect(() => new McpService(db).getSourceExcerpt(segment.id, 1000)).toThrow();
  });
});

describe('Actual execution guarantees (synthetic executor only)', () => {
  it('RQ05 prepared project workspace must contain the authorized project snapshot', () => {
    const repo = join(dir, 'synthetic-repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'README.md'), 'PROJECT_BASELINE_SENTINEL', 'utf8');
    const project = projects.create({ name: 'With source', rootPath: repo, description: null });
    const store = new CodingTaskStore(db);
    const task = store.create({ projectId: project.id, goal: 'Update existing readme', scope: ['README.md'], allowedCommands: [] });
    const prepared = store.prepareWorkspace(task.id, dir);
    expect(existsSync(join(prepared.workspace_path!, 'README.md'))).toBe(true);
  });

  it('RQ06 writing outside approved files must not pass just because it stays inside the workspace', async () => {
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor({ files: { 'unapproved.txt': 'synthetic' } }), dir, passingCheck);
    const task = taskFor(orch);
    await orch.approveAndQueue(task.id);
    const result = await orch.dispatch(task.id);
    expect(result.status).toBe('failed');
  });

  it('RQ07 executor failure must not be converted into successful acceptance by an exit-zero verifier', async () => {
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor({ claimedSuccess: false, files: {} }), dir, passingCheck);
    const task = taskFor(orch);
    await orch.approveAndQueue(task.id);
    const result = await orch.dispatch(task.id);
    expect(result.status).toBe('failed');
  });

  it('RQ08 all approved validation commands must run, including the failing second check', async () => {
    const calls: string[][] = [];
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir, async (argv) => {
      calls.push(argv);
      return { argv, exitCode: argv[0] === 'second' ? 1 : 0, output: 'synthetic', ran: true };
    });
    const task = taskFor(orch, [['first'], ['second']]);
    await orch.approveAndQueue(task.id);
    const result = await orch.dispatch(task.id);
    expect({ calls: calls.length, status: result.status }).toEqual({ calls: 2, status: 'failed' });
  });

  it('RQ09 repeated dispatch of a completed task must not execute it again', async () => {
    let runs = 0;
    const fake = new FakeCodingExecutor();
    const orch = new CodingOrchestrator(db, { name: 'counted-fake', run: async (...args) => { runs++; return fake.run(...args); } }, dir, passingCheck);
    const task = taskFor(orch);
    await orch.approveAndQueue(task.id);
    await orch.dispatch(task.id);
    orch.accept(task.id);
    try { await orch.dispatch(task.id); } catch { /* Explicit rejection is acceptable. */ }
    expect(runs).toBe(1);
  });

  it('RQ10 cancellation during verification must not be overwritten by the late passing result', async () => {
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    let release!: (r: IndependentCheck) => void;
    const check = new Promise<IndependentCheck>((r) => { release = r; });
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir, async () => { entered(); return check; });
    const task = taskFor(orch);
    await orch.approveAndQueue(task.id);
    const running = orch.dispatch(task.id);
    await started;
    orch.cancel(task.id);
    release({ argv: ['synthetic'], exitCode: 0, output: 'late pass', ran: true });
    await running;
    expect(orch.store.get(task.id).status).toBe('cancelled');
  });

  it('RQ11 accepted coding work must enter the shared work history for the next handoff', async () => {
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir, passingCheck);
    const task = taskFor(orch);
    await orch.approveAndQueue(task.id);
    await orch.dispatch(task.id);
    orch.accept(task.id);
    const row = db.prepare('SELECT COUNT(*) AS n FROM work_runs WHERE project_id = ?').get(projectId) as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });

  it('RQ17 verification code must not write outside the approved workspace (synthetic sibling canary only)', async () => {
    const canary = join(dir, 'outside-workspace-canary.txt');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'SYNTHETIC_CANARY');`;
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor({ files: { 'test.cjs': script } }), dir);
    const task = orch.create({
      projectId, goal: 'Run the approved isolated validation', scope: ['test.cjs'],
      allowedCommands: [[process.execPath, 'test.cjs']],
    });
    await orch.approveAndQueue(task.id);
    await orch.dispatch(task.id);
    expect(existsSync(canary)).toBe(false);
  });
});

describe('Research correctness and network boundaries (no real network)', () => {
  it('C03 IPv4 loopback is rejected (control)', () => {
    expect(isBlockedResolvedAddress('127.0.0.1')).toBe(true);
  });

  it('RQ12 real changes after a long unchanged page prefix must change its fingerprint', () => {
    const prefix = `<html><title>Release</title><body>${'navigation '.repeat(120)}`;
    const old = parsePage(prefix + '<p>Version 1: old implementation</p></body></html>', 'https://example.com/releases');
    const next = parsePage(prefix + '<p>Version 2: important new capability</p></body></html>', 'https://example.com/releases');
    expect(next.fingerprint).not.toBe(old.fingerprint);
  });

  it('RQ13 IPv4-mapped IPv6 loopback must be rejected too', () => {
    expect(isBlockedResolvedAddress('::ffff:7f00:1')).toBe(true);
  });

  it('RQ14 pausing while a response is in flight must prevent persistence of late findings', async () => {
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    let release!: (r: Response) => void;
    const response = new Promise<Response>((r) => { release = r; });
    const checker = new ResearchChecker(db, undefined, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async () => { entered(); return response; },
    });
    const topic = checker.createTopic({ question: 'synthetic topic', sources: [{ url: 'https://example.com/news', kind: 'page' }] });
    const pending = checker.checkNow(topic.id);
    await started;
    checker.store.setPaused(topic.id, true);
    release(new Response('<title>Late finding</title><p>Content arrived after pause</p>', { headers: { 'content-type': 'text/html' } }));
    const result = await pending;
    expect(result.run.status).toBe('cancelled');
    expect(checker.store.listFindings(topic.id)).toHaveLength(0);
  });

  it('RQ15 the 20-second fetch timeout must cover reading the response body', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let reading!: () => void;
    const started = new Promise<void>((r) => { reading = r; });
    let release!: (b: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((r) => { release = r; });
    const pending = fetchApprovedSource('https://example.com/slow', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (_url, init) => {
        signal = init.signal as AbortSignal;
        return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: () => { reading(); return body; } } as Response;
      },
    });
    await started;
    await vi.advanceTimersByTimeAsync(21000);
    const wasAborted = signal?.aborted;
    release(new ArrayBuffer(0));
    await pending.catch(() => undefined);
    expect(wasAborted).toBe(true);
  });

  it('RQ16 production task UI must not present an unconditional exit-zero as meaningful verification', () => {
    const ui = readFileSync(resolve('apps/desktop/src/renderer/src/pages/Tasks.tsx'), 'utf8');
    expect(ui).not.toContain("allowedCommands: [['node', '-e', 'process.exit(0)']]");
  });
});
