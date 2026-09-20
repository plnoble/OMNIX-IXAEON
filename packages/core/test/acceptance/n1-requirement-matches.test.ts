/**
 * N1 验收（核心，v2 规格：执行方按规格条件写成测试；本单 B 档先只交测试）：
 * docs/委派/N1-要求清单只在对上时提醒.md
 *
 * 条件 1：一个方向两条要求、三条发现：假模型把发现 A 判成两条都 meets、B 判成一 meets
 *          一 fails、C 判成一 meets 一 unknown → listMatchedFindings 只返回 A。
 * 条件 2：没有要求的方向：judgeFindings 不调用模型、不写库；它的发现不会出现在
 *          「符合你要求的」里。
 * 条件 3：判过不重判：再调一次 judgeFindings，模型调用次数为 0；新加一条要求后再调，
 *          只对这条新要求判（调用次数 = 发现数）。
 * 条件 4：发给模型的内容只含标题、摘录、URL、要求原话（用假模型截请求核对），
 *          不含个人记忆里的任何一条。
 * 条件 5：模型不通：judgeFindings 返回 failed > 0、不抛错；这次检查照常算成功，
 *          发现照常入库。
 * 条件 6：isNew：从没看过时全是新；markMatchedFindingsSeen 之后旧的不是新；
 *          之后新来的对上发现又是新。
 * 条件 8（核心这一头）：能加、能删要求；加超过 200 字的报错不写库。
 *
 * 新符号尚未实现：用运行时取，不静态导入，免得 typecheck 把先交的测试挡掉。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  FakeProvider,
  ResearchChecker,
  ResearchStore,
  migrate,
  openDatabase,
  type CoreDatabase,
  type ModelProvider,
} from '../../src/index.js';
import * as core from '../../src/index.js';

type Requirement = { id: string; topic_id: string; text: string; sort_order: number };
type MatchedFinding = {
  id: string;
  title: string;
  url: string;
  topicQuestion: string;
  fetchedAt: string;
  isNew: boolean;
  matches: Array<{ requirementId: string; text: string; reason: string }>;
};

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-n1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fn<T extends (...args: never[]) => unknown>(name: string): T {
  const value = (core as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`尚未实现 ${name}`);
  return value as T;
}

const listRequirements = (topicId: string) =>
  fn<(db: CoreDatabase, topicId: string) => Requirement[]>('listRequirements')(db, topicId);
const addRequirement = (input: { topicId: string; text: string }) =>
  fn<(db: CoreDatabase, input: { topicId: string; text: string }) => Requirement>('addRequirement')(
    db,
    input,
  );
const removeRequirement = (id: string) =>
  fn<(db: CoreDatabase, id: string) => void>('removeRequirement')(db, id);
const judgeFindings = (provider: ModelProvider | null, topicId: string) =>
  fn<
    (
      db: CoreDatabase,
      provider: ModelProvider | null,
      topicId: string,
    ) => Promise<{ judged: number; failed: number }>
  >('judgeFindings')(db, provider, topicId);
const listMatchedFindings = (opts?: { since?: string; seenAt?: string | null }) =>
  fn<(db: CoreDatabase, opts?: { since?: string; seenAt?: string | null }) => MatchedFinding[]>(
    'listMatchedFindings',
  )(db, opts);
const markMatchedFindingsSeen = (at?: string) =>
  fn<(db: CoreDatabase, at?: string) => void>('markMatchedFindingsSeen')(db, at);

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function seedTopic(question = 'N1 合成方向甲') {
  const store = new ResearchStore(db);
  const topic = store.createTopic({
    question,
    public_description: '合成公开描述',
    sources: [{ url: 'https://example.com/n1', kind: 'page' }],
  });
  store.setEnabled(topic.id, true);
  return { store, topic, source: store.listSources(topic.id)[0]! };
}

function insertFinding(
  store: ResearchStore,
  topicId: string,
  sourceId: string,
  opts: { idLabel: string; title: string; excerpt: string; fetchedAt?: string; url?: string },
) {
  return store.insertFinding({
    topicId,
    sourceId,
    title: opts.title,
    url: opts.url ?? `https://example.com/${opts.idLabel}`,
    excerpt: opts.excerpt,
    fingerprint: `fp-${opts.idLabel}`,
    claimedPublishedAt: null,
    fetchedAt: opts.fetchedAt ?? hoursAgo(1),
    relatedGoalId: null,
    relatedProjectId: null,
  })!;
}

function enqueueVerdict(
  provider: FakeProvider,
  verdict: 'meets' | 'fails' | 'unknown',
  reason: string,
) {
  provider.enqueueStructured({ verdict, reason });
}

it('条件 8：能加、能删要求；超过 200 字报错不写库', () => {
  const { topic } = seedTopic();
  const first = addRequirement({ topicId: topic.id, text: '内存 24GB 以上' });
  const second = addRequirement({ topicId: topic.id, text: '能跑本地大模型' });
  expect(listRequirements(topic.id).map((r) => r.text)).toEqual([
    '内存 24GB 以上',
    '能跑本地大模型',
  ]);
  expect(second.sort_order).toBeGreaterThan(first.sort_order);

  expect(() => addRequirement({ topicId: topic.id, text: '字'.repeat(201) })).toThrow();
  expect(listRequirements(topic.id)).toHaveLength(2);

  removeRequirement(first.id);
  expect(listRequirements(topic.id).map((r) => r.text)).toEqual(['能跑本地大模型']);
});

it('条件 1：只有每条要求都 meets 的发现出现在对上列表里', async () => {
  const { store, topic, source } = seedTopic();
  addRequirement({ topicId: topic.id, text: '内存 24GB 以上' });
  addRequirement({ topicId: topic.id, text: '能跑本地大模型' });
  const findingA = insertFinding(store, topic.id, source.id, {
    idLabel: 'a',
    title: '发现甲：24GB 可跑本地模型',
    excerpt: '这台手机 24GB 内存，能装 Qwen。',
    fetchedAt: hoursAgo(1),
  });
  const findingB = insertFinding(store, topic.id, source.id, {
    idLabel: 'b',
    title: '发现乙：内存够但跑不动',
    excerpt: '24GB，但不能跑本地大模型。',
    fetchedAt: hoursAgo(2),
  });
  const findingC = insertFinding(store, topic.id, source.id, {
    idLabel: 'c',
    title: '发现丙：内存够看不出能不能跑',
    excerpt: '24GB，说明书没写本地模型。',
    fetchedAt: hoursAgo(3),
  });

  const provider = new FakeProvider('n1-judge');
  enqueueVerdict(provider, 'meets', '写了 24GB 内存');
  enqueueVerdict(provider, 'meets', '写了能跑本地模型');
  enqueueVerdict(provider, 'meets', '写了 24GB 内存');
  enqueueVerdict(provider, 'fails', '明确写跑不动本地模型');
  enqueueVerdict(provider, 'meets', '写了 24GB 内存');
  enqueueVerdict(provider, 'unknown', '没写能不能跑本地模型');

  const result = await judgeFindings(provider, topic.id);
  expect(result.judged).toBe(6);
  expect(result.failed).toBe(0);

  const matched = listMatchedFindings();
  expect(matched.map((f) => f.id)).toEqual([findingA.id]);
  expect(matched[0]?.topicQuestion).toBe('N1 合成方向甲');
  expect(matched[0]?.matches).toHaveLength(2);
  expect(matched[0]?.matches.map((m) => m.text).sort()).toEqual(
    ['内存 24GB 以上', '能跑本地大模型'].sort(),
  );
  expect(matched[0]?.matches.every((m) => m.reason.length > 0)).toBe(true);
  expect(matched.some((f) => f.id === findingB.id)).toBe(false);
  expect(matched.some((f) => f.id === findingC.id)).toBe(false);
});

it('条件 2：没有要求的方向不调模型、不写库、发现不进对上列表', async () => {
  const withReq = seedTopic('N1 合成有要求');
  const without = seedTopic('N1 合成没要求');
  addRequirement({ topicId: withReq.topic.id, text: '内存 24GB 以上' });
  insertFinding(withReq.store, withReq.topic.id, withReq.source.id, {
    idLabel: 'need',
    title: '有要求的发现',
    excerpt: '24GB 内存。',
  });
  insertFinding(without.store, without.topic.id, without.source.id, {
    idLabel: 'none',
    title: '没要求的发现',
    excerpt: '随便一条发现。',
  });

  const provider = new FakeProvider('n1-none');
  enqueueVerdict(provider, 'meets', '对上内存');
  const none = await judgeFindings(provider, without.topic.id);
  expect(none).toEqual({ judged: 0, failed: 0 });
  expect(provider.structuredCalls).toHaveLength(0);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM research_finding_matches').get() as {
    n: number;
  };
  expect(rows.n).toBe(0);

  await judgeFindings(provider, withReq.topic.id);
  const matched = listMatchedFindings();
  expect(matched).toHaveLength(1);
  expect(matched[0]?.title).toBe('有要求的发现');
  expect(matched.some((f) => f.title === '没要求的发现')).toBe(false);
});

it('条件 3：判过不重判；新加要求只判新的这一条', async () => {
  const { store, topic, source } = seedTopic();
  addRequirement({ topicId: topic.id, text: '内存 24GB 以上' });
  insertFinding(store, topic.id, source.id, {
    idLabel: 'one',
    title: '发现一',
    excerpt: '24GB。',
  });
  insertFinding(store, topic.id, source.id, {
    idLabel: 'two',
    title: '发现二',
    excerpt: '32GB。',
  });

  const provider = new FakeProvider('n1-skip');
  enqueueVerdict(provider, 'meets', '对上');
  enqueueVerdict(provider, 'meets', '对上');
  await judgeFindings(provider, topic.id);
  expect(provider.structuredCalls).toHaveLength(2);

  const again = await judgeFindings(provider, topic.id);
  expect(again).toEqual({ judged: 0, failed: 0 });
  expect(provider.structuredCalls).toHaveLength(2);

  addRequirement({ topicId: topic.id, text: '五千以内' });
  enqueueVerdict(provider, 'meets', '价格对上');
  enqueueVerdict(provider, 'meets', '价格对上');
  const afterAdd = await judgeFindings(provider, topic.id);
  expect(afterAdd.judged).toBe(2);
  expect(provider.structuredCalls).toHaveLength(4);
});

it('条件 4：发给模型的只有标题、摘录、URL、要求原话，不含个人记忆', async () => {
  const { store, topic, source } = seedTopic();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
       origin, observed_at, created_at, updated_at, needs_review, confirmation)
     VALUES (?, NULL, 'personal', 'preference', ?, NULL, 'current', 1.0, 'user', ?, ?, ?, 0, 'confirmed')`,
  ).run('mem-secret', '我私下记着要换手机，预算五千，别告诉模型', now, now, now);
  addRequirement({ topicId: topic.id, text: '内存 24GB 以上' });
  insertFinding(store, topic.id, source.id, {
    idLabel: 'mem',
    title: '公开标题：新机 24GB',
    excerpt: '公开摘录：内存 24GB。',
    url: 'https://example.com/public-finding',
  });

  const provider = new FakeProvider('n1-prompt');
  enqueueVerdict(provider, 'meets', '对上');
  await judgeFindings(provider, topic.id);
  expect(provider.structuredCalls).toHaveLength(1);
  const sent = `${provider.structuredCalls[0]!.system}\n${provider.structuredCalls[0]!.user}`;
  expect(sent).toContain('公开标题：新机 24GB');
  expect(sent).toContain('公开摘录：内存 24GB。');
  expect(sent).toContain('https://example.com/public-finding');
  expect(sent).toContain('内存 24GB 以上');
  expect(sent).not.toContain('我私下记着要换手机');
  expect(sent).not.toContain('别告诉模型');
});

it('条件 5：模型不通返回 failed、不抛错；检查仍成功、发现仍入库', async () => {
  const { store, topic, source } = seedTopic();
  addRequirement({ topicId: topic.id, text: '内存 24GB 以上' });
  const finding = insertFinding(store, topic.id, source.id, {
    idLabel: 'fail',
    title: '发现仍要留下',
    excerpt: '24GB。',
  });
  const before = store.listFindings(topic.id).length;

  const empty = new FakeProvider('n1-down');
  const down = await judgeFindings(empty, topic.id);
  expect(down.failed).toBeGreaterThan(0);
  expect(down.judged).toBe(0);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM research_finding_matches').get() as {
    n: number;
  };
  expect(rows.n).toBe(0);
  expect(store.listFindings(topic.id).map((f) => f.id)).toContain(finding.id);

  const checker = new ResearchChecker(
    db,
    { now: () => new Date() },
    {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async () =>
        new Response('<html><title>新机</title><p>24GB 内存能跑本地模型</p></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
    undefined,
    new FakeProvider('n1-check-down'),
  );
  const checked = await checker.checkNow(topic.id);
  expect(checked.run.status).toBe('succeeded');
  expect(store.listFindings(topic.id).length).toBeGreaterThanOrEqual(before);
});

it('条件 6：从没看过全是新；看过之后旧的不是新；后来的对上发现又是新', async () => {
  const { store, topic, source } = seedTopic();
  addRequirement({ topicId: topic.id, text: '内存 24GB 以上' });
  const first = insertFinding(store, topic.id, source.id, {
    idLabel: 'old-match',
    title: '先来的对上',
    excerpt: '24GB。',
    fetchedAt: hoursAgo(3),
  });
  const provider = new FakeProvider('n1-seen');
  enqueueVerdict(provider, 'meets', '对上');
  await judgeFindings(provider, topic.id);
  expect(listMatchedFindings().every((f) => f.isNew)).toBe(true);

  markMatchedFindingsSeen();
  expect(listMatchedFindings().every((f) => !f.isNew)).toBe(true);

  const later = insertFinding(store, topic.id, source.id, {
    idLabel: 'new-match',
    title: '后来的对上',
    excerpt: '32GB。',
    fetchedAt: new Date(Date.now() + 1000).toISOString(),
  });
  enqueueVerdict(provider, 'meets', '也对上');
  await judgeFindings(provider, topic.id);
  const after = listMatchedFindings();
  expect(after.find((f) => f.id === later.id)?.isNew).toBe(true);
  expect(after.find((f) => f.id === first.id)?.isNew).toBe(false);
});
