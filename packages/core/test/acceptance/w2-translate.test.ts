/**
 * W2 验收（核心，规格 docs/委派/W2-研究内容显示中文.md）
 *
 * 条件 1：英文发现检查后写入 title_zh、summary_zh；再检查一次不重复翻译
 *         （模型替身调用次数不增加）。
 * 条件 2：中文为主的发现不发给模型（替身调用 0 次），两个字段为空。
 * 条件 3：发给模型的文字里只有发现的标题和摘录——主题内部问题里的合成标记、
 *         要求的文字都不在替身截下的请求里。
 * 条件 4：模型出错时发现照常入库、字段为空；下一次检查再试并成功写入。
 * 条件 5：模型返回不在这一批的 id 忽略；超长文字截断（title_zh ≤ 40、summary_zh ≤ 120）。
 * 条件 6：一批最多 10 条——15 条英文发现分两次调用。
 * 条件 7：checkNow 返回的英文候选带 titleZh / snippetZh；中文候选不发模型；
 *         翻译失败时两项为空、候选照常返回。
 *
 * 中文为主 = 去掉空白后中文字符（一-鿿）占比 ≥ 30%，isMostlyChinese 一处判断。
 * 模型用替身：截下每次 chatStructured 的 system 与 user，按请求里出现的发现 id 回中文。
 *
 * 整合方复审时补（2026-09-26）：
 * - 契约 4 也不许带「出门说法」：原稿的出门说法与发现标题只差一个大小写，查不出来；改成
 *   独立的合成标记（w2publicmarker）并断言不外发。
 * - 契约 2「旧的英文发现在下一次检查时补上」：原稿只测了本次检查新入库的发现，只翻新发现的
 *   实现也能过，用户库里已有的英文发现就永远不会翻。补一条：检查前就在库里的英文发现，
 *   检查后也有中文。
 * - 界面测试都是把中文字段直接喂给页面；核心层取数据时不带中文，界面测试照样全过。补一条：
 *   研究页用的 listFindings、总览三块（对上要求的、最近的、标了值得行动的）都带中文。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ResearchChecker,
  ResearchStore,
  buildPersonalOverview,
  isMostlyChinese,
  migrate,
  openDatabase,
  translateFindings,
  type CoreDatabase,
  type FetchDeps,
  type ModelProvider,
} from '../../src/index.js';

const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 截下每次结构化请求的模型替身。reply 抛错就模拟模型出错。 */
function translator(reply: (user: string) => unknown): {
  provider: ModelProvider;
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    provider: {
      modelName: 'w2-stub',
      chatText: async () => '',
      chatStructured: async <T>(input: { system: string; user: string; schema: z.ZodType<T> }) => {
        calls.push({ system: input.system, user: input.user });
        return input.schema.parse(reply(input.user));
      },
    },
  };
}

/** 返回请求里出现的那些发现的中文（title_zh 40 字内、summary_zh 120 字内）。 */
function echoReply(user: string): {
  items: Array<{ id: string; title_zh: string; summary_zh: string }>;
} {
  const ids = user.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  return {
    items: ids.map((id) => ({
      id,
      title_zh: `中文标题 ${id.slice(0, 4)}`,
      summary_zh: `中文摘要 ${id.slice(0, 4)}`,
    })),
  };
}

function freshDb(): CoreDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-w2-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  return db;
}

interface Seeded {
  db: CoreDatabase;
  store: ResearchStore;
  topicId: string;
  sourceId: string;
}

/** 一个主题（内部问题带合成标记）+ 一个批准来源 + 一条要求。 */
function seed(): Seeded {
  const database = freshDb();
  const store = new ResearchStore(database);
  const topic = store.createTopic({
    question: '合成标记-内部问题-不许外发',
    publicDescription: 'w2publicmarker runtime',
    sources: [{ url: 'https://example.com/w2', kind: 'page' }],
  });
  database
    .prepare(
      `INSERT INTO research_requirements (id, topic_id, text, sort_order, created_at)
       VALUES (?, ?, '合成标记-要求文字-不许外发', 1, ?)`,
    )
    .run('11111111-1111-4111-8111-111111111111', topic.id, new Date().toISOString());
  const sourceId = (
    database.prepare('SELECT id FROM research_sources WHERE topic_id = ?').get(topic.id) as {
      id: string;
    }
  ).id;
  return { db: database, store, topicId: topic.id, sourceId };
}

function addFinding(s: Seeded, title: string, excerpt: string, n: number): string {
  const finding = s.store.insertFinding({
    topicId: s.topicId,
    sourceId: s.sourceId,
    title,
    url: `https://example.com/w2/${n}`,
    excerpt,
    fingerprint: `fp-${n}-${title.slice(0, 12)}`,
    claimedPublishedAt: null,
    fetchedAt: new Date().toISOString(),
    relatedGoalId: null,
    relatedProjectId: null,
  });
  if (!finding) throw new Error('发现没入库');
  return finding.id;
}

