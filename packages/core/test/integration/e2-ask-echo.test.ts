/**
 * E2：IXAEON 自己的聊天存档只从用户说的话里提炼（用户 2026-09-18 定）。
 *
 * 真机：一次聊天被错误注入了旧资料，模型在回答里复述，提炼又把复述当成新结论
 * 存了回来——同一批旧内容多了 8 份副本（回声）。
 * - 提炼 ask_session 来源时只把用户的原话交给模型，模型的回答看都看不到；
 * - 导入的聊天（ChatGPT 导出等）问和答都提炼，AI 说的记在 AI 名下（E3，见 e3-said-by）；
 * - 迁移 30 清掉已经存回来的：依据全部来自模型回答、没经过用户处理的 AI 条目。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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

const QUESTION = '以后周报都用中文写，周五下午发';
const RESTATED = '你的旧项目已经在上周上线'; // 模型在回答里复述的旧记忆
const ANSWER = `好的，记下了。另外提醒：${RESTATED}。`;

let dir: string;
const opened: CoreDatabase[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-e2-'));
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

/** 一段 IXAEON 聊天存档（问 S2 / 答 S3）；provider 改成别的即模拟导入的聊天。 */
function chat(d: CoreDatabase, conversationId: string, provider = 'ask_session'): string {
  const permissions = new PermissionService(d);
  const imports = new ImportService(
    d,
    new Vault(join(dir, 'vault')),
    permissions,
    new SourceStore(d),
  );
  const { source } = imports.captureAsk({
    question: QUESTION,
    answer: ANSWER,
    conversationId,
    userSeq: 1,
    assistantSeq: 2,
    engine: 'hermes',
    model: null,
    projectId: null,
    permissionId: permissions.grantDomain('ask.ixaeon.local').id,
  });
  if (provider !== 'ask_session') {
    d.prepare('UPDATE sources SET provider = ? WHERE id = ?').run(provider, source.id);
  }
  return source.id;
}

function segmentOf(d: CoreDatabase, sourceId: string, role: 'user' | 'assistant'): string {
  return (
    d.prepare('SELECT id FROM segments WHERE source_id = ? AND role = ?').get(sourceId, role) as {
      id: string;
    }
  ).id;
}

describe('提炼聊天存档', () => {
  it('只把用户的原话交给模型，模型的回答不交', async () => {
    const d = open('ixaeon.db');
    const src = chat(d, 'conv-1');
    const fake = new FakeProvider().enqueueStructured({ items: [] });
    await new Extractor(d, fake).extractSource(src);
    expect(fake.structuredCalls).toHaveLength(1);
    const sent = fake.structuredCalls[0]!.user;
    expect(sent).toContain(QUESTION);
    expect(sent).not.toContain(RESTATED);
    expect(sent).not.toContain('（assistant）');
  });

  it('模型硬要引用回答（S3）：那条进不来，引用用户原话的照常写入', async () => {
    const d = open('ixaeon.db');
    const src = chat(d, 'conv-1');
    const reply = {
      items: [
        {
          type: 'preference',
          statement: '周报用中文写',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: '以后周报都用中文写',
        },
        {
          type: 'decision',
          statement: '旧项目已经上线',
          rationale: null,
          confidence: 0.9,
          segment_ref: 'S3',
          project_hint: null,
          excerpt: RESTATED,
        },
      ],
    };
    // 有对不上的引用会自动再跑一轮，所以给两份
    const fake = new FakeProvider().enqueueStructured(reply).enqueueStructured(reply);
    const stats = await new Extractor(d, fake).extractSource(src);
    expect(stats.inserted).toBe(1);
    expect(stats.skippedBadRef).toBe(1);
    const rows = d
      .prepare(
        `SELECT i.statement, g.role FROM items i
         JOIN item_evidence e ON e.item_id = i.id JOIN segments g ON g.id = e.segment_id
         WHERE i.extracted_from_source_id = ?`,
      )
      .all(src);
    expect(rows).toEqual([{ statement: '周报用中文写', role: 'user' }]);
  });

  it('导入的聊天：问和答都交给模型（AI 说的记在 AI 名下，见 E3）', async () => {
    const d = open('ixaeon.db');
    const src = chat(d, 'conv-1', 'chatgpt_export');
    const fake = new FakeProvider().enqueueStructured({ items: [] });
    await new Extractor(d, fake).extractSource(src);
    expect(fake.structuredCalls[0]!.user).toContain(RESTATED);
  });
});

