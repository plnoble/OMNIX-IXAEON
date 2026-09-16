/** Independent review. Synthetic data, HTTP injection, mocked network; no paid services. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ipcMain } from 'electron';
import { defaultAppConfig } from '../../../../packages/contracts/src/index.js';
import {
  CodingOrchestrator,
  FakeCodingExecutor,
  PermissionService,
  ProjectService,
  ResearchChecker,
  SkillCandidateStore,
  SourceStore,
  Vault,
  createTinyFishFetcher,
  migrate,
  openDatabase,
  runControlledVerifyCommand,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';
import { LocalServer } from '../../src/main/server/localServer.js';

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
let coding: CodingOrchestrator;
const apps: FastifyInstance[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-f71da15-audit-'));
  db = openDatabase(join(dir, 'synthetic.db'));
  migrate(db);
  projectId = new ProjectService(db).create({
    name: 'Synthetic private project A',
    rootPath: null,
    description: null,
  }).id;
  skills = new SkillCandidateStore(db);
  coding = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-f71da15-audit-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

function candidate() {
  const id = randomUUID();
  const ref = `synthetic:${randomUUID()}`;
  db.prepare(
    `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at, client_ref)
    VALUES (?, ?, 'synthetic', 'broken sorting', 'failed', 'known failed case', ?, '[]', '[]', ?, ?)`,
  ).run(id, projectId, JSON.stringify({ verify_exit_code: 2 }), new Date().toISOString(), ref);
  return skills.proposeFromFailure({
    projectId,
    workRunId: ref,
    task: 'broken sorting',
    summary: 'known failed case',
  });
}

function ipcRuntime() {
  const dataDir = join(dir, 'app-data');
  mkdirSync(dataDir, { recursive: true });
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, { db, dataDir });
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime);
  return async (name: string, arg: unknown) => {
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === `ixaeon:${name}`);
    if (!entry) throw new Error(`Missing IPC ${name}`);
    return entry[1]({} as never, arg);
  };
}

async function workspace(project = projectId) {
  const task = coding.create({
    projectId: project,
    goal: 'Synthetic authorized file task',
    scope: ['allowed.txt'],
    allowedCommands: [[process.execPath, '-e', "require('fs').existsSync('allowed.txt')"]],
  });
  const queued = await coding.approveAndQueue(task.id);
  if (!queued.workspace_path) throw new Error('Missing fixture workspace');
  return queued;
}

async function httpFixture() {
  let config = { ...defaultAppConfig(), localToken: 'synthetic-local-token'.padEnd(64, 'x') };
  const search = vi.fn(async (query: string) => ({ provider: 'synthetic', query, hits: [] }));
  const read = vi.fn(async (url: string) => ({
    finalUrl: url,
    status: 200,
    excerpt: 'synthetic public page',
  }));
  const server = new LocalServer({
    db,
    permissions: new PermissionService(db),
    sources: new SourceStore(db),
    vault: new Vault(join(dir, 'vault')),
    getConfig: () => config,
    updateConfig: (fn) => {
      config = fn(config) as typeof config;
    },
    getWebSearchExecutor: () => ({ provider: 'synthetic', search }) as never,
    fetchWebPage: read,
    getCodingOrchestrator: () => coding,
  });
  const app = Fastify();
  apps.push(app);
  await server.register(app);
  return { app, search, read, headers: { authorization: `Bearer ${config.localToken}` } };
}

describe('Independent review f71da15, 2026-09-16', () => {
  it('F01 changing print text must not turn an untested method into an approved skill', async () => {
    const s = candidate();
    const task = await workspace();
    const invoke = ipcRuntime();
    await expect(
      (async () => {
        await invoke('evaluateSkillWithEvidence', {
          id: s.id,
          taskId: task.id,
          method: 'Method never executed',
          benefit: 'Unsupported claim',
          command: [process.execPath, '-e', "console.log('assert')"],
        });
        return invoke('approveSkillCandidate', { id: s.id, version: skills.get(s.id).version });
      })(),
    ).rejects.toThrow();
  });

  it('F02 a candidate cannot write into a different project task workspace', async () => {
    const s = candidate();
    const other = new ProjectService(db).create({
      name: 'Synthetic unrelated B',
      rootPath: null,
      description: null,
    });
    const task = await workspace(other.id);
    const invoke = ipcRuntime();
    await invoke('evaluateSkillWithEvidence', {
      id: s.id,
      taskId: task.id,
      method: 'Unbound method',
      benefit: 'Unbound claim',
      command: [
        process.execPath,
        '-e',
        "require('fs').writeFileSync('foreign-canary.txt','synthetic')",
      ],
    }).catch(() => undefined);
    expect(existsSync(join(task.workspace_path!, 'foreign-canary.txt'))).toBe(false);
  });

  it('F03 diagnostic control: current Tasks UI payload stops at missing workspace binding', async () => {
    const s = candidate();
    await workspace();
    const invoke = ipcRuntime();
    // Matches Tasks.tsx: it sends id/command/benefit, never taskId.
    // The fixture has a workspace, but UI has no way to bind it.
    await expect(
      invoke('evaluateSkillWithEvidence', {
        id: s.id,
        command: [process.execPath, '-e', "require('assert').ok(true)"],
        benefit: 'UI request',
      }),
    ).rejects.toThrow(/绑定有效的编码任务工作区/);
  });

  it('F04 a generic MCP token without any live run or search grant cannot start paid searches', async () => {
    const f = await httpFixture();
    for (let n = 0; n < 4; n++) {
      await f.app.inject({
        method: 'POST',
        url: '/api/mcp/search-web',
        headers: f.headers,
        payload: { query: 'synthetic public topic' },
      });
    }
    expect(f.search).not.toHaveBeenCalled();
  });

  it('F05 get-task-status must not expose an unshared private task to a generic MCP client', async () => {
    const f = await httpFixture();
    const task = coding.create({
      projectId,
      goal: 'SYNTHETIC_PRIVATE_NEGOTIATION',
      scope: ['private.txt'],
      allowedCommands: [],
    });
    db.prepare(
      'UPDATE coding_tasks SET verify_output = ?, executor_report_json = ? WHERE id = ?',
    ).run(
      'SYNTHETIC_PRIVATE_VERIFY_DETAIL',
      JSON.stringify({ summary: 'SYNTHETIC_PRIVATE_REPORT', changedPaths: ['private.txt'] }),
      task.id,
    );
    // No sources/project sharing permission and no active authorized run in this fresh DB.
    const res = await f.app.inject({
      method: 'POST',
      url: '/api/mcp/get-task-status',
      headers: f.headers,
      payload: { task_id: task.id },
    });
    expect(res.body).not.toContain('SYNTHETIC_PRIVATE');
  });

  it('F06 scheduled research with no paid budget must not start cloud rendering', async () => {
    const render = vi.fn(async () => ({
      title: 'Synthetic',
      content: 'Synthetic rendered content',
      status: 200,
    }));
    const checker = new ResearchChecker(
      db,
      { now: () => new Date() },
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () =>
          new Response('<html><div id="root"></div></html>', {
            headers: { 'content-type': 'text/html' },
          }),
        tinyfishFetcher: { fetchRendered: render },
      },
    );
    const topic = checker.createTopic({
      question: 'Synthetic direction',
      sources: [{ url: 'https://review.example.com/spa', kind: 'page' }],
      paid_budget_mode: 'none',
      request_cap: 0,
    });
    checker.store.setEnabled(topic.id, true, '2000-01-01T00:00:00.000Z');
    const result = await checker.tick();
    expect(result).not.toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it('F07 cloud fetch must reject a response above the 2 MiB limit', async () => {
    const fetcher = createTinyFishFetcher('synthetic-key', {
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            results: [
              { url: 'https://review.example.com/page', text: 'x'.repeat(2 * 1024 * 1024 + 100) },
            ],
            errors: [],
          }),
        )) as typeof fetch,
    });
    await expect(fetcher.fetchRendered('https://review.example.com/page')).rejects.toThrow();
  });

  it('F08 an empty results array is not a successfully read dynamic page', async () => {
    const fetcher = createTinyFishFetcher('synthetic-key', {
      fetchFn: (async () =>
        new Response(JSON.stringify({ results: [], errors: [] }))) as typeof fetch,
    });
    await expect(fetcher.fetchRendered('https://review.example.com/page')).rejects.toThrow();
  });

  it('CONTROL missing local token blocks the new MCP search endpoint', async () => {
    const f = await httpFixture();
    const res = await f.app.inject({
      method: 'POST',
      url: '/api/mcp/search-web',
      payload: { query: 'synthetic' },
    });
    expect(res.statusCode).toBe(401);
    expect(f.search).not.toHaveBeenCalled();
  });

  it('CONTROL controlled Node verification can genuinely fail an assertion', async () => {
    const task = await workspace();
    const result = await runControlledVerifyCommand(
      [process.execPath, '-e', "require('assert').strictEqual(1,2)"],
      task.workspace_path!,
    );
    expect(result.ran).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