function zh(
  database: CoreDatabase,
  id: string,
): { title_zh: string | null; summary_zh: string | null } {
  return database
    .prepare('SELECT title_zh, summary_zh FROM research_findings WHERE id = ?')
    .get(id) as { title_zh: string | null; summary_zh: string | null };
}

it('中文为主：去掉空白后中文字符占比达到 30%', () => {
  expect(isMostlyChinese('Local model runtime reaches new speed')).toBe(false);
  expect(isMostlyChinese('本地模型的新进展')).toBe(true);
  // 空白不算：中文占比按去掉空白后的长度算
  expect(isMostlyChinese('ab 中文')).toBe(true);
  expect(isMostlyChinese('')).toBe(false);
});

it('条件 1：英文发现写入中文，再跑一次不重复翻译', async () => {
  const s = seed();
  const id = addFinding(
    s,
    'Local model runtime reaches new speed',
    'A runtime for local models.',
    1,
  );
  const stub = translator(echoReply);
  await translateFindings(s.db, stub.provider, s.topicId);
  const row = zh(s.db, id);
  expect(row.title_zh).toBe(`中文标题 ${id.slice(0, 4)}`);
  expect(row.summary_zh).toBe(`中文摘要 ${id.slice(0, 4)}`);
  await translateFindings(s.db, stub.provider, s.topicId);
  expect(stub.calls).toHaveLength(1);
});

it('条件 2：中文为主的发现不发给模型，字段保持为空', async () => {
  const s = seed();
  const id = addFinding(s, '本地模型的新进展', '这篇讲的是本地模型怎么跑起来。', 1);
  const stub = translator(echoReply);
  await translateFindings(s.db, stub.provider, s.topicId);
  expect(stub.calls).toHaveLength(0);
  expect(zh(s.db, id)).toEqual({ title_zh: null, summary_zh: null });
});

it('条件 3：发给模型的只有标题和摘录，没有内部问题和要求', async () => {
  const s = seed();
  addFinding(s, 'Local model runtime reaches new speed', 'A runtime for local models.', 1);
  const stub = translator(echoReply);
  await translateFindings(s.db, stub.provider, s.topicId);
  expect(stub.calls.length).toBeGreaterThan(0);
  for (const call of stub.calls) {
    const sent = `${call.system}\n${call.user}`;
    expect(sent).not.toContain('合成标记-内部问题-不许外发');
    expect(sent).not.toContain('合成标记-要求文字-不许外发');
    expect(sent).not.toContain('w2publicmarker');
    expect(sent).toContain('Local model runtime reaches new speed');
    expect(sent).toContain('A runtime for local models.');
  }
});

it('条件 4：模型出错时什么都不写，下次再试成功', async () => {
  const s = seed();
  const id = addFinding(
    s,
    'Local model runtime reaches new speed',
    'A runtime for local models.',
    1,
  );
  const failing = translator(() => {
    throw new Error('模型暂时出错');
  });
  await expect(translateFindings(s.db, failing.provider, s.topicId)).resolves.toBeUndefined();
  expect(zh(s.db, id)).toEqual({ title_zh: null, summary_zh: null });
  const stub = translator(echoReply);
  await translateFindings(s.db, stub.provider, s.topicId);
  expect(zh(s.db, id).title_zh).toBe(`中文标题 ${id.slice(0, 4)}`);
});

it('条件 4：没配模型时什么都不写，发现照常留着', async () => {
  const s = seed();
  const id = addFinding(
    s,
    'Local model runtime reaches new speed',
    'A runtime for local models.',
    1,
  );
  await expect(translateFindings(s.db, null, s.topicId)).resolves.toBeUndefined();
  expect(zh(s.db, id)).toEqual({ title_zh: null, summary_zh: null });
  expect(
    s.db.prepare('SELECT COUNT(*) AS c FROM research_findings').get() as { c: number },
  ).toEqual({ c: 1 });
});

it('条件 5：不在这一批的 id 忽略，超长截断到上限', async () => {
  const s = seed();
  const id = addFinding(
    s,
    'Local model runtime reaches new speed',
    'A runtime for local models.',
    1,
  );
  const longTitle = '标'.repeat(80);
  const longSummary = '摘'.repeat(300);
  const stub = translator(() => ({
    items: [
      { id: '99999999-9999-4999-8999-999999999999', title_zh: '不该写入', summary_zh: '不该写入' },
      { id, title_zh: longTitle, summary_zh: longSummary },
    ],
  }));
  await translateFindings(s.db, stub.provider, s.topicId);
  const row = zh(s.db, id);
  expect(row.title_zh).toHaveLength(40);
  expect(row.summary_zh).toHaveLength(120);
  const stray = s.db
    .prepare("SELECT COUNT(*) AS c FROM research_findings WHERE title_zh = '不该写入'")
    .get() as { c: number };
  expect(stray.c).toBe(0);
});

