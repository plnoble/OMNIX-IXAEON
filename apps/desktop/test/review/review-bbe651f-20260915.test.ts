/** Independent review: synthetic data/network, controlled local Node checks only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { ipcMain } from 'electron';
import { registerIpc } from '../../src/main/ipc.js';
import { AppRuntime } from '../../src/main/appRuntime.js';
import {
  openDatabase,
  migrate,
  ProjectService,
  SkillCandidateStore,
  ResearchStore,
  ResearchChecker,
  createTinyFishFetcher,
  createWebSearchExecutor,
  runControlledVerifyCommand,
  TuiGatewaySession,
  JsonRpcStdio,
  type CoreDatabase,
  type TinyFishFetcher,
} from '../../../../packages/core/src/index.js';

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  shell: {},
  safeStorage: {},
  net: {},
  ipcMain: { handle: vi.fn() },
}));

let dir: string;
let db: CoreDatabase;
let projectId: string;
let skills: SkillCandidateStore;
const disposers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-bbe651f-audit-'));
  db = openDatabase(join(dir, 'synthetic.db'));
  migrate(db);
  projectId = new ProjectService(db).create({
    name: 'Synthetic audit',
    rootPath: null,
    description: null,
  }).id;
  skills = new SkillCandidateStore(db);
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-bbe651f-audit-')
  ) {
    throw new Error('Refusing cleanup outside this audit temporary directory');
  }
  rmSync(target, { recursive: true, force: true });
});

function failureRecord(task = 'Synthetic failing task') {
  const id = randomUUID();
  const clientRef = `coding-task:${randomUUID()}:v1:failed`;
  db.prepare(
    `INSERT INTO work_runs (id, project_id, agent_name, task, outcome,
    summary, tests_json, changes_json, open_loops_json, finished_at, client_ref)
    VALUES (?, ?, 'synthetic', ?, 'failed', 'Synthetic check failed', ?, '[]', '[]', ?, ?)`,
  ).run(
    id,
    projectId,
    task,
    JSON.stringify({ verify_exit_code: 2 }),
    new Date().toISOString(),
    clientRef,
  );
  return { id, clientRef, task };
}

function candidate() {
  const row = failureRecord();
  return skills.proposeFromFailure({
    projectId,
    workRunId: row.clientRef,
    task: row.task,
    summary: 'Synthetic failure',
  });
}

function ipcRuntime() {
  const dataDir = join(dir, 'synthetic-app-data');
  mkdirSync(dataDir);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db, dataDir });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return {
    dataDir,
    invoke: async (name: string, arg: unknown) => {
      const entry = vi
        .mocked(ipcMain.handle)
        .mock.calls.find(([channel]) => channel === `ixaeon:${name}`);
      if (!entry) throw new Error(`Missing IPC handler: ${name}`);
      return entry[1]({} as never, arg);
    },
  };
}

const SPA = '<html><title>Loading</title><body><div id="root"></div></body></html>';
function researchFixture(renderer: TinyFishFetcher, staticFetch?: typeof fetch) {
  const checker = new ResearchChecker(
    db,
    { now: () => new Date() },
    {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch:
        staticFetch ??
        ((async () =>
          new Response(SPA, { headers: { 'content-type': 'text/html' } })) as typeof fetch),
      tinyfishFetcher: renderer,
    },
  );
  const topic = checker.createTopic({
    question: 'Rust borrow checker',
    sources: [{ url: 'https://review.example.com/spa', kind: 'page' }],
    paid_budget_mode: 'none',
    request_cap: 0,
  });
  return { checker, topic };
}

describe('Independent review of bbe651f on 2026-09-15', () => {
  it('T01 actual skill IPC must not grant a verifier write access to app data when no evaluation workspace is bound', async () => {
    const s = candidate();
    const runtime = ipcRuntime();
    await runtime
      .invoke('evaluateSkillWithEvidence', {
        id: s.id,
        benefit: 'synthetic claim',
        command: [
          process.execPath,
          '-e',
          "require('fs').writeFileSync('audit-canary.txt','synthetic');console.log('done')",
        ],
      })
      .catch(() => undefined);
    expect(existsSync(join(runtime.dataDir, 'audit-canary.txt'))).toBe(false);
  });

  it('T02 an unrelated successful command must not prove that a failed method has improved', async () => {
    const s = candidate();
    const runtime = ipcRuntime();
    await expect(
      (async () => {
        await runtime.invoke('evaluateSkillWithEvidence', {
          id: s.id,
          benefit: 'claimed improvement',
          method: 'Untested new method',
          command: [process.execPath, '-e', "console.log('not testing the failed artifact')"],
        });
        return runtime.invoke('approveSkillCandidate', {
          id: s.id,
          version: skills.get(s.id).version,
        });
      })(),
    ).rejects.toThrow();
  });

  it('T03 TinyFish Search request must match the official GET and X-API-Key contract', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const search = createWebSearchExecutor('tinyfish', 'synthetic-key', {
      fetchFn: (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ query: 'Rust', results: [] }));
      }) as typeof fetch,
    });
    await search.search('Rust');
    const sent = calls[0]!;
    expect.soft(new URL(sent.url).origin).toBe('https://api.search.tinyfish.ai');
    expect.soft(sent.init?.method).toBe('GET');
    expect.soft(new URL(sent.url).searchParams.get('query')).toBe('Rust');
    expect.soft(new Headers(sent.init?.headers).get('X-API-Key')).toBe('synthetic-key');
  });

  it('T04 TinyFish Fetch must send urls and parse the documented results array', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = createTinyFishFetcher('synthetic-key', {
      fetchFn: (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            results: [
              {
                url: 'https://review.example.com/spa',
                final_url: 'https://review.example.com/spa',
                title: 'Synthetic title',
                text: 'Synthetic rendered Rust article',
                format: 'markdown',
              },
            ],
            errors: [],
            request_id: 'synthetic-id',
          }),
        );
      }) as typeof fetch,
    });
    const result = await fetcher.fetchRendered('https://review.example.com/spa');
    expect.soft(result.content).toBe('Synthetic rendered Rust article');
    expect.soft(new URL(calls[0]!.url).origin).toBe('https://api.fetch.tinyfish.ai');
    expect.soft(new Headers(calls[0]!.init?.headers).get('X-API-Key')).toBe('synthetic-key');
    expect
      .soft(JSON.parse(String(calls[0]!.init?.body)).urls)
      .toEqual(['https://review.example.com/spa']);
  });

  it('T05 a TinyFish per-URL failure in an HTTP 200 response must not become successful empty content', async () => {
    const fetcher = createTinyFishFetcher('synthetic-key', {
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            results: [],
            errors: [
              { url: 'https://review.example.com/spa', error: 'page_not_found', status: 404 },
            ],
          }),
        )) as typeof fetch,
    });
    await expect(fetcher.fetchRendered('https://review.example.com/spa')).rejects.toThrow();
  });

  it('T06 pausing during static fetch must prevent a NEW cloud-render call after the fetch completes', async () => {
    let release!: (r: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const render = vi.fn(async () => ({
      content: 'Synthetic rendered text',
      title: 'Synthetic',
      status: 200,
    }));
    const f = researchFixture({ fetchRendered: render }, (async () => {
      entered();
      return pending;
    }) as typeof fetch);
    const run = f.checker.checkNow(f.topic.id);
    await started;
    f.checker.store.setPaused(f.topic.id, true);
    release(new Response(SPA, { headers: { 'content-type': 'text/html' } }));
    expect((await run).run.status).toBe('cancelled');
    expect(render).not.toHaveBeenCalled();
  });

  it('T07 failed cloud rendering of a SPA skeleton must be visible in the research outcome', async () => {
    const f = researchFixture({
      fetchRendered: async () => {
        throw new Error('Synthetic renderer quota failure');
      },
    });
    const result = await f.checker.checkNow(f.topic.id);
    expect(result.run.error).not.toBeNull();
  });

  it('T08 TinyFish timeout must remain active while the response body is still pending', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    let finishBody!: (text: string) => void;
    const body = new Promise<string>((r) => {
      finishBody = r;
    });
    const fetcher = createTinyFishFetcher('synthetic-key', {
      timeoutMs: 100,
      fetchFn: (async (_url, init) => {
        signal = init?.signal ?? null;
        return { ok: true, status: 200, text: () => body } as Response;
      }) as typeof fetch,
    });
    const result = fetcher.fetchRendered('https://review.example.com/spa').catch(() => null);
    await vi.advanceTimersByTimeAsync(101);
    const aborted = (signal as AbortSignal | null)?.aborted ?? false;
    finishBody('{}');
    await result;
    expect(aborted).toBe(true);
  });

  it('T09 clustered candidates must resolve their actual source work runs before evaluation', async () => {
    failureRecord('Same task prefix A');
    failureRecord('Same task prefix B');
    const created = skills.autoEvolveFromFailurePatterns(projectId);
    expect(created).toHaveLength(1);
    const verify = vi.fn(async () => ({
      ran: true,
      exitCode: 1,
      output: 'Synthetic still failing check',
    }));
    await skills
      .runControlledEvaluation(created[0]!.id, {
        benefit: 'synthetic',
        command: ['synthetic-never-executed'],
        cwd: dir,
        runVerify: verify,
      })
      .catch(() => undefined);
    expect(verify).toHaveBeenCalledOnce();
  });

  it('T10 already-linked coding failures must not be proposed a second time by the aggregator', () => {
    const row = failureRecord();
    skills.proposeFromFailure({
      projectId,
      workRunId: row.clientRef,
      task: row.task,
      summary: 'synthetic',
    });
    expect(skills.autoEvolveFromFailurePatterns(projectId)).toHaveLength(0);
  });

  it('T11 watchdog timeout must stop the transport, not merely label the run as failed', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonRpcStdio(input, output);
    const kill = vi.fn(() => {
      rpc.close();
    });
    output.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const request = JSON.parse(line) as { id?: number; method: string };
        if (request.id === undefined) continue;
        input.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result:
              request.method === 'session.create'
                ? { session_id: 'synthetic-session' }
                : { ok: true },
          }) + '\n',
        );
      }
    });
    const session = new TuiGatewaySession(
      { rpc, kill },
      {
        runId: 'synthetic-watchdog',
        goal: 'synthetic',
        contextRef: 'synthetic',
        allowedTools: [],
        permissionVersion: '1',
        idempotencyKey: 'synthetic',
        budget: { maxToolCalls: 0, timeoutMs: 120000 },
      },
    );
    disposers.push(() => {
      session.dispose();
      input.end();
      output.end();
    });
    const outcome = session.run().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(65001);
    expect(await outcome).toBeInstanceOf(Error);
    expect(kill).toHaveBeenCalled();
  });

  it('T12 upgrading a legacy source with explicit auto_discovered provenance must not relabel it as user-approved', () => {
    const legacy = openDatabase(join(dir, 'legacy.db'));
    try {
      migrate(legacy, 21);
      const store = new ResearchStore(legacy);
      const topic = store.createTopic({
        question: 'Synthetic',
        sources: [{ url: 'https://review.example.com/legacy', kind: 'page' }],
      });
      legacy
        .prepare("UPDATE research_sources SET last_error='auto_discovered' WHERE topic_id=?")
        .run(topic.id);
      migrate(legacy);
      const row = legacy
        .prepare('SELECT discovered_by FROM research_sources WHERE topic_id=?')
        .get(topic.id);
      expect(row).toEqual({ discovered_by: 'auto' });
    } finally {
      legacy.close();
    }
  });

  it('CONTROL the Node verifier blocks writes outside its selected synthetic working directory', async () => {
    const cwd = join(dir, 'limited-workspace');
    mkdirSync(cwd);
    const outcome = await runControlledVerifyCommand(
      [process.execPath, '-e', "require('fs').writeFileSync('../outside-canary.txt','synthetic')"],
      cwd,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(existsSync(join(dir, 'outside-canary.txt'))).toBe(false);
  });

  it('CONTROL newly created auto sources retain their origin after successful checks', () => {
    const store = new ResearchStore(db);
    const topic = store.createTopic({ question: 'Synthetic', sources: [] });
    const source = store.addSource(
      topic.id,
      { url: 'https://review.example.com/new', kind: 'page' },
      undefined,
      { discoveredBy: 'auto' },
    );
    store.updateSourceCheck(source.id, {
      ok: true,
      fingerprint: 'synthetic',
      now: new Date().toISOString(),
    });
    expect(store.listSources(topic.id)[0]?.discovered_by).toBe('auto');
  });
});
