/**
 * D2 验收：对话与消息存储（三周任务单，迁移 26）。
 *
 * 验收条件（任务单原文）：
 *   - 重启后对话与消息都在
 *   - 多对话并存互不串
 *   - 删对话时消息级联
 *
 * 另含本次设计决定的反例：引擎会话重启后必须清空（不能续一个不存在的会话）、
 * 取消后迟到的流式分片不得写入、未完成消息不得作为下一轮背景。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, migrate, ConversationStore, type CoreDatabase } from '../../src/index.js';

let dir: string;
let dbPath: string;
let db: CoreDatabase;
let store: ConversationStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-conv-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  dbPath = join(dir, `${Math.random().toString(36).slice(2)}.db`);
  db = openDatabase(dbPath);
  migrate(db);
  store = new ConversationStore(db);
});

afterEach(() => {
  // Windows 上未关闭的 SQLite 句柄会让临时目录删不掉（EPERM）。
  // 部分用例自己关过库，这里按 open 状态判断，避免重复关闭。
  if (db.open) db.close();
});

describe('D2 对话持久化', () => {
  it('重启后对话与消息都在，顺序不变', () => {
    const conv = store.create();
    store.appendMessage(conv.id, { role: 'user', content: '正式系统名是什么？' });
    store.appendMessage(conv.id, {
      role: 'assistant',
      content: 'IXAEON（析衍）。',
      engine: 'core-bounded',
      modelName: 'fake-model-v1',
      citations: [
        {
          ref: 'R1',
          segmentId: 'seg-1',
          sourceTitle: '用户纠正',
          role: 'user',
          excerpt: '正式名 IXAEON',
          isUserCorrection: true,
        },
      ],
    });
    db.close();

    // 重开同一个库文件 = 应用重启
    const reopened = openDatabase(dbPath);
    migrate(reopened);
    const after = new ConversationStore(reopened);

    const messages = after.messages(conv.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.seq).toBe(1);
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.seq).toBe(2);
    expect(messages[1]!.citations[0]!.ref).toBe('R1');
    expect(messages[1]!.citations[0]!.isUserCorrection).toBe(true);
    expect(messages[1]!.modelName).toBe('fake-model-v1');
    reopened.close();
  });

  it('首条用户消息自动成为标题；显式改名后不再被覆盖', () => {
    const conv = store.create();
    expect(conv.title).toBe('新对话');

    store.appendMessage(conv.id, { role: 'user', content: '帮我看看两个项目能不能复用\n第二行' });
    expect(store.get(conv.id).title).toBe('帮我看看两个项目能不能复用');

    store.rename(conv.id, '项目复用');
    store.appendMessage(conv.id, { role: 'user', content: '再问一句' });
    expect(store.get(conv.id).title).toBe('项目复用');
  });

  it('多对话并存互不串：消息、最近轮次和列表都按对话隔离', () => {
    const a = store.create({ title: 'A' });
    const b = store.create({ title: 'B' });

    store.appendMessage(a.id, { role: 'user', content: 'A 的问题' });
    store.appendMessage(a.id, { role: 'assistant', content: 'A 的回答' });
    store.appendMessage(b.id, { role: 'user', content: 'B 的问题' });

    expect(store.messages(a.id).map((m) => m.content)).toEqual(['A 的问题', 'A 的回答']);
    expect(store.messages(b.id).map((m) => m.content)).toEqual(['B 的问题']);

    // 新对话的最近轮次必须为空，不能拿到别的对话的内容
    const c = store.create({ title: 'C' });
    expect(store.recentTurns(c.id)).toHaveLength(0);
    expect(store.recentTurns(a.id).map((m) => m.content)).toEqual(['A 的问题', 'A 的回答']);

    const listed = store.list();
    expect(listed.find((x) => x.id === a.id)!.messageCount).toBe(2);
    expect(listed.find((x) => x.id === b.id)!.messageCount).toBe(1);
    expect(listed.find((x) => x.id === a.id)!.lastMessagePreview).toBe('A 的回答');
  });

  it('删对话时消息级联删除，其他对话不受影响', () => {
    const a = store.create();
    const b = store.create();
    store.appendMessage(a.id, { role: 'user', content: '会被删' });
    store.appendMessage(b.id, { role: 'user', content: '要留着' });

    store.delete(a.id);

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(remaining.n).toBe(1);
    expect(store.messages(b.id)).toHaveLength(1);
    expect(() => store.get(a.id)).toThrow(/对话不存在/);
  });

  it('归档的对话默认不在列表里，取消归档后回来', () => {
    const conv = store.create({ title: '旧对话' });
    store.archive(conv.id);
    expect(store.list().find((x) => x.id === conv.id)).toBeUndefined();
    expect(store.list({ includeArchived: true }).find((x) => x.id === conv.id)).toBeDefined();
    store.unarchive(conv.id);
    expect(store.list().find((x) => x.id === conv.id)).toBeDefined();
  });
});

describe('D2 引擎会话与流式状态', () => {
  it('重启后引擎会话 id 被清空（不能去续一个不存在的会话）', () => {
    const conv = store.create();
    store.setEngineSession(conv.id, 'hermes', 'engine-session-abc');
    expect(store.get(conv.id).engineSessionId).toBe('engine-session-abc');
    db.close();

    const reopened = openDatabase(dbPath);
    migrate(reopened);
    const after = new ConversationStore(reopened);
    expect(after.clearEngineSessions()).toBe(1);

    const restored = after.get(conv.id);
    expect(restored.engineSessionId).toBeNull();
    // engine 本身保留：用于显示「上次用的是哪个引擎」
    expect(restored.engine).toBe('hermes');
    reopened.close();
  });

  it('流式分片累积；收尾后迟到的分片被丢弃，不污染已定稿正文', () => {
    const conv = store.create();
    const msg = store.appendMessage(conv.id, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    store.appendContent(msg.id, '正式');
    store.appendContent(msg.id, '系统名是 ');
    store.appendContent(msg.id, 'IXAEON');
    expect(store.getMessage(msg.id).content).toBe('正式系统名是 IXAEON');

    store.finishMessage(msg.id, { status: 'complete', engine: 'hermes' });
    store.appendContent(msg.id, '（迟到的分片）');

    const final = store.getMessage(msg.id);
    expect(final.content).toBe('正式系统名是 IXAEON');
    expect(final.status).toBe('complete');
  });

  it('取消和失败都留下可见状态，不是空白气泡', () => {
    const conv = store.create();

    const cancelled = store.appendMessage(conv.id, {
      role: 'assistant',
      content: '写到一半',
      status: 'streaming',
    });
    store.finishMessage(cancelled.id, { status: 'cancelled' });
    expect(store.getMessage(cancelled.id).content).toBe('写到一半');
    expect(store.getMessage(cancelled.id).status).toBe('cancelled');

    const failed = store.appendMessage(conv.id, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    store.finishMessage(failed.id, { status: 'failed', errorMessage: '引擎超时' });
    expect(store.getMessage(failed.id).status).toBe('failed');
    expect(store.getMessage(failed.id).errorMessage).toBe('引擎超时');
  });

  it('未完成的消息不作为下一轮背景', () => {
    const conv = store.create();
    store.appendMessage(conv.id, { role: 'user', content: '第一问' });
    store.appendMessage(conv.id, { role: 'assistant', content: '第一答' });
    store.appendMessage(conv.id, { role: 'user', content: '第二问' });
    const streaming = store.appendMessage(conv.id, {
      role: 'assistant',
      content: '半截',
      status: 'streaming',
    });

    const turns = store.recentTurns(conv.id);
    expect(turns.map((m) => m.content)).toEqual(['第一问', '第一答', '第二问']);

    store.finishMessage(streaming.id, { status: 'cancelled' });
    expect(store.recentTurns(conv.id).map((m) => m.content)).toEqual([
      '第一问',
      '第一答',
      '第二问',
    ]);
  });

  it('recentTurns 按轮数截断且保持时间正序', () => {
    const conv = store.create();
    for (let i = 1; i <= 5; i++) {
      store.appendMessage(conv.id, { role: 'user', content: `问${i}` });
      store.appendMessage(conv.id, { role: 'assistant', content: `答${i}` });
    }
    const turns = store.recentTurns(conv.id, 2);
    expect(turns.map((m) => m.content)).toEqual(['问4', '答4', '问5', '答5']);
  });

  it('损坏的引用 JSON 不会让对话打不开', () => {
    const conv = store.create();
    const msg = store.appendMessage(conv.id, { role: 'assistant', content: '回答' });
    db.prepare('UPDATE messages SET citations_json = ? WHERE id = ?').run('{坏掉的', msg.id);

    const loaded = store.getMessage(msg.id);
    expect(loaded.content).toBe('回答');
    expect(loaded.citations).toEqual([]);
  });
});