it('条件 5：title_zh 为空的那条不写', async () => {
  const s = seed();
  const id = addFinding(
    s,
    'Local model runtime reaches new speed',
    'A runtime for local models.',
    1,
  );
  const stub = translator(() => ({ items: [{ id, title_zh: '   ', summary_zh: '有摘要也不写' }] }));
  await translateFindings(s.db, stub.provider, s.topicId);
  expect(zh(s.db, id)).toEqual({ title_zh: null, summary_zh: null });
});

it('条件 6：15 条英文发现分两批，每批最多 10 条', async () => {
  const s = seed();
  for (let n = 0; n < 15; n++) {
    addFinding(
      s,
      `Local model runtime update number ${n}`,
      `Excerpt number ${n} about runtimes.`,
      n,
    );
  }
  const sizes: number[] = [];
  const stub = translator((user) => {
    const ids = user.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    sizes.push(ids.length);
    return echoReply(user);
  });
  await translateFindings(s.db, stub.provider, s.topicId);
  expect(sizes).toEqual([10, 5]);
  const filled = s.db
    .prepare('SELECT COUNT(*) AS c FROM research_findings WHERE title_zh IS NOT NULL')
    .get() as { c: number };
  expect(filled.c).toBe(15);
});

/** 一个没有来源的主题 + 搜索替身，手动检查会带回候选。 */
function checkerWith(
  provider: ModelProvider | null,
  hits: Array<{ title: string; snippet: string }>,
) {
  const database = freshDb();
  const checker = new ResearchChecker(
    database,
    undefined,
    {},
    () => ({
      search: async () => ({
        hits: hits.map((h, i) => ({
          url: `https://example.com/cand/${i}`,
          title: h.title,
          snippet: h.snippet,
        })),
      }),
    }),
    provider,
  );
  const topic = checker.createTopic({
    question: '合成标记-内部问题-不许外发',
    publicDescription: 'w2publicmarker runtime',
    sources: [],
  });
  return { db: database, checker, topicId: topic.id };
}

it('条件 7：英文候选带回中文，中文候选不发模型', async () => {
  const stub = translator(echoReply);
  const h = checkerWith(stub.provider, [
    { title: 'Local model runtime reaches new speed', snippet: 'A runtime for local models.' },
    { title: '本地模型的新进展', snippet: '这篇讲的是本地模型怎么跑起来。' },
  ]);
  const result = await h.checker.checkNow(h.topicId);
  expect(result.searchCandidates).toHaveLength(2);
  const english = result.searchCandidates.find((c) => c.title.startsWith('Local'))!;
  const chinese = result.searchCandidates.find((c) => c.title.startsWith('本地'))!;
  expect(english.titleZh?.length).toBeGreaterThan(0);
  expect(english.snippetZh?.length).toBeGreaterThan(0);
  expect(chinese.titleZh ?? null).toBeNull();
  expect(chinese.snippetZh ?? null).toBeNull();
  // 中文候选的标题不该出现在任何一次请求里
  for (const call of stub.calls) {
    expect(`${call.system}\n${call.user}`).not.toContain('本地模型的新进展');
    expect(`${call.system}\n${call.user}`).not.toContain('合成标记-内部问题-不许外发');
    expect(`${call.system}\n${call.user}`).not.toContain('w2publicmarker');
  }
});

it('条件 7：候选翻译失败时两项为空，候选照常返回', async () => {
  const failing = translator(() => {
    throw new Error('模型暂时出错');
  });
  const h = checkerWith(failing.provider, [
    { title: 'Local model runtime reaches new speed', snippet: 'A runtime for local models.' },
  ]);
  const result = await h.checker.checkNow(h.topicId);
  expect(result.searchCandidates).toHaveLength(1);
  expect(result.searchCandidates[0]!.titleZh ?? null).toBeNull();
  expect(result.searchCandidates[0]!.snippetZh ?? null).toBeNull();
  expect(result.searchError).toBeNull();
  // 失败前确实发出去了：没尝试翻译的实现不算「失败时为空」
  expect(failing.calls.length).toBeGreaterThan(0);
});

/**
 * 抓取替身：域名解析和抓取都不走真网络。字段名照 FetchDeps（lookup、fetch）——
 * 整合方 2026-09-26 修：原稿写成 fetchImpl，替身没接上，测试真的去请求了 example.com。
 */
