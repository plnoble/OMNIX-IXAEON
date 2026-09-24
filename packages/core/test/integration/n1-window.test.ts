/**
 * N1 并入时整合方补的时间窗口（锁定验收之外，2026-09-24）：
 * - 判定只判最近 7 天的发现：给攒了很多发现的方向新加一条要求，不能一口气调几百次模型；
 * - 概览里「符合你要求的」：没看过的一直显示（一周没打开也不能悄悄消失），看过的只留 7 天。
 * 全是合成数据。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  FakeProvider,
  MATCH_WINDOW_DAYS,
  ResearchStore,
  addRequirement,
  judgeFindings,
  listMatchedFindings,
  markMatchedFindingsSeen,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-n1-window-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function seed() {
  const store = new ResearchStore(db);
  const topic = store.createTopic({
    question: '合成方向：大内存手机',
    public_description: '合成公开描述',
    sources: [{ url: 'https://example.com/n1w', kind: 'page' }],
  });
  const source = store.listSources(topic.id)[0]!;
  const finding = (label: string, fetchedAt: string) =>
    store.insertFinding({
      topicId: topic.id,
      sourceId: source.id,
      title: `合成发现 ${label}`,
      url: `https://example.com/${label}`,
      excerpt: `合成摘录 ${label}：24GB 内存`,
      fingerprint: `fp-${label}`,
      claimedPublishedAt: null,
      fetchedAt,
      relatedGoalId: null,
      relatedProjectId: null,
    })!;
  return { topic, finding };
}

/** 判定结果直接写表（绕过窗口），用来测展示那一头。 */
function markMeets(findingId: string, requirementId: string) {
  db.prepare(
    `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at)
     VALUES (?, ?, 'meets', '合成理由', ?)`,
  ).run(findingId, requirementId, new Date().toISOString());
}

it(`判定只判最近 ${MATCH_WINDOW_DAYS} 天的发现`, async () => {
  const { topic, finding } = seed();
  finding('fresh', daysAgo(1));
  finding('stale', daysAgo(MATCH_WINDOW_DAYS + 3));
  addRequirement(db, { topicId: topic.id, text: '内存 24GB 以上' });
  const provider = new FakeProvider('n1-window');
  provider.enqueueStructured({ verdict: 'meets', reason: '写了 24GB' });
  const r = await judgeFindings(db, provider, topic.id);
  expect(r).toEqual({ judged: 1, failed: 0 });
  expect(provider.structuredCalls).toHaveLength(1);
  expect(provider.structuredCalls[0]!.user).toContain('合成发现 fresh');
});

it('没看过的对上发现一直显示；看过的只留最近几天', () => {
  const { topic, finding } = seed();
  const req = addRequirement(db, { topicId: topic.id, text: '内存 24GB 以上' });
  const old = finding('old', daysAgo(MATCH_WINDOW_DAYS + 3));
  const recent = finding('recent', daysAgo(1));
  markMeets(old.id, req.id);
  markMeets(recent.id, req.id);
  const since = daysAgo(MATCH_WINDOW_DAYS);

  // 从没看过：旧的也在
  expect(
    listMatchedFindings(db, { since })
      .map((f) => f.title)
      .sort(),
  ).toEqual(['合成发现 old', '合成发现 recent'].sort());

  // 看过之后：超出窗口的旧发现不再显示，窗口内的照常（标成已看）
  markMatchedFindingsSeen(db);
  const after = listMatchedFindings(db, { since });
  expect(after.map((f) => f.title)).toEqual(['合成发现 recent']);
  expect(after[0]!.isNew).toBe(false);
});
