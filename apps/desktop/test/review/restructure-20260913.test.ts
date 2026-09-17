/** Independent review: synthetic files/DB and protocol frames only; no external accounts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { MEMORY_EVAL_SCENARIOS } from '../../../../packages/core/src/memory/evalScenarios.js';
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
  SearchService,
  ConversationStore,
  CodingOrchestrator,
  FakeCodingExecutor,
  CoreToolBroker,
  TuiGatewaySession,
  JsonRpcStdio,
  HermesRuntimeAdapter,
  SkillCandidateStore,
  ResearchChecker,
  type CoreDatabase,
  type CodingExecutor,
  type IndependentCheck,
  type RuntimeRunInput,
} from '../../../../packages/core/src/index.js';

vi.mock('electron', () => ({ app: {}, safeStorage: {}, net: {}, ipcMain: {} }));

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let items: ItemService;
let permissions: PermissionService;
let imports: ImportService;
let projectId: string;
const disposers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-restructure-audit-'));
  db = openDatabase(join(dir, 'synthetic.db'));
  migrate(db);
  projects = new ProjectService(db);
  items = new ItemService(db);
  permissions = new PermissionService(db);
  imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, new SourceStore(db));
  projectId = projects.create({
    name: 'Synthetic audit project',
    rootPath: null,
    description: null,
  }).id;
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-restructure-audit-')
  ) {
    throw new Error('Refusing cleanup outside this audit temporary directory');
  }
  rmSync(target, { recursive: true, force: true });
});

const passing = async (argv: string[]): Promise<IndependentCheck> => ({
  argv,
  ran: true,
  exitCode: 0,
  output: 'synthetic validator',
});
function broker() {
  return new CoreToolBroker(
    db,
    items,
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir, passing),
    projects,
  );
}

async function seedPrivate(boundProject: string | null = null) {
  const statement = 'AUDIT_PRIVATE_ORCHID private planning detail';
  const file = join(dir, 'source.txt');
  writeFileSync(file, statement, 'utf8');
  const source = imports.importFile(file, {
    projectId: boundProject,
    permissionId: permissions.grantFile(file).id,
  }).created[0]!;
  await new Extractor(
    db,
    new FakeProvider().enqueueStructured({
      items: [
        {
          type: 'goal',
          statement,
          rationale: 'explicit synthetic text',
          confidence: 0.9,
          segment_ref: 'S1',
          project_hint: null,
          excerpt: statement,
        },
      ],
    }),
  ).extractSource(source.id);
  const item = items
    .list({ projectId: boundProject, state: 'current' })
    .find((i) => i.extracted_from_source_id === source.id)!;
  return { source, item, statement };
}

async function gateway(allowedTools: string[], maxToolCalls = 2) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
  const rpc = new JsonRpcStdio(input, output);
  output.on('data', (buf: Buffer) => {
    for (const line of String(buf).trim().split('\n')) {
      const msg = JSON.parse(line);
      messages.push(msg);
      if (msg.id !== undefined)
        queueMicrotask(() =>
          input.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: msg.method === 'session.create' ? { session_id: 's-audit' } : { ok: true },
            }) + '\n',
          ),
        );
    }
  });
  const transport = {
    rpc,
    kill: () => {
      rpc.close();
      input.end();
      output.end();
    },
  };
  const args: RuntimeRunInput = {
    runId: 'audit-run',
    goal: 'synthetic goal',
    contextRef: projectId,
    allowedTools,
    permissionVersion: '1',
    budget: { maxToolCalls, timeoutMs: 2000 },
    idempotencyKey: 'audit-key',
  };
  const session = new TuiGatewaySession(transport, args, broker());
  const result = session.run();
  const emit = (type: string, payload: Record<string, unknown>) =>
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type, session_id: 's-audit', payload },
      }) + '\n',
    );
  await new Promise((r) => setImmediate(r));
  disposers.push(() => session.dispose());
  return { session, result, emit, messages };
}

describe('Hermes protocol enforcement (synthetic frames, not real Hermes)', () => {
  it('H01 an unrelated command mentioning search_memory must not gain approval', async () => {
    const g = await gateway(['search_memory']);
    g.emit('approval.request', {
      request_id: 'approval-1',
      tool_name: 'terminal',
      command: 'echo search_memory && echo UNAUTHORIZED_ACTION',
    });
    await new Promise((r) => setImmediate(r));
    g.emit('message.complete', { text: 'done', status: 'complete' });
    await g.result;
    expect(g.messages.find((m) => m.method === 'approval.respond')?.params?.choice).toBe('deny');
  });

  it('H02 a tool outside the allowed set must not write to Core', async () => {
    const g = await gateway(['search_memory']);
    g.emit('tool.start', {
      tool_id: 'not-allowed',
      name: 'record_observation',
      args: { statement: 'AUDIT_UNAUTHORIZED_WRITE' },
    });
    g.emit('message.complete', { text: 'done', status: 'complete' });
    await g.result;
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM items WHERE statement='AUDIT_UNAUTHORIZED_WRITE'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('H03 repeated notification of the same tool call must not duplicate side effects', async () => {
    const g = await gateway(['record_observation']);
    const payload = {
      tool_id: 'same-call',
      name: 'record_observation',
      args: { statement: 'AUDIT_DUPLICATE' },
    };
    g.emit('tool.start', payload);
    g.emit('tool.start', payload);
    g.emit('message.complete', { text: 'done', status: 'complete' });
    await g.result;
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM items WHERE statement='AUDIT_DUPLICATE'").get(),
    ).toEqual({ n: 1 });
  });

  it('H04 late notification after interrupt must not mutate Core', async () => {
    const g = await gateway(['record_observation']);
    g.session.interrupt();
    g.emit('tool.start', {
      tool_id: 'late',
      name: 'record_observation',
      args: { statement: 'AUDIT_AFTER_CANCEL' },
    });
    await g.result;
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM items WHERE statement='AUDIT_AFTER_CANCEL'").get(),
    ).toEqual({ n: 0 });
  });

  it('H05 maxToolCalls must limit actual Core mutations', async () => {
    const g = await gateway(['record_observation'], 1);
    for (let i = 0; i < 3; i++)
      g.emit('tool.start', {
        tool_id: `budget-${i}`,
        name: 'record_observation',
        args: { statement: 'AUDIT_OVER_BUDGET' },
      });
    g.emit('message.complete', { text: 'done', status: 'complete' });
    await g.result;
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM items WHERE statement='AUDIT_OVER_BUDGET'").get() as {
          n: number;
        }
      ).n,
    ).toBeLessThanOrEqual(1);
  });
});

describe('Core model disclosure boundaries', () => {
  it('M01 locally readable but unshared personal source must not leak as search segments', async () => {
    const seeded = await seedPrivate();
    const result = await broker().invoke(
      'search_memory',
      { query: 'AUDIT_PRIVATE_ORCHID' },
      { audience: 'model', runId: 'privacy', projectId: null },
    );
    expect(JSON.stringify(result)).not.toContain(seeded.statement);
  });

  it('C02 control: revoked source raw segments are excluded from search', async () => {
    const seeded = await seedPrivate(projectId);
    items.confirm(seeded.item.id);
    permissions.revoke(seeded.source.permission_id!);
    const result = await broker().invoke(
      'search_memory',
      { query: 'AUDIT_PRIVATE_ORCHID' },
      { audience: 'model', runId: 'revoked', projectId },
    );
    // The historical policy retains derived conclusions; check raw text only.
    expect((result as { segments: unknown[] }).segments).toHaveLength(0);
  });

  it('M03 desktop ask must not silently recreate a revoked capture permission', async () => {
    const { AppRuntime } = await import('../../src/main/appRuntime.js');
    vi.spyOn(HermesRuntimeAdapter.prototype, 'probe').mockReturnValue({
      locator: { found: true },
    } as ReturnType<HermesRuntimeAdapter['probe']>);
    vi.spyOn(HermesRuntimeAdapter.prototype, 'start').mockResolvedValue({
      events: [],
      answer: 'synthetic answer',
      status: 'terminal',
      modelName: 'fake',
      providerName: 'fake',
    });
    const app = Object.create(AppRuntime.prototype) as InstanceType<typeof AppRuntime>;
    Object.assign(app, {
      db,
      items,
      imports,
      permissions,
      projects,
      search: new SearchService(db),
      coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir, passing),
      logger: { warn: vi.fn() },
      getProvider: () => new FakeProvider(),
      getWebSearchExecutor: () => null,
      enqueueExtract: vi.fn(),
      // D4：提问走按对话隔离的引擎会话；Object.create 绕过构造函数，显式注入。
      askSessions: new Map(),
      activeAskRuns: new Map(),
      conversations: new ConversationStore(db),
    });
    await app.ask({ conversationId: null, projectId: null, question: 'synthetic first question' });
    const permission = db
      .prepare("SELECT id FROM permissions WHERE locator='ask.ixaeon.local' AND status='active'")
      .get() as { id: string };
    permissions.revoke(permission.id);
    await app.ask({
      conversationId: null,
      projectId: null,
      question: 'synthetic second question after capture was revoked',
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM permissions WHERE locator='ask.ixaeon.local' AND status='active'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sources WHERE provider='ask_session'").get(),
    ).toEqual({ n: 1 });
  });
});

describe('Coding scope and independent verification', () => {
  it('E01 deletion outside the approved file scope must fail verification', async () => {
    const root = join(dir, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'keep.txt'), 'must remain');
    projects.rebindRoot(projectId, root);
    const executor: CodingExecutor = {
      name: 'synthetic-delete',
      async run(_task, ws) {
        rmSync(join(ws, 'keep.txt'));
        writeFileSync(join(ws, 'note.txt'), 'done');
        return {
          claimedSuccess: true,
          summary: 'done',
          changedPaths: [],
          testsModified: false,
          raw: '',
        };
      },
    };
    const orch = new CodingOrchestrator(db, executor, dir, passing);
    const task = orch.create({
      projectId,
      goal: 'only write note.txt',
      scope: ['note.txt'],
      allowedCommands: [[process.execPath, '-e', 'require("fs").accessSync("note.txt")']],
    });
    await orch.approveAndQueue(task.id);
    const result = await orch.dispatch(task.id);
    expect(result.status).toBe('failed');
  });

  it('E02 verification cannot supply broader permission flags than its workspace', async () => {
    const marker = join(dir, 'outside-workspace-marker.txt');
    const command = [
      process.execPath,
      '--permission',
      `--allow-fs-write=${dir}`,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)},'synthetic marker')`,
    ];
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
    const task = orch.create({
      projectId,
      goal: 'write note.txt only',
      scope: ['note.txt'],
      allowedCommands: [command],
    });
    await orch.approveAndQueue(task.id);
    await orch.dispatch(task.id);
    expect(existsSync(marker)).toBe(false);
  });

  it('E03 file changes by the validator must also respect the approved scope', async () => {
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
    const task = orch.create({
      projectId,
      goal: 'write note.txt only',
      scope: ['note.txt'],
      allowedCommands: [
        [
          process.execPath,
          '-e',
          "require('fs').writeFileSync('outside-approved-scope.txt','synthetic marker')",
        ],
      ],
    });
    await orch.approveAndQueue(task.id);
    const result = await orch.dispatch(task.id);
    expect(result.status).toBe('failed');
  });

  it('C01 control: the ordinary file existence validator succeeds', async () => {
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
    const task = orch.create({
      projectId,
      goal: 'write note.txt',
      scope: ['note.txt'],
      allowedCommands: [[process.execPath, '-e', "require('fs').accessSync('note.txt')"]],
    });
    await orch.approveAndQueue(task.id);
    const result = await orch.dispatch(task.id);
    expect(result.verify_status).toBe('passed');
  });
});

describe('Growth and proactive research requirements', () => {
  it('Q01 an empty response must not pass a required recall check', () => {
    // Evaluate the repository's exact pure scoring functions, without running its test suite or writing old evidence.
    const source = readFileSync(
      resolve('packages/core/test/integration/memory-eval-rescore.test.ts'),
      'utf8',
    );
    const pure = source.slice(source.indexOf('const KEY_FACTS'), source.indexOf("describe('B2"));
    const javascript = ts.transpileModule(pure + '\nglobalThis.auditRescore = rescore;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    const sandbox: {
      auditRescore?: (scenario: unknown, answer: string) => { missingRecall: string[] };
    } = {};
    runInNewContext(javascript, sandbox, { timeout: 1000 });
    const scenario = MEMORY_EVAL_SCENARIOS.find((s) => s.id === 'r6')!;
    expect(scenario.expectRecallKeys).toHaveLength(1);
    const result = sandbox.auditRescore!(scenario, '');
    expect(result.missingRecall).toHaveLength(1);
  });

  it('S01 empty before/after results do not qualify as a validated skill', () => {
    const store = new SkillCandidateStore(db);
    const candidate = store.proposeFromFailure({
      projectId,
      task: 'synthetic failure',
      summary: 'test failure',
    });
    store.evaluate(candidate.id, { evalBefore: '', evalAfter: '', benefit: 'improved' });
    expect(() => store.approve(candidate.id)).toThrow();
  });

  it('R01 an enabled direction can search on schedule without manually supplied URLs', async () => {
    const search = vi.fn(async (query: string) => ({
      provider: 'tavily' as const,
      query,
      hits: [],
    }));
    const checker = new ResearchChecker(db, undefined, {}, () => ({ provider: 'tavily', search }));
    const topic = checker.createTopic({
      question: 'public software updates',
      publicDescription: 'public software updates',
      sources: [],
    });
    // Synthetic pre-approval: a paid search request is permitted; do not demand spending under 'none'.
    db.prepare(
      "UPDATE research_topics SET paid_budget_mode='request_cap', request_cap=1 WHERE id=?",
    ).run(topic.id);
    checker.store.setEnabled(topic.id, true);
    expect(checker.store.getTopic(topic.id).paid_budget_mode).toBe('request_cap');
    await checker.tick();
    expect(search).toHaveBeenCalledTimes(1);
  });
});
