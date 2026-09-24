/**
 * G07 验收（核心，规格 docs/委派/G07-搜索预算按天恢复.md）
 *
 * 条件 1：按天的主题四个不同日期各检查一次，每天都发起搜索 [true, true, true, true]。
 * 条件 2：按天的主题同一天第 4 次检查不搜（额度 3 用完）。
 * 条件 3：累计的主题额度用完后换一天也不恢复。
 *
 * 时钟可控（ResearchChecker 的 Clock）；搜索用替身，断言每轮的 searchUsed。
 * 「今天」按本地时区：日期用本地中午构造。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  ResearchChecker,
  ResearchStore,
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

function localNoon(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0);
}

function setup(daily: number | null, cap: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-g07-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const store = new ResearchStore(db);
  const topic = store.createTopic({
    question: '本地模型的新进展',
    publicDescription: 'local model runtime',
    sources: [],
    paid_budget_mode: 'request_cap',
    request_cap: cap,
  });
  store.setEnabled(topic.id, true);
  const day = daily === null ? null : '2026-09-20';
  db.prepare(
    'UPDATE research_topics SET daily_request_cap = ?, request_budget_day = ? WHERE id = ?',
  ).run(daily, day, topic.id);
  const clock = { current: localNoon(2026, 9, 20) };
  const searches: string[] = [];
  const checker = new ResearchChecker(db, { now: () => clock.current }, {}, () => ({
    search: async () => {
      searches.push('searched');
      return { hits: [{ url: 'https://example.com/g07', title: '合成结果', snippet: '摘要' }] };
    },
  }));
  return {
    db,
    topicId: topic.id,
    clock,
    searches,
    /** 拨到到期再跑一轮，返回本轮是否真的搜索了。 */
    async tick(): Promise<boolean> {
      const before = searches.length;
      db!
        .prepare('UPDATE research_topics SET next_check_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', topic.id);
      const result = await checker.tick();
      expect(result).not.toBeNull();
      return searches.length > before;
    },
  };
}

it('条件 1：按天的主题四个不同日期每天都搜索', async () => {
  const h = setup(3, 3);
  const searched: boolean[] = [];
  for (const day of [20, 21, 22, 23]) {
    h.clock.current = localNoon(2026, 9, day);
    searched.push(await h.tick());
  }
  expect(searched).toEqual([true, true, true, true]);
});

it('条件 2：按天的主题同一天第 4 次不搜', async () => {
  const h = setup(3, 3);
  const searched: boolean[] = [];
  for (let i = 0; i < 4; i++) searched.push(await h.tick());
  expect(searched).toEqual([true, true, true, false]);
});

it('条件 3：累计的主题额度用完后换一天也不恢复', async () => {
  const h = setup(null, 1);
  const first = await h.tick();
  h.clock.current = localNoon(2026, 9, 21);
  const second = await h.tick();
  expect([first, second]).toEqual([true, false]);
});