function fakeWeb(pages: Record<string, string>): FetchDeps {
  return {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (url) => {
      const body = pages[url.split('?')[0]!];
      if (body === undefined) return new Response('missing', { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}

it('检查成功后翻译英文发现（发给模型的没有内部问题）', async () => {
  const database = freshDb();
  const stub = translator(echoReply);
  const checker = new ResearchChecker(
    database,
    undefined,
    fakeWeb({
      'https://example.com/w2':
        '<html><head><title>Local model runtime reaches new speed</title></head><body><p>A runtime for local models with a long enough excerpt.</p></body></html>',
    }),
    undefined,
    stub.provider,
  );
  const topic = checker.createTopic({
    question: '合成标记-内部问题-不许外发',
    publicDescription: '',
    sources: [{ url: 'https://example.com/w2', kind: 'page' }],
  });
  const result = await checker.checkNow(topic.id);
  expect(result.run.status).toBe('succeeded');
  expect(result.findings.length).toBeGreaterThan(0);
  const row = database
    .prepare('SELECT title_zh FROM research_findings WHERE topic_id = ?')
    .get(topic.id) as { title_zh: string | null };
  expect(row.title_zh?.length).toBeGreaterThan(0);
  for (const call of stub.calls) {
    expect(`${call.system}\n${call.user}`).not.toContain('合成标记-内部问题-不许外发');
  }
});

it('整合方补：检查前就在库里、还没翻的英文发现，这次检查一起补上', async () => {
  const database = freshDb();
  const stub = translator(echoReply);
  const checker = new ResearchChecker(
    database,
    undefined,
    fakeWeb({
      'https://example.com/w2':
        '<html><head><title>Another runtime note</title></head><body><p>Some text long enough to count as a page excerpt.</p></body></html>',
    }),
    undefined,
    stub.provider,
  );
  const topic = checker.createTopic({
    question: '合成标记-内部问题-不许外发',
    publicDescription: '',
    sources: [{ url: 'https://example.com/w2', kind: 'page' }],
  });
  const store = new ResearchStore(database);
  const sourceId = (
    database.prepare('SELECT id FROM research_sources WHERE topic_id = ?').get(topic.id) as {
      id: string;
    }
  ).id;
  // 迁移前入库、一直没翻的英文发现
  const old = store.insertFinding({
    topicId: topic.id,
    sourceId,
    title: 'Older finding stored before translation existed',
    url: 'https://example.com/w2/old',
    excerpt: 'An older English excerpt.',
    fingerprint: 'fp-old',
    claimedPublishedAt: null,
    fetchedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    relatedGoalId: null,
    relatedProjectId: null,
  })!;
  const result = await checker.checkNow(topic.id);
  expect(result.run.status).toBe('succeeded');
  expect(zh(database, old.id).title_zh).toBe(`中文标题 ${old.id.slice(0, 4)}`);
});

it('整合方补：研究页和总览拿到的数据里带着中文', async () => {
  const s = seed();
  s.store.setEnabled(s.topicId, true);
  const id = addFinding(
    s,
    'Local model runtime reaches new speed',
    'A runtime for local models.',
    1,
  );
  await translateFindings(s.db, translator(echoReply).provider, s.topicId);
  const title = `中文标题 ${id.slice(0, 4)}`;
  // 研究页：researchSnapshot 用的 listFindings
  const listed = s.store.listFindings(s.topicId).find((f) => f.id === id) as unknown as {
    title_zh: string | null;
    summary_zh: string | null;
  };
  expect(listed.title_zh).toBe(title);
  expect(listed.summary_zh).toBe(`中文摘要 ${id.slice(0, 4)}`);
  // 总览：对上全部要求、标了值得行动
  s.db
    .prepare(
      `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at)
       VALUES (?, '11111111-1111-4111-8111-111111111111', 'meets', '对上了', ?)`,
    )
    .run(id, new Date().toISOString());
  s.db.prepare('UPDATE research_findings SET action_worthy = 1 WHERE id = ?').run(id);
  const overview = buildPersonalOverview(s.db) as unknown as {
    matchedFindings: Array<{ id: string; titleZh?: string | null }>;
    recentFindings: Array<{ id: string; titleZh?: string | null }>;
    researchFollowUps: Array<{ id: string; titleZh?: string | null }>;
  };
  expect(overview.matchedFindings.find((f) => f.id === id)?.titleZh).toBe(title);
  expect(overview.recentFindings.find((f) => f.id === id)?.titleZh).toBe(title);
  expect(overview.researchFollowUps.find((f) => f.id === id)?.titleZh).toBe(title);
});
