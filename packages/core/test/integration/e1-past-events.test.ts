/**
 * E1：已结束的事自动退场（2026-09-18 真机：7 月已结束的一次出差筹备被当成「当前核心主线」）。
 *
 * - 按内容里写的日期判断（条目时间戳是导入分析的日期，不能用）；
 * - 自动做的只是「不当眼下的事」：首页目标里不列、概览问题排在仍然成立的后面、注入时标「已过」；
 *   不删、不搁置——问到那件事时仍能查到（当历史）；
 * - 用户可以一键确认「已结束 / 还没结束」，确认过的以用户为准。
 *
 * 日期都写明年份（2020 年 / 2099 年），测试结果不随运行那天变化。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContextSelector,
  ImportService,
  ItemService,
  PermissionService,
  SemanticIndex,
  SourceStore,
  Vault,
  buildPersonalOverview,
  migrate,
  normalize,
  openDatabase,
  type CoreDatabase,
  type TextEmbedder,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let items: ItemService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-e1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  items = new ItemService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function goal(statement: string, origin: 'user' | 'ai' = 'user'): string {
  const item = items.createManual({
    projectId: null,
    scope: 'personal',
    type: 'goal',
    statement,
    rationale: null,
  });
  items.grantDisclosure({ itemId: item.id, audience: 'model', note: '测试' });
  if (origin === 'ai') {
    db.prepare(`UPDATE items SET origin = 'ai', confirmation = 'none' WHERE id = ?`).run(item.id);
  }
  return item.id;
}

const PAST = '2020年7月20日至26日完成一次出差的整体安排';
const CURRENT = '长期做一个本地优先的个人助手';

describe('首页总览', () => {
  it('内容日期已过的目标不列为「我想做什么」，改列进「看起来已经结束的事」', () => {
    const past = goal(PAST);
    const current = goal(CURRENT);
    const o = buildPersonalOverview(db);
    expect(o.goals.map((i) => i.id)).toEqual([current]);
    expect(o.pastSuggestions.map((s) => [s.item.id, s.day])).toEqual([[past, '2020-07-26']]);
  });

  it('用户说「还没结束」：回到目标里，不再被当成过去的事', () => {
    const past = goal(PAST);
    items.setTimeStatus(past, 'ongoing');
    const o = buildPersonalOverview(db);
    expect(o.goals.map((i) => i.id)).toContain(past);
    expect(o.pastSuggestions).toEqual([]);
  });

  it('用户确认「已结束」：不列为目标，也不再反复询问；内容里没日期也算', () => {
    const noDate = goal('把旧版本的迁移做完');
    items.setTimeStatus(noDate, 'ended');
    const o = buildPersonalOverview(db);
    expect(o.goals.map((i) => i.id)).not.toContain(noDate);
    expect(o.pastSuggestions).toEqual([]);
    // 没删也没搁置：条目还在
    expect(items.get(noDate).shelved_at).toBeNull();
  });

  it('日期还没到的不算', () => {
    const future = goal('2099年1月1日前完成体检');
    expect(buildPersonalOverview(db).goals.map((i) => i.id)).toContain(future);
  });
});

/** 固定向量替身：问句与所有条目正交——语义上一条都不相关，走概览兜底。 */
class Orthogonal implements TextEmbedder {
  readonly modelId = 'test:orth';
  private n = 0;
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() =>
      normalize([0, 0, 0, 0, 0, 0].map((_, i) => (i === this.n++ % 5 ? 1 : 0))),
    );
  }
  async embedQuery(): Promise<Float32Array> {
    return normalize([0, 0, 0, 0, 0, 1]);
  }
}

