/**
 * W1b 验收（v2 规格：执行方按规格条件写成测试，条件逐条对应）：
 * docs/委派/W1b-概览页新发现.md
 *
 * 条件 1：合成数据：2 个启用的研究主题 + 1 个没启用的，发现分布在今天、3 天前、
 *          10 天前：只返回启用主题里 7 天内的，按时间倒序，最多 10 条。
 * 条件 2：从没看过：全部 isNew；调了 markFindingsSeen() 之后再查：全部不是新的；
 *          之后新来的一条又是新的。
 * 条件 3：概览页：有发现时显示这一块、新的有标记；点「都看过了」调了 IPC 并刷新；
 *          没有发现时这一块不出现。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  ResearchStore,
  buildPersonalOverview,
  markOverviewFindingsSeen,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-w1b-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function seedTopics() {
  const store = new ResearchStore(db);
  const enabledA = store.createTopic({
    question: 'W1b 合成方向甲',
    public_description: '甲',
    sources: [{ url: 'https://example.com/a', kind: 'page' }],
  });
  const enabledB = store.createTopic({
    question: 'W1b 合成方向乙',
    public_description: '乙',
    sources: [{ url: 'https://example.com/b', kind: 'page' }],
  });
  const disabled = store.createTopic({
    question: 'W1b 合成方向关着',
    public_description: '关',
    sources: [{ url: 'https://example.com/c', kind: 'page' }],
  });
  store.setEnabled(enabledA.id, true);
  store.setEnabled(enabledB.id, true);
  return {
    store,
    enabledA,
    enabledB,
    disabled,
    srcA: store.listSources(enabledA.id)[0]!,
    srcB: store.listSources(enabledB.id)[0]!,
    srcC: store.listSources(disabled.id)[0]!,
  };
}

it('条件 1：只返回启用主题 7 天内的发现，按时间倒序，最多 10 条', () => {
  const { store, enabledA, enabledB, disabled, srcA, srcB, srcC } = seedTopics();
  const today = store.insertFinding({
    topicId: enabledA.id,
    sourceId: srcA.id,
    title: '今天甲',
    url: 'https://example.com/today-a',
    excerpt: '合成今天',
    fingerprint: 'fp-today-a',
    claimedPublishedAt: null,
    fetchedAt: hoursAgo(1),
    relatedGoalId: null,
    relatedProjectId: null,
  })!;
  const threeDays = store.insertFinding({
    topicId: enabledB.id,
    sourceId: srcB.id,
    title: '三天前乙',
    url: 'https://example.com/3d-b',
    excerpt: '合成三天前',
    fingerprint: 'fp-3d-b',
    claimedPublishedAt: null,
    fetchedAt: hoursAgo(72),
    relatedGoalId: null,
    relatedProjectId: null,
  })!;
  store.insertFinding({
    topicId: enabledA.id,
    sourceId: srcA.id,
    title: '十天前甲',
    url: 'https://example.com/10d-a',
    excerpt: '合成十天前',
    fingerprint: 'fp-10d-a',
    claimedPublishedAt: null,
    fetchedAt: hoursAgo(240),
    relatedGoalId: null,
    relatedProjectId: null,
  });
  store.insertFinding({
    topicId: disabled.id,
    sourceId: srcC.id,
    title: '关着的今天',
    url: 'https://example.com/off',
    excerpt: '合成未启用',
    fingerprint: 'fp-off',
    claimedPublishedAt: null,
    fetchedAt: hoursAgo(1),
    relatedGoalId: null,
    relatedProjectId: null,
  });

  const first = buildPersonalOverview(db);
  expect(first.recentFindings.map((f) => f.id)).toEqual([today.id, threeDays.id]);
  expect(first.recentFindings[0]?.topicQuestion).toBe('W1b 合成方向甲');
  expect(first.recentFindings[1]?.topicQuestion).toBe('W1b 合成方向乙');
  expect(first.recentFindings.some((f) => f.title === '十天前甲')).toBe(false);
  expect(first.recentFindings.some((f) => f.title === '关着的今天')).toBe(false);

  const pads = Array.from({ length: 11 }, (_, i) =>
    store.insertFinding({
      topicId: enabledA.id,
      sourceId: srcA.id,
      title: `填充 ${i}`,
      url: `https://example.com/pad-${i}`,
      excerpt: '合成填充',
      fingerprint: `fp-pad-${i}`,
      claimedPublishedAt: null,
      fetchedAt: hoursAgo(2 + i * 0.1),
      relatedGoalId: null,
      relatedProjectId: null,
    }),
  )!;
  const capped = buildPersonalOverview(db);
  expect(capped.recentFindings).toHaveLength(10);
  // 返回的就是最新的 10 条（比对 id）：今天 + 填充 0–8；
  // 填充 9、填充 10（最旧的两条填充）和 72 小时前的三天前乙都被挤掉。
  expect(capped.recentFindings.map((f) => f.id)).toEqual([
    today.id,
    ...pads.slice(0, 9).map((f) => f.id),
  ]);
});

it('条件 2：从没看过全是新的；看过之后旧的不是新的；后来的一条又是新的', () => {
  const { store, enabledA, srcA } = seedTopics();
  store.insertFinding({
    topicId: enabledA.id,
    sourceId: srcA.id,
    title: '先来的',
    url: 'https://example.com/first',
    excerpt: '合成先来',
    fingerprint: 'fp-first',
    claimedPublishedAt: null,
    fetchedAt: hoursAgo(3),
    relatedGoalId: null,
    relatedProjectId: null,
  });
  expect(buildPersonalOverview(db).recentFindings.every((f) => f.isNew)).toBe(true);

  markOverviewFindingsSeen(db);
  expect(buildPersonalOverview(db).recentFindings.every((f) => !f.isNew)).toBe(true);

  const later = store.insertFinding({
    topicId: enabledA.id,
    sourceId: srcA.id,
    title: '后来的',
    url: 'https://example.com/later',
    excerpt: '合成后来',
    fingerprint: 'fp-later',
    claimedPublishedAt: null,
    fetchedAt: new Date(Date.now() + 1000).toISOString(),
    relatedGoalId: null,
    relatedProjectId: null,
  })!;
  const after = buildPersonalOverview(db);
  expect(after.recentFindings.find((f) => f.id === later.id)?.isNew).toBe(true);
  expect(after.recentFindings.filter((f) => f.id !== later.id).every((f) => !f.isNew)).toBe(true);
});
