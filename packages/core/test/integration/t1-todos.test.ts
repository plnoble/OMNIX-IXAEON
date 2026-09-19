/**
 * T1：待办表与存取（迁移 33）。设计决定 3：薄的一层——只存叫什么、什么状态、
 * 从哪次对话来，底下指向已有的编码任务 / 研究主题，不新造任务系统。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodingTaskStore,
  ErrorCodes,
  ConversationStore,
  ProjectService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let todos: TodoStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-t1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  todos = new TodoStore(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const codes = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe('状态', () => {
  it('AI 提的等你拍板；拍板后要做；做完标完成', () => {
    const t = todos.propose({ title: '给周报加一段本周风险' })!;
    expect(t).toMatchObject({ status: 'proposed', origin: 'agent', decided_at: null });
    expect(todos.accept(t.id)).toMatchObject({ status: 'accepted' });
    expect(todos.get(t.id).decided_at).not.toBeNull();
    const done = todos.complete(t.id);
    expect(done.status).toBe('done');
    expect(done.done_at).not.toBeNull();
  });

  it('你自己加的直接算要做', () => {
    const t = todos.add({ title: '周五前交报销单' });
    expect(t).toMatchObject({ status: 'accepted', origin: 'user' });
    expect(t.decided_at).not.toBeNull();
  });

  it('不许乱跳：没拍板不能标完成、做完的不能再拒绝，拒绝过的不能再接受', () => {
    const t = todos.propose({ title: '整理下载目录' })!;
    expect(codes(() => todos.complete(t.id))).toBe(ErrorCodes.CONFLICT);
    todos.accept(t.id);
    todos.complete(t.id);
    expect(codes(() => todos.reject(t.id))).toBe(ErrorCodes.CONFLICT);
    const r = todos.propose({ title: '清空回收站' })!;
    todos.reject(r.id);
    expect(codes(() => todos.accept(r.id))).toBe(ErrorCodes.CONFLICT);
  });

  it('空标题不收；过长的截断，不整条丢掉', () => {
    expect(codes(() => todos.add({ title: '   ' }))).toBe(ErrorCodes.VALIDATION_FAILED);
    const long = todos.add({ title: '写'.repeat(300) });
    expect(long.title.length).toBe(200);
  });
});

describe('不重复、不重提', () => {
  it('拒绝过的事，AI 换个说法再提也不再打扰', () => {
    const t = todos.propose({ title: '把旧笔记本卖掉' })!;
    todos.reject(t.id);
    expect(todos.propose({ title: '把旧笔记本卖掉' })).toBeNull();
    expect(todos.propose({ title: '把旧笔记本卖掉吧' })).toBeNull();
    // 不相干的事照常提
    expect(todos.propose({ title: '预约下周体检' })).not.toBeNull();
  });

  it('还没办完的同一件事不重复出现', () => {
    const a = todos.propose({ title: '预约下周体检' })!;
    const b = todos.propose({ title: '  预约下周体检 ' })!;
    expect(b.id).toBe(a.id);
  });
});

describe('底下指向编码任务', () => {
  function codingTask(): string {
    const project = new ProjectService(db).create({
      name: '合成项目',
      rootPath: null,
      description: null,
    });
    return new CodingTaskStore(db).create({
      projectId: project.id,
      goal: '合成任务',
      scope: ['note.txt'],
      allowedCommands: [],
    }).id;
  }

  it('同一个编码任务只有一条待办；列表带编码任务的实时状态', () => {
    const taskId = codingTask();
    const a = todos.propose({
      title: '修掉导入时的乱码',
      linked: { kind: 'coding_task', id: taskId },
    })!;
    const again = todos.propose({
      title: '修掉导入乱码',
      linked: { kind: 'coding_task', id: taskId },
    });
    expect(again!.id).toBe(a.id);
    expect(todos.list()[0]).toMatchObject({ id: a.id, linkedStatus: 'draft' });
    db.prepare(`UPDATE coding_tasks SET status = 'running' WHERE id = ?`).run(taskId);
    expect(todos.list()[0]!.linkedStatus).toBe('running');
    expect(todos.byLink({ kind: 'coding_task', id: taskId })!.id).toBe(a.id);
  });

  it('列表先放等你拍板的、再放要做的，其余在后；可按状态筛', () => {
    const done = todos.add({ title: '已经做完的事' });
    todos.complete(done.id);
    const doing = todos.add({ title: '正在做的事' });
    const ask = todos.propose({ title: '等你拍板的事' })!;
    expect(todos.list().map((t) => t.id)).toEqual([ask.id, doing.id, done.id]);
    expect(todos.list({ status: ['done'] }).map((t) => t.id)).toEqual([done.id]);
  });
});

describe('从哪次对话来', () => {
  it('记下对话与消息；对话删了，待办还在，只是不再指向它', () => {
    const conversations = new ConversationStore(db);
    const conv = conversations.create({ projectId: null });
    const msg = conversations.appendMessage(conv.id, { role: 'assistant', content: '合成回答' });
    const t = todos.propose({
      title: '回头看一下报价',
      conversationId: conv.id,
      messageId: msg.id,
    })!;
    expect(t).toMatchObject({ conversation_id: conv.id, message_id: msg.id });
    conversations.delete(conv.id);
    expect(todos.get(t.id)).toMatchObject({ conversation_id: null, message_id: null });
  });

  it('每一步都记审计', () => {
    const t = todos.propose({ title: '合成待办' })!;
    todos.accept(t.id);
    todos.complete(t.id);
    const kinds = (
      db
        .prepare(`SELECT kind FROM audit_events WHERE kind LIKE 'todo.%' ORDER BY rowid`)
        .all() as Array<{ kind: string }>
    ).map((r) => r.kind);
    expect(kinds).toEqual(['todo.proposed', 'todo.accepted', 'todo.done']);
  });
});
