/**
 * E3：谁说的记在谁名下（用户 2026-09-18 定做法 B）。
 *
 * 真机：从导入聊天提炼出的 91 条里 58 条依据全是 ChatGPT 的回答，却被记成用户的
 * 决定、偏好、约束。用户的判断：AI 给的建议有用，要留——但要记在 AI 名下。
 * - 谁说的按依据片段的说话人定，不由模型判断；
 * - AI 的建议不进「待确认」（不是要用户核对的「用户的决定」），想用就「采纳」；
 * - 聊天注入时标明「AI 当时的建议」，首页不把它当成用户的约束或待办；
 * - 迁移 31 按依据回填旧条目。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContextSelector,
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  buildPersonalOverview,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const QUESTION = '家里的旧笔记本要不要换成台式机';
const ADVICE = '建议换成台式机，同样预算性能高一截，散热也更好';

let dir: string;
const opened: CoreDatabase[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-e3-'));
});

afterEach(() => {
  for (const d of opened.splice(0)) if (d.open) d.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(name: string, upTo?: number): CoreDatabase {
  const d = openDatabase(join(dir, name));
  opened.push(d);
  migrate(d, upTo);
  return d;
}

/** 一段导入的聊天（问 S2 / 答 S3）。 */
function importedChat(d: CoreDatabase, conversationId = 'conv-1'): string {
  const permissions = new PermissionService(d);
  const imports = new ImportService(
    d,
    new Vault(join(dir, 'vault')),
    permissions,
    new SourceStore(d),
  );
  const { source } = imports.captureAsk({
    question: QUESTION,
    answer: ADVICE,
    conversationId,
    userSeq: 1,
    assistantSeq: 2,
    engine: 'hermes',
    model: null,
    projectId: null,
    permissionId: permissions.grantDomain('ask.ixaeon.local').id,
  });
  d.prepare(`UPDATE sources SET provider = 'chatgpt_export' WHERE id = ?`).run(source.id);
  return source.id;
}

const row = (d: CoreDatabase, statement: string) =>
  d
    .prepare('SELECT said_by, needs_reasons, needs_review FROM items WHERE statement = ?')
    .get(statement) as { said_by: string | null; needs_reasons: string; needs_review: number };

describe('提炼：谁说的记在谁名下', () => {
  it('依据是用户的话 → user；依据是 AI 的回答 → ai，且不进「待确认」', async () => {
    const d = open('ixaeon.db');
    const src = importedChat(d);
    const fake = new FakeProvider().enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '用户在考虑把旧笔记本换成台式机',
          rationale: null,
          confidence: 0.8,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: '旧笔记本要不要换成台式机',
        },
        {
          type: 'decision',
          statement: 'AI 建议换成台式机',
          rationale: '同样预算性能更高',
          confidence: 0.8,
          segment_ref: 'S3',
          project_hint: null,
          excerpt: '建议换成台式机',
        },
      ],
    });
    await new Extractor(d, fake).extractSource(src);
    // 提示词告诉模型分清说话人（记在谁名下仍由代码按片段定）
    expect(fake.structuredCalls[0]!.system).toContain('只能来自（user）片段');
    expect(row(d, '用户在考虑把旧笔记本换成台式机')).toEqual({
      said_by: 'user',
      needs_reasons: 'no_project,unconfirmed',
      needs_review: 1,
    });
    expect(row(d, 'AI 建议换成台式机')).toEqual({
      said_by: 'ai',
      needs_reasons: 'no_project',
      needs_review: 1,
    });
  });

  it('归到项目后：AI 的建议不再待处理，用户的决定仍待确认', async () => {
    const d = open('ixaeon.db');
    const src = importedChat(d);
    const reply = (ref: string, statement: string, excerpt: string) => ({
      type: 'decision',
      statement,
      rationale: null,
      confidence: 0.8,
      segment_ref: ref,
      project_hint: null,
      excerpt,
    });
    const fake = new FakeProvider().enqueueStructured({
      items: [
        reply('S2', '用户在考虑换台式机', '要不要换成台式机'),
        reply('S3', 'AI 建议换台式机', '建议换成台式机'),
      ],
    });
    await new Extractor(d, fake).extractSource(src);
    const project = new ProjectService(d).create({
      name: '装机',
      rootPath: null,
      description: null,
    });
    const items = new ItemService(d);
    const idOf = (s: string) =>
      (d.prepare('SELECT id FROM items WHERE statement = ?').get(s) as { id: string }).id;
    items.assignToProject(idOf('AI 建议换台式机'), project.id);
    items.assignToProject(idOf('用户在考虑换台式机'), project.id);
    expect(row(d, 'AI 建议换台式机')).toMatchObject({ needs_reasons: '', needs_review: 0 });
    expect(row(d, '用户在考虑换台式机')).toMatchObject({
      needs_reasons: 'unconfirmed',
      needs_review: 1,
    });
  });
});

