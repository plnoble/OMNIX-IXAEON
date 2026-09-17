/**
 * D5 验收：ask_session 来源从对话派生（三周任务单 / 委派单 D5）。
 *
 * 一个对话一条来源；后续轮次走 SourceStore.appendCapturedTurns；
 * conversations.source_id 挂上该来源。授权撤销语义不变。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationStore,
  ImportService,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let vaultDir: string;
let imports: ImportService;
let permissions: PermissionService;
let conversations: ConversationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-d5-'));
  vaultDir = join(dir, 'vault');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  permissions = new PermissionService(db);
  imports = new ImportService(db, new Vault(vaultDir), permissions, new SourceStore(db));
  conversations = new ConversationStore(db);
});

afterEach(() => {
  if (db.open) db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

function askCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM sources WHERE provider = 'ask_session'").get() as {
      n: number;
    }
  ).n;
}

function segmentsOf(sourceId: string): Array<{ sequence: number; role: string; text: string }> {
  return db
    .prepare('SELECT sequence, role, text FROM segments WHERE source_id = ? ORDER BY sequence')
    .all(sourceId) as Array<{ sequence: number; role: string; text: string }>;
}

describe('D5 ask_session 来源从对话派生', () => {
  it('一个对话连问 3 轮只有 1 条来源、6 个 segment，且挂上 conversations.source_id', () => {
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const conv = conversations.create();
    const rounds = [
      { q: '正式系统名是什么？', a: 'IXAEON（析衍）。' },
      { q: '刚才那个名字怎么读？', a: '析衍，读作 xī yǎn。' },
      { q: '为什么叫这个？', a: '从原文里析出，再往前衍。' },
    ];
    let sourceId: string | null = null;
    for (let i = 0; i < rounds.length; i++) {
      const user = conversations.appendMessage(conv.id, {
        role: 'user',
        content: rounds[i]!.q,
      });
      const assistant = conversations.appendMessage(conv.id, {
        role: 'assistant',
        content: rounds[i]!.a,
      });
      const captured = imports.captureAsk({
        question: rounds[i]!.q,
        answer: rounds[i]!.a,
        conversationId: conv.id,
        userSeq: user.seq,
        assistantSeq: assistant.seq,
        engine: 'core-bounded',
        model: 'fake-model-v1',
        projectId: null,
        permissionId: perm.id,
      });
      if (captured.created) {
        conversations.setSourceId(conv.id, captured.source.id);
      }
      sourceId = captured.source.id;
    }
    expect(askCount()).toBe(1);
    expect(sourceId).not.toBeNull();
    const segs = segmentsOf(sourceId!);
    expect(segs).toHaveLength(6);
    expect(segs.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(segs.filter((s) => s.role === 'user')).toHaveLength(3);
    expect(segs.filter((s) => s.role === 'assistant')).toHaveLength(3);
    const linked = conversations.get(conv.id);
    expect(linked.sourceId).toBe(sourceId);
  });

  it('两个对话各问一轮得到 2 条来源，内容不串', () => {
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const a = conversations.create();
    const b = conversations.create();
    const aUser = conversations.appendMessage(a.id, { role: 'user', content: '对话 A 的问题' });
    const aAsst = conversations.appendMessage(a.id, {
      role: 'assistant',
      content: '对话 A 的回答',
    });
    const bUser = conversations.appendMessage(b.id, { role: 'user', content: '对话 B 的问题' });
    const bAsst = conversations.appendMessage(b.id, {
      role: 'assistant',
      content: '对话 B 的回答',
    });
    const capturedA = imports.captureAsk({
      question: '对话 A 的问题',
      answer: '对话 A 的回答',
      conversationId: a.id,
      userSeq: aUser.seq,
      assistantSeq: aAsst.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    const capturedB = imports.captureAsk({
      question: '对话 B 的问题',
      answer: '对话 B 的回答',
      conversationId: b.id,
      userSeq: bUser.seq,
      assistantSeq: bAsst.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    expect(askCount()).toBe(2);
    expect(capturedA.source.id).not.toBe(capturedB.source.id);
    const segsA = segmentsOf(capturedA.source.id);
    const segsB = segmentsOf(capturedB.source.id);
    expect(segsA).toHaveLength(2);
    expect(segsB).toHaveLength(2);
    expect(segsA.map((s) => s.text).join(' ')).toContain('对话 A');
    expect(segsA.map((s) => s.text).join(' ')).not.toContain('对话 B');
    expect(segsB.map((s) => s.text).join(' ')).toContain('对话 B');
    expect(segsB.map((s) => s.text).join(' ')).not.toContain('对话 A');
  });

  it('同一对话、同样 seq 和正文再调一次：来源数与 segment 数不变，deduplicated > 0', () => {
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const conv = conversations.create();
    const user = conversations.appendMessage(conv.id, { role: 'user', content: '重复提交' });
    const assistant = conversations.appendMessage(conv.id, {
      role: 'assistant',
      content: '只记一次',
    });
    const first = imports.captureAsk({
      question: '重复提交',
      answer: '只记一次',
      conversationId: conv.id,
      userSeq: user.seq,
      assistantSeq: assistant.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    expect(first.created).toBe(true);
    const second = imports.captureAsk({
      question: '重复提交',
      answer: '只记一次',
      conversationId: conv.id,
      userSeq: user.seq,
      assistantSeq: assistant.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    expect(second.created).toBe(false);
    expect(second.deduplicated ?? 0).toBeGreaterThan(0);
    expect(askCount()).toBe(1);
    expect(segmentsOf(first.source.id)).toHaveLength(2);
  });

  it('追加新一轮后 content_revision 比追加前大', () => {
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const conv = conversations.create();
    const u1 = conversations.appendMessage(conv.id, { role: 'user', content: '第一问' });
    const a1 = conversations.appendMessage(conv.id, { role: 'assistant', content: '第一答' });
    const first = imports.captureAsk({
      question: '第一问',
      answer: '第一答',
      conversationId: conv.id,
      userSeq: u1.seq,
      assistantSeq: a1.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    const before = first.source.content_revision ?? 0;
    const u2 = conversations.appendMessage(conv.id, { role: 'user', content: '第二问' });
    const a2 = conversations.appendMessage(conv.id, { role: 'assistant', content: '第二答' });
    const second = imports.captureAsk({
      question: '第二问',
      answer: '第二答',
      conversationId: conv.id,
      userSeq: u2.seq,
      assistantSeq: a2.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    expect(second.source.content_revision ?? 0).toBeGreaterThan(before);
  });

  it('撤销 ask.ixaeon.local 后提问不落库，授权保持 revoked', () => {
    const perm = permissions.grantDomain('ask.ixaeon.local');
    const conv = conversations.create();
    const u1 = conversations.appendMessage(conv.id, { role: 'user', content: '先问一轮' });
    const a1 = conversations.appendMessage(conv.id, { role: 'assistant', content: '先答一轮' });
    imports.captureAsk({
      question: '先问一轮',
      answer: '先答一轮',
      conversationId: conv.id,
      userSeq: u1.seq,
      assistantSeq: a1.seq,
      engine: 'core-bounded',
      model: null,
      projectId: null,
      permissionId: perm.id,
    });
    expect(askCount()).toBe(1);
    permissions.revoke(perm.id);
    const after = permissions.get(perm.id);
    expect(after?.status).toBe('revoked');
    const u2 = conversations.appendMessage(conv.id, { role: 'user', content: '撤销后再问' });
    const a2 = conversations.appendMessage(conv.id, { role: 'assistant', content: '不应落库' });
    expect(() =>
      imports.captureAsk({
        question: '撤销后再问',
        answer: '不应落库',
        conversationId: conv.id,
        userSeq: u2.seq,
        assistantSeq: a2.seq,
        engine: 'core-bounded',
        model: null,
        projectId: null,
        permissionId: perm.id,
      }),
    ).toThrow(/授权/);
    expect(askCount()).toBe(1);
    expect(permissions.get(perm.id)?.status).toBe('revoked');
  });

  it('captureAsk 实现调用了 appendCapturedTurns，新增代码不含自写去重/分支逻辑', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../../src/import/importService.ts'),
      'utf8',
    );
    const start = src.indexOf('captureAsk(input:');
    const end = src.indexOf('\n  }\n', start);
    const body = src.slice(start, end);
    expect(body).toContain('appendCapturedTurns');
    expect(body).not.toMatch(/is_active_branch/);
    expect(body).not.toMatch(/content_revision\s*\+/);
    expect(body).not.toMatch(/deactivateSiblings|existsStmt|reactivateStmt/);
  });
});
