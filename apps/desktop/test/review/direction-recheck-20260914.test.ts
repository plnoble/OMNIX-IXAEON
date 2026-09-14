/** Independent acceptance counterexamples. Synthetic DB / HTTPS / RPC only. No external models. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  McpService,
  SkillCandidateStore,
  ContextSelector,
  ResearchChecker,
  HermesRuntimeAdapter,
  JsonRpcStdio,
  type CoreDatabase,
  type WebSearchExecutor,
  type RuntimeRunInput,
} from '../../../../packages/core/src/index.js';

let dir: string;
let db: CoreDatabase;
let items: ItemService;
let projectId: string;
const disposers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-review-20260914-'));
  db = openDatabase(join(dir, 'synthetic.db'));
  migrate(db);
  items = new ItemService(db);
  projectId = new ProjectService(db).create({
    name: 'Synthetic review project',
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
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-review-20260914-')
  ) {
    throw new Error('Refusing cleanup outside this audit temporary directory');
  }
  rmSync(target, { recursive: true, force: true });
});

function personalItem() {
  return items.createManual({
    projectId: null,
    scope: 'personal',
    type: 'preference',
    statement: 'SYNTHETIC_MODEL_ONLY_PRIVATE',
    rationale: null,
  });
}

function researchFixture(relevant = false, deferredSearch?: WebSearchExecutor['search']) {
  let ms = 1_000_000;
  const search: WebSearchExecutor = {
    provider: 'tavily',
    search:
      deferredSearch ??
      (async (query) => ({
        query,
        provider: 'tavily',
        hits: [
          { title: 'Test page', url: 'https://research.example.com/article', snippet: 'synthetic' },
        ],
      })),
  };
  const body = relevant
    ? '<title>Rust borrow checker</title><p>Rust borrow checker lifetime analysis.</p>'
    : '<title>Celebrity fashion</title><p>Red carpet dresses and gossip.</p>';
  const checker = new ResearchChecker(
    db,
    { now: () => new Date(ms) },
    {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch,
    },
    () => search,
  );
  const topic = checker.createTopic({
    question: 'Rust borrow checker lifetime analysis',
    public_description: 'Rust borrow checker',
    sources: [],
    paid_budget_mode: 'request_cap',
    request_cap: 1,
    interval_ms: 60_000,
  });
  checker.store.setEnabled(topic.id, true, new Date(ms).toISOString());
  return {
    checker,
    topic,
    advance: () => {
      ms += 100_000;
    },
    now: () => new Date(ms).toISOString(),
  };
}

function protocolAdapter() {
  let created = 0;
  const adapter = new HermesRuntimeAdapter(undefined, () => {
    created++;
    const sessionId = `synthetic-session-${created}`;
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonRpcStdio(input, output);
    output.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const request = JSON.parse(line) as { id?: number; method: string };
        if (request.id === undefined) continue;
        queueMicrotask(() => {
          input.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result:
                request.method === 'session.create' ? { session_id: sessionId } : { ok: true },
            }) + '\n',
          );
          if (request.method === 'prompt.submit') {
            input.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'event',
                params: {
                  type: 'message.complete',
                  session_id: sessionId,
                  payload: { text: 'synthetic answer', status: 'complete' },
                },
              }) + '\n',
            );
          }
        });
      }
    });
    return {
      rpc,
      kill: () => {
        rpc.close();
        input.end();
        output.end();
      },
    };
  });
  vi.spyOn(adapter, 'probe').mockReturnValue({
    locator: {
      found: true,
      exe: 'synthetic-never-spawned',
      cwd: null,
      home: null,
      reason: 'synthetic factory only',
    },
    engine: 'hermes',
    session: true,
    stop: true,
    toolAllowlist: false,
    usage: false,
    resume: true,
    streaming: true,
    probedAt: new Date().toISOString(),
  });
  disposers.push(() => adapter.disposeAll());
  const request = (runId: string, version: string): RuntimeRunInput => ({
    runId,
    goal: 'synthetic review question',
    contextRef: 'personal',
    permissionVersion: version,
    allowedTools: [],
    budget: { maxToolCalls: 0, timeoutMs: 1000 },
    idempotencyKey: runId,
  });
  return { adapter, request, created: () => created };
}

describe('Independent direction and boundary recheck 2026-09-14', () => {
  it('C01 model-only disclosure must not unlock the generic MCP client evidence endpoint', () => {
    const item = personalItem();
    items.grantDisclosure({ itemId: item.id, audience: 'model' });
    const mcp = new McpService(db);
    expect(() => mcp.getSourceExcerpt(item.id, 200)).toThrow();
    expect(() => mcp.getEvidence(item.id)).toThrow();
  });

  it('C02 project fallback must not resurrect an unrelated one-off event', () => {
    const item = items.createManual({
      projectId,
      type: 'preference',
      statement: '这次会议，马来西亚放在中间，仅本次。',
      rationale: null,
    });
    const selected = new ContextSelector(db).selectForQuestion('数据库索引该怎么优化？', projectId);
    expect(selected.items.some((i) => i.id === item.id)).toBe(false);
  });

  it('C03 conflicting memories must remain explicitly disputed in the engine prompt', () => {
    const a = items.createManual({
      projectId,
      type: 'constraint',
      statement: '数据库只能使用方案甲',
      rationale: null,
    });
    const b = items.createManual({
      projectId,
      type: 'constraint',
      statement: '数据库只能使用方案乙',
      rationale: null,
    });
    db.prepare(
      "UPDATE items SET state='disputed', needs_review=1, needs_reasons='conflict' WHERE id IN (?, ?)",
    ).run(a.id, b.id);
    const selection = new ContextSelector(db).selectForQuestion('数据库约束是什么？', projectId);
    expect(selection.items).toHaveLength(2);
    expect(selection.promptBlock).toMatch(/冲突|待解决|disputed/);
  });

  it('C04 legacy text evaluation is not objective evidence for skill approval', () => {
    const store = new SkillCandidateStore(db);
    const skill = store.proposeFromFailure({
      projectId,
      task: 'Synthetic task',
      summary: 'Synthetic failure',
    });
    store.evaluate(skill.id, { evalBefore: 'failed', evalAfter: 'passed', benefit: 'improved' });
    expect(store.get(skill.id).eval_evidence_json).toBeNull();
    expect(() => store.approve(skill.id, { version: store.get(skill.id).version })).toThrow();
  });

  it('C05 editing a method cannot reuse its previous-version evidence for approval', () => {
    const store = new SkillCandidateStore(db);
    const skill = store.proposeFromFailure({
      projectId,
      task: 'Synthetic task',
      summary: 'Synthetic failure',
    });
    store.evaluateWithEvidence(skill.id, {
      method: 'method A',
      evidence: {
        exitCodeBefore: 1,
        exitCodeAfter: 0,
        outputBefore: 'synthetic fixture',
        outputAfter: 'synthetic fixture',
        verifiedAt: '2026-09-14T00:00:00Z',
        command: ['synthetic-never-executed'],
      },
      benefit: 'synthetic benefit',
    });
    store.updateMethod(skill.id, 'method B, never evaluated');
    store.evaluate(skill.id, { evalBefore: 'failed', evalAfter: 'passed', benefit: 'improved' });
    expect(() => store.approve(skill.id, { version: store.get(skill.id).version })).toThrow();
  });

  it('C06 irrelevant auto-discovered source stays quiet on the SECOND scheduled tick', async () => {
    const f = researchFixture();
    f.advance();
    const first = await f.checker.tick();
    expect(first?.findings).toHaveLength(0);
    expect(f.checker.store.listSources(f.topic.id)).toHaveLength(1);
    f.advance();
    const second = await f.checker.tick();
    expect(second?.run.status).toBe('succeeded');
    expect(second?.findings).toHaveLength(0);
  });

  it('C07 paused research must not retain new sources from late search results', async () => {
    let release!: (value: Awaited<ReturnType<WebSearchExecutor['search']>>) => void;
    const pending = new Promise<Awaited<ReturnType<WebSearchExecutor['search']>>>(
      (resolveSearch) => {
        release = resolveSearch;
      },
    );
    const f = researchFixture(false, () => pending);
    f.advance();
    const checking = f.checker.tick();
    f.checker.store.setPaused(f.topic.id, true, f.now());
    release({
      query: 'synthetic',
      provider: 'tavily',
      hits: [
        { title: 'Late source', url: 'https://research.example.com/late', snippet: 'synthetic' },
      ],
    });
    const result = await checking;
    expect(result?.run.status).toBe('cancelled');
    expect(f.checker.store.listSources(f.topic.id)).toHaveLength(0);
  });

  it('C08 changed disclosure epoch must not reuse an engine session containing old context', async () => {
    const f = protocolAdapter();
    const first = await f.adapter.start(f.request('r1', '1'));
    const second = await f.adapter.start(f.request('r2', '2'));
    expect(first.status).toBe('terminal');
    expect(second.status).toBe('terminal');
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('C09 direct MCP route must implement the newly registered evidence tool', async () => {
    // Evaluate only the unchanged routing function, never main() or a real MCP process.
    const source = readFileSync('apps/mcp/src/direct.ts', 'utf8');
    const ast = ts.createSourceFile('direct.ts', source, ts.ScriptTarget.ESNext, true);
    const node = ast.statements.find(
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'callDirect',
    );
    if (!node) throw new Error('callDirect routing function not found');
    const code = ts.transpileModule(node.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const route = runInNewContext(`${code}\ncallDirect`, { ErrorCodes, IxaError }) as (
      mcp: McpService,
      path: string,
      body: unknown,
    ) => Promise<unknown>;
    const item = items.createManual({
      projectId,
      type: 'goal',
      statement: 'Synthetic project goal',
      rationale: null,
    });
    const mcp = new McpService(db);
    await expect(
      route(mcp, '/api/mcp/get-source-excerpt', { ref: item.id, max_chars: 200 }),
    ).resolves.toBeTruthy();
    await expect(route(mcp, '/api/mcp/get-evidence', { item_id: item.id })).resolves.toMatchObject({
      item_id: item.id,
    });
  });

  it('CONTROL unchanged permissions may reuse the same synthetic engine session', async () => {
    const f = protocolAdapter();
    const first = await f.adapter.start(f.request('r1', '1'));
    const second = await f.adapter.start(f.request('r2', '1'));
    expect(second.sessionId).toBe(first.sessionId);
    expect(f.created()).toBe(1);
  });

  it('CONTROL entirely undisclosed personal content is denied on both MCP readers', () => {
    const item = personalItem();
    const mcp = new McpService(db);
    expect(() => mcp.getSourceExcerpt(item.id, 200)).toThrow();
    expect(() => mcp.getEvidence(item.id)).toThrow();
  });

  it('CONTROL a relevant unchanged page is not reported twice', async () => {
    const f = researchFixture(true);
    f.advance();
    expect((await f.checker.tick())?.findings).toHaveLength(1);
    f.advance();
    expect((await f.checker.tick())?.findings).toHaveLength(0);
  });
});