describe('用 AI 的建议时标明出处', () => {
  function setup() {
    const d = open('ixaeon.db');
    const project = new ProjectService(d).create({
      name: '装机',
      rootPath: null,
      description: null,
    });
    const items = new ItemService(d);
    const add = (
      statement: string,
      type: 'constraint' | 'decision',
      saidBy: 'user' | 'ai',
      confirmation: 'none' | 'confirmed' = 'none',
    ): string => {
      const item = items.createManual({
        projectId: null,
        scope: 'personal',
        type,
        statement,
        rationale: null,
      });
      items.grantDisclosure({ itemId: item.id, audience: 'model', note: '测试' });
      d.prepare(
        `UPDATE items SET origin = 'ai', said_by = ?, confirmation = ?, needs_review = 1,
           needs_reasons = 'manual' WHERE id = ?`,
      ).run(saidBy, confirmation, item.id);
      return item.id;
    };
    return { d, project, add };
  }

  it('聊天注入：AI 的建议标「AI 当时的建议」，采纳过的标「用户采纳」，用户的话照旧', () => {
    const { d, add } = setup();
    add('台式机预算控制在一万以内', 'constraint', 'user');
    add('AI 建议台式机优先选大机箱', 'constraint', 'ai');
    add('AI 建议台式机配 32G 内存', 'decision', 'ai', 'confirmed');
    const r = new ContextSelector(d).selectForQuestion('台式机怎么配？', null);
    const line = (text: string) => r.promptBlock.split('\n').find((l) => l.includes(text)) ?? '';
    expect(line('预算控制在一万以内')).toContain('系统推断');
    expect(line('优先选大机箱')).toContain('AI 当时的建议，不是用户的决定');
    expect(line('32G 内存')).toContain('用户采纳的 AI 建议');
    // 用户 2026-09-18：AI 的方案只是当时合适，不要当成定论让后面的 AI 照做（采纳过的也一样）
    expect(r.promptBlock).toContain('是当时的看法，不是定论');
  });

  it('没有 AI 建议时不加这段说明', () => {
    const { d, add } = setup();
    add('台式机预算控制在一万以内', 'constraint', 'user');
    const r = new ContextSelector(d).selectForQuestion('台式机预算多少？', null);
    expect(r.promptBlock).toContain('预算控制在一万以内');
    expect(r.promptBlock).not.toContain('不是定论');
  });

  it('首页：没采纳的 AI 建议不算你的约束，也不算你要处理的事；采纳后算', () => {
    const { d, add } = setup();
    const mine = add('台式机预算控制在一万以内', 'constraint', 'user');
    const advice = add('AI 建议台式机优先选大机箱', 'constraint', 'ai');
    const adopted = add('AI 建议散热优先', 'constraint', 'ai', 'confirmed');
    const aiDecision = add('AI 建议换台式机', 'decision', 'ai');
    const o = buildPersonalOverview(d);
    expect(o.constraints.map((i) => i.id).sort()).toEqual([adopted, mine].sort());
    expect(o.constraints.map((i) => i.id)).not.toContain(advice);
    expect(o.unknowns.map((i) => i.id)).not.toContain(aiDecision);
  });
});

describe('迁移 31：按依据回填旧条目', () => {
  const NOW = '2026-09-17T00:00:00.000Z';

  function seed(
    d: CoreDatabase,
    id: string,
    sourceId: string,
    roles: Array<'user' | 'assistant'>,
    needsReasons: string,
    origin = 'ai',
  ): void {
    d.prepare(
      `INSERT INTO items (id, type, statement, state, origin, created_at, updated_at,
         extracted_from_source_id, needs_review, needs_reasons)
       VALUES (?, 'decision', ?, 'current', ?, ?, ?, ?, ?, ?)`,
    ).run(id, `合成条目 ${id}`, origin, NOW, NOW, sourceId, needsReasons ? 1 : 0, needsReasons);
    for (const role of roles) {
      const seg = d
        .prepare('SELECT id FROM segments WHERE source_id = ? AND role = ?')
        .get(sourceId, role) as { id: string };
      d.prepare(
        'INSERT INTO item_evidence (item_id, segment_id, excerpt, relevance) VALUES (?, ?, ?, 0.9)',
      ).run(id, seg.id, '合成摘录');
    }
  }

  it('用户的话 → user；只有 AI 的回答 → ai，并只去掉「待确认」；其余不动', () => {
    const d = open('m30.db', 30);
    const src = importedChat(d);
    seed(d, 'mine', src, ['user'], 'no_project,unconfirmed');
    seed(d, 'advice', src, ['assistant'], 'no_project,unconfirmed');
    seed(d, 'advice-only-unconfirmed', src, ['assistant'], 'unconfirmed');
    seed(d, 'advice-conflict', src, ['assistant'], 'unconfirmed,conflict');
    seed(d, 'both', src, ['user', 'assistant'], 'unconfirmed');
    seed(d, 'manual', src, [], '', 'user');

    migrate(d);

    const rows = d
      .prepare('SELECT id, said_by, needs_reasons, needs_review FROM items ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 'advice', said_by: 'ai', needs_reasons: 'no_project', needs_review: 1 },
      { id: 'advice-conflict', said_by: 'ai', needs_reasons: 'conflict', needs_review: 1 },
      { id: 'advice-only-unconfirmed', said_by: 'ai', needs_reasons: '', needs_review: 0 },
      { id: 'both', said_by: 'user', needs_reasons: 'unconfirmed', needs_review: 1 },
      { id: 'manual', said_by: null, needs_reasons: '', needs_review: 0 },
      { id: 'mine', said_by: 'user', needs_reasons: 'no_project,unconfirmed', needs_review: 1 },
    ]);
  });
});
