/**
 * 混合检索（本机语义 + 关键词）：三周任务单 R1/R3。
 *
 * 起因（2026-09-17 首次真机使用）：聊天预注入的记忆靠关键词两字片段匹配，
 * 「正式系统名是什么？」里的「正式」撞上了「门店正式开业」，模型对着一段毫不相干的
 * 资料作答。用户的记忆里其实没有「系统名」这一条——正确结果是一条都不注入。
 *
 * 第一部分不依赖模型（固定向量替身），任何机器都跑；
 * 第二部分用本机 Ollama + qwen3-embedding:0.6b，服务或模型不在时跳过。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContextSelector,
  ItemService,
  MEMORY_EVAL_SCENARIOS,
  OllamaEmbedder,
  ProjectService,
  SemanticIndex,
  migrate,
  normalize,
  openDatabase,
  runHybridMemoryEval,
  type CoreDatabase,
  type TextEmbedder,
} from '../../src/index.js';
import {
  conjunctSubQueries,
  isOverviewQuestion,
  localDay,
} from '../../src/memory/contextSelector.js';

let dir: string;
let db: CoreDatabase;
let items: ItemService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-hybrid-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  items = new ItemService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 个人条目，默认披露给模型（与评测语料一致的做法）。 */
function personal(statement: string, disclosed = true): string {
  const item = items.createManual({
    projectId: null,
    scope: 'personal',
    type: 'preference',
    statement,
    rationale: null,
  });
  if (disclosed) items.grantDisclosure({ itemId: item.id, audience: 'model', note: '测试披露' });
  return item.id;
}

/**
 * AI 提炼、未经确认的个人条目（真实用户的记忆几乎都是这种），已披露给模型。
 * minutesAgo 控制「最近更新」的先后。
 */
function aiPersonal(
  type: 'goal' | 'open_loop' | 'decision',
  statement: string,
  minutesAgo: number,
) {
  const id = personal(statement);
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  db.prepare(
    `UPDATE items SET type = ?, origin = 'ai', confirmation = 'none', updated_at = ? WHERE id = ?`,
  ).run(type, at, id);
  return id;
}

/** 固定向量替身：按文本查表，查不到给一个与所有查表向量都正交的方向。 */
class TableEmbedder implements TextEmbedder {
  readonly modelId = 'test:table';
  calls = 0;
  constructor(
    private readonly docs: Record<string, number[]>,
    private readonly queries: Record<string, number[]>,
    private readonly fail = false,
  ) {}
  private vec(table: Record<string, number[]>, text: string): Float32Array {
    return normalize(table[text] ?? [0, 0, 0, 1]);
  }
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.fail) throw new Error('ECONNREFUSED 127.0.0.1:11434');
    return texts.map((t) => this.vec(this.docs, t));
  }
  async embedQuery(text: string): Promise<Float32Array> {
    this.calls++;
    if (this.fail) throw new Error('ECONNREFUSED 127.0.0.1:11434');
    return this.vec(this.queries, text);
  }
}