describe('迁移 30：清掉已经存回来的回声', () => {
  const NOW = '2026-09-17T00:00:00.000Z';

  function seed(
    d: CoreDatabase,
    id: string,
    segmentId: string,
    sourceId: string,
    extra: { state?: string; confirmation?: string; manualProject?: number } = {},
  ): void {
    d.prepare(
      `INSERT INTO items (id, type, statement, state, origin, confirmation, manual_project,
         created_at, updated_at, extracted_from_source_id)
       VALUES (?, 'decision', ?, ?, 'ai', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `合成条目 ${id}`,
      extra.state ?? 'current',
      extra.confirmation ?? 'none',
      extra.manualProject ?? 0,
      NOW,
      NOW,
      sourceId,
    );
    d.prepare(
      'INSERT INTO item_evidence (item_id, segment_id, excerpt, relevance) VALUES (?, ?, ?, 0.9)',
    ).run(id, segmentId, '合成摘录');
  }

  const count = (d: CoreDatabase, sql: string, ...args: unknown[]): number =>
    (d.prepare(sql).get(...args) as { n: number }).n;

  it('只删依据全部来自回答、没经过用户处理的 AI 条目；依据、向量一并删，审计记下删了哪条', () => {
    const d = open('m29.db', 29);
    const ask = chat(d, 'conv-1');
    const imported = chat(d, 'conv-2', 'chatgpt_export');
    const askAnswer = segmentOf(d, ask, 'assistant');
    seed(d, 'echo', askAnswer, ask);
    seed(d, 'said', segmentOf(d, ask, 'user'), ask);
    seed(d, 'confirmed', askAnswer, ask, { confirmation: 'confirmed' });
    seed(d, 'moved', askAnswer, ask, { manualProject: 1 });
    seed(d, 'history', askAnswer, ask, { state: 'superseded' });
    seed(d, 'imported', segmentOf(d, imported, 'assistant'), imported);
    d.prepare(
      `INSERT INTO item_embeddings (item_id, model, text_hash, dim, vector, created_at)
       VALUES ('echo', 'test:e2', 'h', 1, ?, ?)`,
    ).run(Buffer.alloc(4), NOW);

    migrate(d);

    const left = (d.prepare('SELECT id FROM items ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(left).toEqual(['confirmed', 'history', 'imported', 'moved', 'said']);
    expect(count(d, `SELECT COUNT(*) n FROM item_evidence WHERE item_id = 'echo'`)).toBe(0);
    expect(count(d, `SELECT COUNT(*) n FROM item_embeddings WHERE item_id = 'echo'`)).toBe(0);
    const audit = d
      .prepare(`SELECT detail_json FROM audit_events WHERE kind = 'migration.ask_echoes_removed'`)
      .all() as Array<{ detail_json: string }>;
    expect(audit.map((a) => JSON.parse(a.detail_json))).toEqual([{ count: 1, itemIds: ['echo'] }]);

    // 只跑一次：再迁移不再动任何东西
    migrate(d);
    expect(count(d, 'SELECT COUNT(*) n FROM items')).toBe(5);
    expect(count(d, `SELECT COUNT(*) n FROM audit_events WHERE kind LIKE 'migration.%'`)).toBe(1);
  });

  it('没有回声：什么也不删，也不写审计', () => {
    const d = open('m29.db', 29);
    const ask = chat(d, 'conv-1');
    seed(d, 'said', segmentOf(d, ask, 'user'), ask);
    migrate(d);
    expect(count(d, 'SELECT COUNT(*) n FROM items')).toBe(1);
    expect(
      count(d, `SELECT COUNT(*) n FROM audit_events WHERE kind = 'migration.ask_echoes_removed'`),
    ).toBe(0);
  });
});
