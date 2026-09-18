/**
 * E5：IXAEON 自己聊天里 AI 给的建议也提炼（记成 AI 建议），复述已有记忆的不收。
 *
 * 用户 2026-09-18：之后在聊天里向 AI 要意见，AI 给的意见也该留下；E2 的回声不能回来。
 * - 每条 Hermes 回答记下「这一轮注入了哪些记忆」（meta.memoryUsed）；有这份记录的回答才提炼；
 * - 提炼时块前列出这些记忆，告诉提炼模型复述、自我介绍、缺信息说明都不收（主要靠这一道）；
 * - 代码兜底：与注入记忆几乎同义的 AI 建议丢掉（有向量看语义，另做字面比对）；
 * - 没有记录的旧回答、Core 兜底回答仍只提炼用户的话（见 e2-ask-echo）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationStore,
  Extractor,
  FakeProvider,
  ImportService,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const QUESTION = '周报总是拖到周末才写，有什么办法？';
const MEMORY = '用户每周要给团队写一份周报';
const ANSWER = '你每周都要给团队写一份周报。建议每周五下午固定留出半小时写周报，平时随手记下要点。';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-e5-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 一轮聊天：消息表里一问一答（回答带本轮注入的记忆），并存成聊天存档。 */
function chatTurn(opts: { engine?: string; memoryUsed?: unknown } = {}): string {
  const conversations = new ConversationStore(db);
  const conv = conversations.create({ projectId: null });
  const q = conversations.appendMessage(conv.id, { role: 'user', content: QUESTION });
  const a = conversations.appendMessage(conv.id, {
    role: 'assistant',
    content: ANSWER,
    engine: opts.engine ?? 'hermes',
    meta:
      'memoryUsed' in opts
        ? { memoryUsed: opts.memoryUsed }
        : { memoryUsed: [{ id: 'm1', statement: MEMORY, tag: '用户指定' }] },
  });
  const permissions = new PermissionService(db);
  const imports = new ImportService(
    db,
    new Vault(join(dir, 'vault')),
    permissions,
    new SourceStore(db),
  );
  return imports.captureAsk({
    question: QUESTION,
    answer: ANSWER,
    conversationId: conv.id,
    userSeq: q.seq,
    assistantSeq: a.seq,
    engine: 'hermes',
    model: null,
    projectId: null,
    permissionId: permissions.grantDomain('ask.ixaeon.local').id,
  }).source.id;
}

/** 引用回答那段（片段编号 = 消息序号 + 1）的一条候选。 */
function fromAnswer(ref: string, statement: string, excerpt: string) {
  return {
    type: 'open_loop',
    statement,
    rationale: null,
    confidence: 0.8,
    segment_ref: ref,
    project_hint: null,
    excerpt,
  };
}

function answerRef(): string {
  const seq = (
    db.prepare(`SELECT seq FROM messages WHERE role = 'assistant'`).get() as { seq: number }
  ).seq;
  return `S${seq + 1}`;
}

const saved = () =>
  db.prepare(`SELECT statement, said_by FROM items ORDER BY statement`).all() as Array<{
    statement: string;
    said_by: string | null;
  }>;