describe('混合选材：规则（固定向量，不依赖模型）', () => {
  it('两字片段命中但语义不沾边：不入选（首次真机的「正式」→「正式开业」）', async () => {
    const opening = personal('新店定于下月初正式开业');
    const embedder = new TableEmbedder(
      { 新店定于下月初正式开业: [1, 0, 0, 0] },
      { '正式系统名是什么？': [0.2, 1, 0, 0] }, // 与开业条目相似度约 0.2
    );
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('正式系统名是什么？', null, {
      semantic: index,
    });
    expect(r.retrieval).toBe('hybrid');
    expect(r.items.map((i) => i.id)).not.toContain(opening);
    expect(r.promptBlock).toBe('');
  });

  it('对照：同一场景走关键词路径会把开业条目塞进去（证明上一条测的是真 bug）', () => {
    const opening = personal('新店定于下月初正式开业');
    const r = new ContextSelector(db).selectForQuestion('正式系统名是什么？', null);
    expect(r.items.map((i) => i.id)).toContain(opening);
  });

  it('语义相近但没有任何字面重合：入选', async () => {
    const run = personal('三个月内完成半程马拉松');
    const embedder = new TableEmbedder(
      { 三个月内完成半程马拉松: [1, 0, 0, 0] },
      { '健身的目标是什么？': [1, 0.3, 0, 0] }, // 相似度约 0.96
    );
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('健身的目标是什么？', null, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).toContain(run);
  });

  it('英文标识符精确命中：即使语义分低也入选（项目代号、文件名靠字面最准）', async () => {
    const id = personal('IXAEON 的数据库默认放在 D 盘');
    const embedder = new TableEmbedder(
      { 'IXAEON 的数据库默认放在 D 盘': [1, 0, 0, 0] },
      { 'IXAEON 在哪？': [0, 1, 0, 0] }, // 相似度 0
    );
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('IXAEON 在哪？', null, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).toContain(id);
  });

  it('权限不因有向量而放宽：未披露给模型的个人条目，再相似也不入选', async () => {
    const hidden = personal('今年学会自由泳', false);
    const embedder = new TableEmbedder(
      { 今年学会自由泳: [1, 0, 0, 0] },
      { '我今年的游泳目标？': [1, 0, 0, 0] }, // 相似度 1
    );
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('我今年的游泳目标？', null, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).not.toContain(hidden);
  });

  it('还没算向量的条目按关键词规则判断，补向量期间召回不变差', async () => {
    const id = personal('浇花只用雨水收集的水');
    const embedder = new TableEmbedder({}, {});
    const index = new SemanticIndex(db, embedder); // 故意不 backfill
    const r = await new ContextSelector(db).selectForQuestionHybrid('浇花用什么水？', null, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).toContain(id);
    expect(r.retrievalNotice).toMatch(/尚未覆盖 1 \/ 1/);
  });

  it('向量服务连不上：整体退回关键词路径，并如实说明', async () => {
    personal('回复一律用中文');
    const index = new SemanticIndex(db, new TableEmbedder({}, {}, true));
    const r = await new ContextSelector(db).selectForQuestionHybrid('回复用什么语言？', null, {
      semantic: index,
    });
    expect(r.retrieval).toBe('keyword');
    expect(r.retrievalNotice).toMatch(/语义检索暂不可用.*ECONNREFUSED/);
  });

  it('原文变了，旧向量作废，需重算', async () => {
    const id = personal('回复一律用中文');
    const embedder = new TableEmbedder({ 回复一律用中文: [1, 0, 0, 0] }, {});
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    expect(index.coverage()).toEqual({ indexed: 1, total: 1 });
    db.prepare('UPDATE items SET statement = ? WHERE id = ?').run('回复一律用英文', id);
    expect(index.coverage()).toEqual({ indexed: 0, total: 1 });
    const scored = await index.score('随便问问', [id]);
    expect(scored.has(id)).toBe(false);
  });

  it('并列问题拆分：保留共同后半句；「和平」「温和」这类词不拆', () => {
    expect(conjunctSubQueries('花园和健身哪个更急？')).toEqual([
      '花园哪个更急？',
      '健身哪个更急？',
    ]);
    expect(conjunctSubQueries('个人助手和桌面问答有什么共同点？')).toEqual([
      '个人助手有什么共同点？',
      '桌面问答有什么共同点？',
    ]);
    expect(conjunctSubQueries('和平的意义是什么？')).toEqual([]);
    expect(conjunctSubQueries('温和一点的回复')).toEqual([]);
    expect(conjunctSubQueries('今天天气怎么样？')).toEqual([]);
  });

  it('概览问题：记忆全是 AI 提炼、未确认的，也给出目标与待办（最近的在前），不带别的类型', async () => {
    // 首次真机后在用户资料副本上复查：「我最近在忙什么」与每条记忆的相似度都只有 0.33–0.37，
    // 而原兜底只认已确认目标，65 条里一条都没有 → 一条记忆都没给模型。
    const goal = aiPersonal('goal', '把周报汇总流程跑通', 60);
    const loop = aiPersonal('open_loop', '还没定报告模板', 5);
    aiPersonal('decision', '数据库用 SQLite', 1);
    const embedder = new TableEmbedder(
      {
        把周报汇总流程跑通: [1, 0, 0, 0],
        还没定报告模板: [0, 1, 0, 0],
        '数据库用 SQLite': [0, 0, 1, 0],
      },
      {}, // 问句查不到 → 与三条都正交，语义上一条都不相关
    );
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const selector = new ContextSelector(db);
    for (const q of ['我最近在忙什么？', '我现在手上有哪些事？', '我的目标是什么？']) {
      const r = await selector.selectForQuestionHybrid(q, null, { semantic: index });
      expect(
        r.items.map((i) => i.id),
        q,
      ).toEqual([loop, goal]);
    }
  });

  it('只是字面带「目标」「计划」的问题：未确认的 AI 目标不注入', async () => {
    aiPersonal('goal', '把周报汇总流程跑通', 60);
    const embedder = new TableEmbedder({ 把周报汇总流程跑通: [1, 0, 0, 0] }, {});
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const selector = new ContextSelector(db);
    for (const q of ['什么是目标检测算法？', '帮我制定一个健身计划', '目前的汇率是多少？']) {
      const r = await selector.selectForQuestionHybrid(q, null, { semantic: index });
      expect(r.items, q).toEqual([]);
    }
  });

  it('注入给模型的每条记忆都带「记于」日期，段首写明今天（2026-09-18 真机回归）', async () => {
    // 真机：7 月的门店开业筹备被当成「当前核心主线」答出来。条目不带时间、类型是
    // goal，模型只能当成现在的目标。记录日期是记下它的日子，不是事情发生的日子。
    const id = aiPersonal('goal', '把周报汇总流程跑通', 60);
    db.prepare('UPDATE items SET observed_at = ? WHERE id = ?').run('2026-07-20T02:00:00.000Z', id);
    const embedder = new TableEmbedder(
      { 把周报汇总流程跑通: [1, 0, 0, 0] },
      { '我最近在忙什么？': [0, 0, 0, 1] },
    );
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('我最近在忙什么？', null, {
      semantic: index,
    });
    expect(r.items[0]?.recordedAt).toBe('2026-07-20T02:00:00.000Z');
    expect(r.promptBlock).toContain(`记于 ${localDay('2026-07-20T02:00:00.000Z')}`);
    expect(r.promptBlock).toContain(`今天 ${localDay(new Date())}`);
    // 关键词路径同样带（两条路径共用一个格式化函数）
    const k = new ContextSelector(db).selectForQuestion('周报汇总怎么弄？', null);
    expect(k.promptBlock).toContain('记于 ');
  });

  it('概览问题的判定从严', () => {
    for (const q of [
      '我最近在忙什么？',
      '我这段时间都在做些什么',
      '我现在手上有哪些事？',
      '我手头还有什么事没做完？',
      '我的目标是什么？',
      '我最近的计划有哪些？',
      '我接下来该做什么？',
      '你了解我吗？',
      '你对我了解多少？',
    ]) {
      expect(isOverviewQuestion(q), q).toBe(true);
    }
    for (const q of [
      '什么是目标检测算法？',
      '我的目标检测模型精度不高怎么办？',
      '我想做红烧肉，怎么做？',
      '我想做什么菜比较好？',
      '我在做什么样的饭比较好',
      '我手上的伤怎么处理？',
      '帮我制定一个健身计划',
      '你知道我叫什么吗？',
      '你能理解我的感受吗？',
      '他最近在忙什么？',
      '正式系统名是什么？',
    ]) {
      expect(isOverviewQuestion(q), q).toBe(false);
    }
  });

  it('向量服务只允许本机地址（记忆文本不能经此离开电脑）', () => {
    expect(() => new OllamaEmbedder({ model: 'x', baseUrl: 'http://203.0.113.10:11434' })).toThrow(
      /只能是本机地址/,
    );
    expect(
      () => new OllamaEmbedder({ model: 'x', baseUrl: 'http://127.0.0.1:11434' }),
    ).not.toThrow();
    expect(
      () => new OllamaEmbedder({ model: 'x', baseUrl: 'http://localhost:11434/' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 第二部分：本机真实模型
// ---------------------------------------------------------------------------

const MODEL = 'qwen3-embedding:0.6b';

async function realModelReady(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).some((m) => m.name === MODEL);
  } catch {
    return false;
  }
}

const ready = await realModelReady();

describe.skipIf(!ready)(`混合选材：本机真实模型（${MODEL}）`, () => {
  const embedder = () => new OllamaEmbedder({ model: MODEL });

  it('60 个记忆评测场景全过，无关题一条记忆都不选', async () => {
    const report = await runHybridMemoryEval(db, new SemanticIndex(db, embedder()));
    const failures = report.categories.flatMap((c) => c.failures);
    expect(failures).toEqual([]);
    const unrelated = MEMORY_EVAL_SCENARIOS.filter((s) => s.category === 'unrelated_topic');
    for (const s of unrelated) expect(report.selections[s.id]).toEqual([]);
  }, 300_000);

  it('首次真机回归：记忆里没有「系统名」时，一条都不注入（不再拿开业资料凑数）', async () => {
    personal('新店定于下月初上午十点正式开业');
    personal('开业当天的接待行程和人员安排');
    personal('回复一律用中文');
    const index = new SemanticIndex(db, embedder());
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('正式系统名是什么？', null, {
      semantic: index,
    });
    expect(r.retrieval).toBe('hybrid');
    expect(r.items.map((i) => i.statement)).toEqual([]);
  }, 120_000);

  it('首次真机回归：记忆里有「系统名」时，只取它，不带开业资料', async () => {
    personal('新店定于下月初上午十点正式开业');
    const name = personal('正式系统名是 IXAEON，中文名析衍');
    const index = new SemanticIndex(db, embedder());
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('正式系统名是什么？', null, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).toEqual([name]);
  }, 120_000);

  it('「什么」这类高频字不再把无关条目带进来', async () => {
    personal('还没想好用什么数据库');
    personal('周三下午去看牙');
    const index = new SemanticIndex(db, embedder());
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('今晚吃什么？', null, {
      semantic: index,
    });
    expect(r.items).toEqual([]);
  }, 120_000);

  it('项目视角的权限与隔离不变：别的项目的条目不会因为语义相近被取到', async () => {
    const projects = new ProjectService(db);
    const a = projects.create({ name: '跑步计划', rootPath: null, description: null });
    const b = projects.create({ name: '花园', rootPath: null, description: null });
    const run = items.createManual({
      projectId: a.id,
      type: 'goal',
      statement: '三个月内完成半程马拉松',
      rationale: null,
    });
    const index = new SemanticIndex(db, embedder());
    await index.backfill();
    const r = await new ContextSelector(db).selectForQuestionHybrid('健身的目标是什么？', b.id, {
      semantic: index,
    });
    expect(r.items.map((i) => i.id)).not.toContain(run.id);
  }, 120_000);
});
