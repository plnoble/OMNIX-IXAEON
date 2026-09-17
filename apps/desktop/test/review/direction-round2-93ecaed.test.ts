/** Independent second re-audit. Synthetic DB, network and models only; no real executions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ipcMain } from 'electron';
import { registerIpc } from '../../src/main/ipc.js';
import { AppRuntime } from '../../src/main/appRuntime.js';
import {
  openDatabase,
  migrate,
  ItemService,
  ProjectService,
  PermissionService,
  ResearchChecker,
  FakeProvider,
  SkillCandidateStore,
  type CoreDatabase,
  type WebSearchExecutor,
} from '../../../../packages/core/src/index.js';
import { getDisclosureEpoch, modelMayReadItem } from '../../../../packages/core/src/access.js';

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
let items: ItemService;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-round2-93ecaed-'));
  db = openDatabase(join(dir, 'synthetic.db'));
  migrate(db);
  items = new ItemService(db);
  projectId = new ProjectService(db).create({
    name: 'Synthetic second review',
    rootPath: null,
    description: null,
  }).id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-round2-93ecaed-')
  ) {
    throw new Error('Refusing cleanup outside this audit temporary directory');
  }
  rmSync(target, { recursive: true, force: true });
});

function ipcFor(runtime: object) {
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(runtime as AppRuntime);
  return async (name: string, arg: unknown): Promise<unknown> => {
    const registration = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === `ixaeon:${name}`);
    if (!registration) throw new Error(`Missing real IPC handler: ${name}`);
    return registration[1]({} as never, arg);
  };
}

function personalItem() {
  return items.createManual({
    projectId: null,
    scope: 'personal',
    type: 'preference',
    statement: 'SYNTHETIC_PRIVATE_REVIEW_ITEM',
    rationale: null,
  });
}

function researchFixture(provider?: FakeProvider) {
  let ms = Date.parse('2026-09-14T00:00:00Z');
  let body = '<title>Celebrity fashion</title><p>Red carpet dresses and gossip.</p>';
  const search: WebSearchExecutor = {
    provider: 'tavily',
    search: async (query) => ({
      query,
      provider: 'tavily',
      hits: [
        {
          title: 'Synthetic page',
          url: 'https://review.example.com/article',
          snippet: 'synthetic',
        },
      ],
    }),
  };
  const checker = new ResearchChecker(
    db,
    { now: () => new Date(ms) },
    {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: {
            'content-type': body.startsWith('<rss') ? 'application/rss+xml' : 'text/html',
          },
        })) as typeof fetch,
    },
    () => search,
    provider ? () => provider : undefined,
  );
  return {
    checker,
    setBody: (next: string) => {
      body = next;
    },
    advance: () => {
      ms += 100_000;
    },
    now: () => new Date(ms).toISOString(),
  };
}

describe('Independent second re-audit of 93ecaed', () => {
  it('R01 actual desktop create IPC must persist the selected search budget and interval', async () => {
    const f = researchFixture();
    const invoke = ipcFor({ research: f.checker });
    await invoke('createResearchTopic', {
      question: 'Rust research',
      publicDescription: 'Rust borrow checker',
      sources: [],
      paidBudgetMode: 'request_cap',
      requestCap: 5,
      intervalMs: 60_000,
    });
    const row = db
      .prepare('SELECT paid_budget_mode, request_cap, interval_ms FROM research_topics')
      .get();
    expect(row).toEqual({ paid_budget_mode: 'request_cap', request_cap: 5, interval_ms: 60_000 });
  });

  it('R02 changed but still irrelevant auto-discovered page must stay quiet after the first successful check', async () => {
    const f = researchFixture();
    const topic = f.checker.createTopic({
      question: 'Rust borrow checker lifetime analysis',
      public_description: 'Rust borrow checker',
      sources: [],
      paid_budget_mode: 'request_cap',
      request_cap: 1,
      interval_ms: 60_000,
    });
    f.checker.store.setEnabled(topic.id, true, f.now());
    f.advance();
    expect((await f.checker.tick())?.findings).toHaveLength(0);
    expect(f.checker.store.listSources(topic.id)).toHaveLength(1);
    f.setBody('<title>Celebrity fashion update</title><p>New dresses, weddings and gossip.</p>');
    f.advance();
    const second = await f.checker.tick();
    expect(second?.run.status).toBe('succeeded');
    expect(second?.findings).toHaveLength(0);
  });

  it('R03 actual skill IPC must not approve caller-authored JSON as trusted execution evidence', async () => {
    const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
    Object.assign(runtime, { db });
    const invoke = ipcFor(runtime);
    const created = (await invoke('proposeSkillCandidate', {
      projectId,
      task: 'Synthetic task never executed',
      summary: 'Claimed failure',
    })) as { id: string };
    await expect(
      (async () => {
        await invoke('evaluateSkillWithEvidence', {
          id: created.id,
          method: 'Untested method',
          benefit: 'Unverified improvement',
          evidence: {
            exitCodeBefore: 1,
            exitCodeAfter: 0,
            outputBefore: 'Caller claims failure',
            outputAfter: 'Caller claims success',
            verifiedAt: 'not-an-evaluation-time',
            command: ['review-command-that-does-not-exist'],
          },
        });
        const current = new SkillCandidateStore(db).get(created.id);
        return invoke('approveSkillCandidate', { id: created.id, version: current.version });
      })(),
    ).rejects.toThrow();
  });

  it('R04 expired effective disclosure must change the resident-session permission epoch', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    const item = personalItem();
    items.grantDisclosure({
      itemId: item.id,
      audience: 'model',
      expiresAt: '2026-09-14T00:00:01Z',
    });
    expect(modelMayReadItem(db, item.id)).toBe(true);
    const before = getDisclosureEpoch(db);
    vi.setSystemTime(new Date('2026-09-14T00:00:02Z'));
    expect(modelMayReadItem(db, item.id)).toBe(false);
    expect(getDisclosureEpoch(db)).not.toBe(before);
  });

  it('R05 correcting an item via actual IPC must invalidate resident old conclusions', async () => {
    const item = items.createManual({
      projectId,
      type: 'constraint',
      statement: 'Use option A',
      rationale: null,
    });
    const invalidateContext = vi.fn();
    const invoke = ipcFor({ db, items, invalidateContext });
    await invoke('correctItem', { itemId: item.id, userText: 'Use option B instead' });
    expect(items.get(item.id).state).toBe('superseded');
    expect(invalidateContext).toHaveBeenCalled();
  });

  it('R06 revoking a source via actual IPC must invalidate the current engine context immediately', async () => {
    const permissions = new PermissionService(db);
    const permission = permissions.grantDomain('synthetic-review.invalid');
    const invalidateContext = vi.fn();
    const invoke = ipcFor({
      db,
      permissions,
      invalidateContext,
      sources: { get: () => ({ permission_id: permission.id }) },
    });
    const result = (await invoke('revokeSourceReading', 'synthetic-source')) as { status: string };
    expect(result.status).toBe('revoked');
    expect(invalidateContext).toHaveBeenCalled();
  });

  it('R07 configured model failure must be visible instead of silently becoming successful model research', async () => {
    const provider = new FakeProvider(); // Empty response queue deliberately fails chatText.
    const f = researchFixture(provider);
    f.setBody('<title>Rust borrow checker</title><p>Rust lifetime analysis has changed.</p>');
    const topic = f.checker.createTopic({
      question: 'Rust borrow checker',
      public_description: '',
      sources: [{ url: 'https://review.example.com/article', kind: 'page' }],
    });
    const result = await f.checker.checkNow(topic.id);
    expect(provider.textCalls).toHaveLength(1);
    expect(result.run.error).not.toBeNull();
  });

  it('R08 one scheduled run must enforce the planned eight model-call ceiling independently of search budget', async () => {
    const provider = new FakeProvider();
    for (let i = 0; i < 10; i++)
      provider.enqueueText(
        JSON.stringify({
          relevant: true,
          summary: `Synthetic Rust update ${i}`,
          valueAnalysis: 'synthetic',
          confidence: 0.9,
        }),
      );
    const f = researchFixture(provider);
    f.setBody(
      '<rss><channel>' +
        Array.from(
          { length: 10 },
          (_, i) =>
            `<item><title>Rust update ${i}</title><link>https://review.example.com/${i}</link><description>Rust borrow checker update ${i}</description></item>`,
        ).join('') +
        '</channel></rss>',
    );
    const topic = f.checker.createTopic({
      question: 'Rust borrow checker',
      public_description: '',
      sources: [{ url: 'https://review.example.com/feed', kind: 'feed' }],
      paid_budget_mode: 'none',
      request_cap: 0,
      interval_ms: 60_000,
    });
    f.checker.store.setEnabled(topic.id, true, f.now());
    f.advance();
    expect((await f.checker.tick())?.run.status).toBe('succeeded');
    expect(provider.textCalls.length).toBeLessThanOrEqual(8);
  });

  it('R09 app shutdown must dispose resident Agent context before closing its database', async () => {
    const invalidateContext = vi.fn();
    const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
    Object.assign(runtime, {
      researchTimer: null,
      localServer: { stopBackgroundTasks: vi.fn() },
      jobs: { stop: vi.fn(), idle: async () => undefined },
      fastify: null,
      db: { close: vi.fn() },
      logger: { info: vi.fn() },
      // D4：长驻引擎上下文改为按对话隔离的 Map（原来是单个 currentAsk 字段）。
      // 关机必须把每个对话的上下文都释放掉，不只是「当前那个」。
      askSessions: new Map([['conv-1', { invalidateContext }]]),
    });
    await runtime.stop();
    expect(invalidateContext).toHaveBeenCalled();
  });

  it('CONTROL explicit budget amendment via IPC works after creation', async () => {
    const f = researchFixture();
    const topic = f.checker.createTopic({ question: 'Rust', sources: [] });
    const invoke = ipcFor({ research: f.checker });
    await invoke('setResearchBudget', {
      id: topic.id,
      paidBudgetMode: 'request_cap',
      requestCap: 5,
    });
    expect(f.checker.store.getTopic(topic.id)).toMatchObject({
      paid_budget_mode: 'request_cap',
      request_cap: 5,
    });
  });

  it('CONTROL explicit item disclosure revocation now invalidates context and blocks future reads', async () => {
    const item = personalItem();
    const grant = items.grantDisclosure({ itemId: item.id, audience: 'model' });
    const invalidateContext = vi.fn();
    const invoke = ipcFor({ db, items, invalidateContext });
    await invoke('revokeItemDisclosure', grant.id);
    expect(modelMayReadItem(db, item.id)).toBe(false);
    expect(invalidateContext).toHaveBeenCalledOnce();
  });

  it('CONTROL legacy text-only evaluation remains insufficient for approval', () => {
    const store = new SkillCandidateStore(db);
    const skill = store.proposeFromFailure({
      projectId,
      task: 'Synthetic task',
      summary: 'failure',
    });
    store.evaluate(skill.id, { evalBefore: 'failed', evalAfter: 'passed', benefit: 'claimed' });
    expect(() => store.approve(skill.id, { version: store.get(skill.id).version })).toThrow();
  });
});
