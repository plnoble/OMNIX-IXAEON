/**
 * N2 验收（核心，规格 docs/委派/N2-研究页显示判定和理由.md）
 *
 * 条件 1：三条要求、一条发现判了两条（一条对上、一条看不出来）、第三条没判：
 *         listFindingJudgments 按要求顺序返回三项，第三项 verdict、reason 为 null。
 * 条件 2：没有要求的主题返回空。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  ResearchStore,
  addRequirement,
  listFindingJudgments,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): { db: CoreDatabase; store: ResearchStore } {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-n2-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  return { db, store: new ResearchStore(db) };
}

it('条件 1：按要求顺序返回，没判的那条 verdict 与 reason 为 null', () => {
  const s = fresh();
  const topic = s.store.createTopic({
    question: '合成方向',
    publicDescription: '',
    sources: [{ url: 'https://example.com/n2', kind: 'page' }],
  });
  const source = s.store.listSources(topic.id)[0]!;
  const finding = s.store.insertFinding({
    topicId: topic.id,
    sourceId: source.id,
    title: '合成发现',
    url: 'https://example.com/n2/f',
    excerpt: '摘录',
    fingerprint: 'fp',
    claimedPublishedAt: null,
    fetchedAt: new Date().toISOString(),
    relatedGoalId: null,
    relatedProjectId: null,
  })!;
  const r1 = addRequirement(s.db, { topicId: topic.id, text: '要求一' });
  const r2 = addRequirement(s.db, { topicId: topic.id, text: '要求二' });
  const r3 = addRequirement(s.db, { topicId: topic.id, text: '要求三' });
  const now = new Date().toISOString();
  s.db
    .prepare(
      `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at)
       VALUES (?, ?, 'meets', '对上了', ?), (?, ?, 'unknown', '看不出来', ?)`,
    )
    .run(finding.id, r1.id, now, finding.id, r2.id, now);
  const groups = listFindingJudgments(s.db, topic.id);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.findingId).toBe(finding.id);
  expect(groups[0]!.judgments.map((j) => j.requirementId)).toEqual([r1.id, r2.id, r3.id]);
  expect(groups[0]!.judgments[0]).toMatchObject({
    text: '要求一',
    verdict: 'meets',
    reason: '对上了',
  });
  expect(groups[0]!.judgments[1]).toMatchObject({ verdict: 'unknown', reason: '看不出来' });
  expect(groups[0]!.judgments[2]).toMatchObject({ text: '要求三', verdict: null, reason: null });
});

it('条件 2：没有要求的主题返回空（主题里有发现也一样）', () => {
  const s = fresh();
  const topic = s.store.createTopic({
    question: '没有要求',
    publicDescription: '',
    sources: [{ url: 'https://example.com/n2', kind: 'page' }],
  });
  s.store.insertFinding({
    topicId: topic.id,
    sourceId: s.store.listSources(topic.id)[0]!.id,
    title: '没有要求的发现',
    url: 'https://example.com/n2/f',
    excerpt: '摘录',
    fingerprint: 'fp-none',
    claimedPublishedAt: null,
    fetchedAt: new Date().toISOString(),
    relatedGoalId: null,
    relatedProjectId: null,
  });
  expect(listFindingJudgments(s.db, topic.id)).toEqual([]);
});
