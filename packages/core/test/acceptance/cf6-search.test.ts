/**
 * CF6 条件 1、2、6：`ConversationStore.search`（core）。
 *
 * 1. 标题命中、正文命中；多词全部出现；不分大小写；% 和 _ 当普通字符；
 *    默认不含已归档、archived:true 只返回已归档；按最近更新排、最多 limit 条。
 * 2. 片段：正文命中时含命中词、前后各不超过约 20 字、太长用「…」；只命中标题时 null。
 * 6. 搜一次之后 audit_events 行数不变（搜索不写审计）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore, migrate, openDatabase, type CoreDatabase } from '@ixaeon/core';

let dir: string;
let db: CoreDatabase;
let store: ConversationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-cf6-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  store = new ConversationStore(db);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const add = (title: string, msgs: string[], updatedAt?: string): string => {
    const c = store.create({ title });
    msgs.forEach((content, i) => {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, role, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`,
      ).run(
        `${c.id}-${i}`,
        c.id,
        i + 1,
        i % 2 === 0 ? 'user' : 'assistant',
        content,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    });
    if (updatedAt)
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updatedAt, c.id);
    return c.id;
  };
  add('周报写法', ['帮我写周报', '好的，分三部分']);
  add('买咖啡豆', ['推荐一款手冲豆子']);
  add('额度问题', ['50% 的额度怎么算', '按天折算']);
  add('下划线', ['a_b 是什么']);
  const archived = add('归档的周报', ['旧周报']);
  store.archive(archived);
  add('最近更新', ['最近一条周报'], '2099-01-01T00:00:00.000Z');
}

describe('CF6 条件 1：搜索', () => {
  it('标题命中、正文命中；多词要全部出现；不分大小写', () => {
    seed();
    expect(store.search({ query: '周报', archived: false }).map((c) => c.title)).toEqual(
      expect.arrayContaining(['周报写法']),
    );
    expect(store.search({ query: '手冲', archived: false })[0]?.title).toBe('买咖啡豆');
    expect(store.search({ query: '周报 三部分', archived: false })[0]?.title).toBe('周报写法');
    expect(store.search({ query: '周报 不存在', archived: false })).toHaveLength(0);
    expect(store.search({ query: '三部分', archived: false })[0]?.title).toBe('周报写法');
    expect(store.search({ query: 'coffee xyz', archived: false })).toHaveLength(0);
  });

  it('% 与 _ 当普通字符', () => {
    seed();
    expect(store.search({ query: '50%', archived: false }).map((c) => c.title)).toEqual([
      '额度问题',
    ]);
    expect(store.search({ query: 'a_b', archived: false }).map((c) => c.title)).toEqual(['下划线']);
  });

  it('默认不含已归档；archived:true 只返回已归档', () => {
    seed();
    const normal = store.search({ query: '周报', archived: false }).map((c) => c.title);
    expect(normal).toContain('周报写法');
    expect(normal).not.toContain('归档的周报');
    expect(store.search({ query: '周报', archived: true }).map((c) => c.title)).toEqual([
      '归档的周报',
    ]);
  });

  it('按最近更新排、最多 limit 条', () => {
    seed();
    const all = store.search({ query: '周报', archived: false });
    expect(all[0]?.title).toBe('最近更新'); // 2099 的 updated_at
    expect(store.search({ query: '周报', archived: false, limit: 1 })).toHaveLength(1);
  });
});

describe('CF6 条件 2：片段', () => {
  it('正文命中时片段含命中词、太长用「…」；只命中标题时 null', () => {
    const c = store.create({ title: '只标题命中' });
    const long = '很长的前文'.repeat(30) + '目标词' + '很长的后文'.repeat(30);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, role, content, status, created_at, updated_at)
       VALUES (?, ?, 1, 'user', ?, 'complete', ?, ?)`,
    ).run('m1', c.id, long, new Date().toISOString(), new Date().toISOString());
    const byBody = store.search({ query: '目标词', archived: false })[0]!;
    expect(byBody.snippet).toBeTruthy();
    expect(byBody.snippet!).toContain('目标词');
    expect(byBody.snippet!.startsWith('…')).toBe(true);
    expect(byBody.snippet!.endsWith('…')).toBe(true);
    expect(byBody.snippet!.length).toBeLessThan(120);
    expect(store.search({ query: '只标题', archived: false })[0]?.snippet).toBeNull();
  });
});

describe('CF6 条件 6：搜索不写审计', () => {
  it('搜一次之后 audit_events 行数不变', () => {
    seed();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    store.search({ query: '周报', archived: false });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