describe('聊天选记忆', () => {
  it('概览问题：仍然成立的排在前面，已经过去的排后面并标「所述日期已过」', async () => {
    const past = goal(PAST, 'ai');
    const current = goal(CURRENT, 'ai');
    // 让过去那条「更新得更近」，确认排序靠的是过没过去，不是更新时间
    db.prepare(`UPDATE items SET updated_at = ? WHERE id = ?`).run('2099-01-01T00:00:00Z', past);
    const index = new SemanticIndex(db, new Orthogonal());
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('我最近在忙什么？', null, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).toEqual([current, past]);
    expect(r.promptBlock).toContain('所述日期 2020-07-26 已过');
    const currentLine = r.promptBlock.split('\n').find((l) => l.includes(CURRENT))!;
    expect(currentLine).not.toContain('已过');
  });

  it('问到那件事本身：照样注入（当历史），并标明已过', () => {
    goal(PAST);
    const r = new ContextSelector(db).selectForQuestion('出差是怎么安排的？', null);
    expect(r.items.map((i) => i.statement)).toContain(PAST);
    expect(r.promptBlock).toContain('所述日期 2020-07-26 已过');
  });

  it('用户说还没结束：不标「已过」；确认已结束：标「用户确认已结束」', () => {
    const past = goal(PAST);
    const noDate = goal('把出差清单整理成模板');
    items.setTimeStatus(past, 'ongoing');
    items.setTimeStatus(noDate, 'ended');
    const r = new ContextSelector(db).selectForQuestion('出差的事进展如何？', null);
    const line = (text: string) => r.promptBlock.split('\n').find((l) => l.includes(text)) ?? '';
    expect(line(PAST)).not.toContain('已过');
    expect(line('把出差清单整理成模板')).toContain('用户确认已结束');
  });
});

describe('整份资料归档建议', () => {
  function source(title: string): string {
    const permissions = new PermissionService(db);
    const imports = new ImportService(
      db,
      new Vault(join(dir, 'vault')),
      permissions,
      new SourceStore(db),
    );
    const doc = join(dir, `${title}.md`);
    writeFileSync(doc, `# ${title}\n\n正文`, 'utf8');
    return imports.importFile(doc, { projectId: null, permissionId: permissions.grantFile(doc).id })
      .created[0]!.id;
  }
  function fromSource(sourceId: string, statement: string): string {
    const id = goal(statement, 'ai');
    db.prepare('UPDATE items SET extracted_from_source_id = ? WHERE id = ?').run(sourceId, id);
    return id;
  }

  it('写了日期的都已过去、还有同一件事但没写日期的：建议整份归档', () => {
    const src = source('出差行程建议');
    fromSource(src, '2020年7月25日到达并入住');
    fromSource(src, '2020年7月26日上午参加活动');
    fromSource(src, '提前确认住宿与交通'); // 没写日期，单条认不出
    const o = buildPersonalOverview(db);
    expect(o.pastSources).toEqual([
      {
        sourceId: src,
        title: '出差行程建议.md',
        lastDay: '2020-07-26',
        pastItems: 2,
        totalItems: 3,
      },
    ]);
  });

  it('只有一条过去的日期、或还有没到的日期：不建议', () => {
    const one = source('只有一条');
    fromSource(one, '2020年7月26日开业');
    fromSource(one, '出差清单');
    const mixed = source('还有后续');
    fromSource(mixed, '2020年7月25日到达');
    fromSource(mixed, '2020年7月26日开业');
    fromSource(mixed, '2099年1月1日复盘');
    expect(buildPersonalOverview(db).pastSources).toEqual([]);
  });

  it('用户说过其中一条还没结束：不建议整份归档', () => {
    const src = source('出差行程建议');
    const a = fromSource(src, '2020年7月25日到达');
    fromSource(src, '2020年7月26日开业');
    items.setTimeStatus(a, 'ongoing');
    expect(buildPersonalOverview(db).pastSources).toEqual([]);
  });

  it('IXAEON 自己的聊天存档不参与（之后还可能继续同一个对话）', () => {
    const src = source('正式系统名是什么？');
    db.prepare(`UPDATE sources SET provider = 'ask_session' WHERE id = ?`).run(src);
    fromSource(src, '2020年7月25日到达');
    fromSource(src, '2020年7月26日开业');
    expect(buildPersonalOverview(db).pastSources).toEqual([]);
  });
});