describe('有本轮记忆记录的 Hermes 回答', () => {
  it('回答也交给提炼模型，块前列出这一轮 AI 看过的记忆和不收什么', async () => {
    const src = chatTurn();
    const fake = new FakeProvider().enqueueStructured({ items: [] });
    await new Extractor(db, fake).extractSource(src);
    const sent = fake.structuredCalls[0]!.user;
    expect(sent).toContain('每周五下午固定留出半小时');
    expect(sent).toContain('（assistant）');
    expect(sent).toContain('说明，不是资料、不能引用');
    expect(sent).toContain(`- ${MEMORY}`);
  });

  it('新建议记成 AI 建议；照抄注入记忆的一条是回声，不存', async () => {
    const src = chatTurn();
    const ref = answerRef();
    const fake = new FakeProvider().enqueueStructured({
      items: [
        fromAnswer(ref, 'AI 建议每周五下午固定留半小时写周报', '每周五下午固定留出半小时写周报'),
        fromAnswer(ref, 'AI 提到用户每周要给团队写一份周报', '你每周都要给团队写一份周报'),
      ],
    });
    const stats = await new Extractor(db, fake).extractSource(src);
    expect(stats.skippedEcho).toBe(1);
    expect(saved()).toEqual([{ statement: 'AI 建议每周五下午固定留半小时写周报', said_by: 'ai' }]);
  });

  it('有向量服务时按语义认回声：改写过的复述也拦得住，参照只用这一轮注入的记忆', async () => {
    const src = chatTurn();
    const ref = answerRef();
    const calls: Array<{ texts: string[]; refs: string[] }> = [];
    const similarity = async (texts: string[], refs: string[]) => {
      calls.push({ texts, refs });
      return texts.map((t) => (t.includes('团队') ? 0.9 : 0.2));
    };
    const fake = new FakeProvider().enqueueStructured({
      items: [
        fromAnswer(ref, 'AI 建议平时随手记下周报要点', '平时随手记下要点'),
        fromAnswer(ref, '需要定期向团队汇报工作', '你每周都要给团队写一份周报'),
      ],
    });
    const stats = await new Extractor(db, fake, { similarity }).extractSource(src);
    expect(stats.skippedEcho).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.refs).toEqual([MEMORY]);
    expect(saved().map((r) => r.statement)).toEqual(['AI 建议平时随手记下周报要点']);
  });

  it('向量服务出错：退回字面比对，提炼照常完成', async () => {
    const src = chatTurn();
    const ref = answerRef();
    const fake = new FakeProvider().enqueueStructured({
      items: [
        fromAnswer(ref, 'AI 建议平时随手记下周报要点', '平时随手记下要点'),
        fromAnswer(ref, '用户每周要给团队写一份周报', '你每周都要给团队写一份周报'),
      ],
    });
    const similarity = async (): Promise<number[]> => {
      throw new Error('Ollama 没开');
    };
    const stats = await new Extractor(db, fake, { similarity }).extractSource(src);
    expect(stats.skippedEcho).toBe(1);
    expect(saved().map((r) => r.statement)).toEqual(['AI 建议平时随手记下周报要点']);
  });

  it('这一轮一条记忆都没注入：回答照样提炼，没有可比的回声', async () => {
    const src = chatTurn({ memoryUsed: [] });
    const fake = new FakeProvider().enqueueStructured({
      items: [fromAnswer(answerRef(), 'AI 建议周五下午写周报', '每周五下午固定留出半小时')],
    });
    const stats = await new Extractor(db, fake).extractSource(src);
    expect(stats.skippedEcho).toBe(0);
    expect(fake.structuredCalls[0]!.user).toContain('AI 回答前看过的记忆：无');
    expect(saved()).toEqual([{ statement: 'AI 建议周五下午写周报', said_by: 'ai' }]);
  });
});

describe('仍只提炼用户的话', () => {
  it('Core 兜底的回答（只依据记忆作答，没有新建议）', async () => {
    const src = chatTurn({ engine: 'core-bounded' });
    const fake = new FakeProvider().enqueueStructured({ items: [] });
    await new Extractor(db, fake).extractSource(src);
    expect(fake.structuredCalls[0]!.user).not.toContain('每周五下午');
  });

  it('没有记下本轮注入记忆的回答（E5 之前的旧回答）', async () => {
    const src = chatTurn({ memoryUsed: undefined });
    const fake = new FakeProvider().enqueueStructured({ items: [] });
    await new Extractor(db, fake).extractSource(src);
    const sent = fake.structuredCalls[0]!.user;
    expect(sent).toContain(QUESTION);
    expect(sent).not.toContain('每周五下午');
    expect(sent).not.toContain('说明，不是资料');
  });
});
