/**
 * X1 验收（v2 规格：执行方按规格条件写成测试；本单 B 档先只交测试）：
 * docs/委派/X1-提炼打捞依据.md
 *
 * 条件 1：模型的摘录把原文里两处拼在一起（中间夹了别的字）：打捞出其中最长的
 *          连续一段入库；入库的 excerpt 与原文逐字相同（含原来的换行），不是模型给的串。
 * 条件 2：摘录整段都不在原文里（模型自己编的）：打捞不到，这条仍然不入库。
 * 条件 3：打捞出的最长一段规范化后不足 15 字：算无效依据，不入库。
 * 条件 4：一份资料 3 条结论：2 条靠打捞、1 条是编的 → 入库 2 条，丢 1 条，任务成功；
 *          审计里 salvaged=2、dropped=1。
 * 条件 5：全部结论都打捞不到 → 整份作废，旧理解不变。
 * 条件 6：EXTRACT_SYSTEM_PROMPT 含规格那句；EXTRACT_PROMPT_VERSION === 'v6'。
 * 条件 7：requeueFailedExtractions：只排因依据问题失败的来源，每个来源一个任务；
 *          网络、限流失败的不动；返回值等于实际排的个数。
 *
 * 新符号尚未实现：用运行时取，不静态导入，免得 typecheck 把先交的测试挡掉。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM_PROMPT,
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  JobQueue,
  PermissionService,
  SourceStore,
  Vault,
  listAuditEvents,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';
import * as core from '../../src/index.js';

const SALVAGE_SENTENCE =
  '摘录必须从原文里逐字复制**连续的一段**：不要跨行拼接、不要改写、不要把两处并成一句。找不到能逐字复制的一段，就不要给这条结论。';

/** 原文两处不连续：中间夹着「预算先不考虑。」；第一处原文自带换行。 */
const LONG_A = '我想换一台内存大、\n能跑本地大模型的手机。';
const LONG_A_FLAT = '我想换一台内存大、能跑本地大模型的手机。';
const LONG_B = '至少 16GB 内存，能装 Qwen。';
const GAP = '预算先不考虑。';
const BODY = `${LONG_A}\n${GAP}\n${LONG_B}`; // 同一段（没有空行），S2
const SPLICED = `${LONG_A_FLAT}${LONG_B}`; // 规范化后不是原文子串

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let permissions: PermissionService;
let sources: SourceStore;
let imports: ImportService;
let items: ItemService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-x1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  permissions = new PermissionService(db);
  sources = new SourceStore(db);
  imports = new ImportService(db, vault, permissions, sources);
  items = new ItemService(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function groundExcerptInSegment(excerpt: string, segmentText: string): string | null {
  const fn = (core as Record<string, unknown>)['groundExcerptInSegment'];
  if (typeof fn !== 'function') throw new Error('尚未实现 groundExcerptInSegment');
  return (fn as (a: string, b: string) => string | null)(excerpt, segmentText);
}

function requeueFailedExtractions(database: CoreDatabase): number {
  const fn = (core as Record<string, unknown>)['requeueFailedExtractions'];
  if (typeof fn !== 'function') throw new Error('尚未实现 requeueFailedExtractions');
  return (fn as (d: CoreDatabase) => number)(database);
}

function seedDoc(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `# X1 合成\n\n${body}`, 'utf8');
  const result = imports.importFile(path, {
    projectId: null,
    permissionId: permissions.grantFile(path).id,
  });
  return result.created[0]!.id;
}

function item(excerpt: string, statement: string) {
  return {
    type: 'goal' as const,
    statement,
    rationale: null,
    confidence: 0.8,
    segment_ref: 'S2',
    project_hint: null,
    excerpt,
  };
}

/** 有问题会自动再跑一轮，两次都给同样的输出。 */
function extractorWith(itemsOnce: ReturnType<typeof item>[]): Extractor {
  const fake = new FakeProvider('fake-x1');
  const payload = { items: itemsOnce };
  fake.enqueueStructured(payload).enqueueStructured(payload);
  return new Extractor(db, fake);
}

it('条件 1：拼接摘录打捞出最长连续一段，入库 excerpt 与原文逐字相同', async () => {
  const sourceId = seedDoc('splice.md', BODY);
  expect(groundExcerptInSegment(SPLICED, BODY)).toBe(LONG_A);
  expect(LONG_A).toContain('\n');

  const stats = await extractorWith([item(SPLICED, '想换能跑本地大模型的手机')]).extractSource(
    sourceId,
  );
  expect(stats.inserted).toBe(1);
  const rows = items.list({ projectId: null, state: 'current' });
  const found = rows.find((r) => r.statement === '想换能跑本地大模型的手机');
  expect(found).toBeDefined();
  const evidence = items.getEvidence(found!.id);
  expect(evidence[0]!.excerpt).toBe(LONG_A);
  expect(evidence[0]!.excerpt).not.toBe(SPLICED);
  expect(evidence[0]!.excerpt).not.toBe(LONG_A_FLAT);
  expect(BODY).toContain(evidence[0]!.excerpt);
});

it('条件 2：整段都是编的，打捞不到，不入库', async () => {
  const sourceId = seedDoc('made-up.md', BODY);
  const madeUp = '这是模型自己编的一段话，原文里根本没有。';
  expect(groundExcerptInSegment(madeUp, BODY)).toBeNull();

  await expect(
    extractorWith([item(madeUp, '编出来的结论')]).extractSource(sourceId),
  ).rejects.toThrow(/依据对不上原文/);
  expect(items.list({ projectId: null, state: 'current' })).toHaveLength(0);
});

it('条件 3：打捞出的最长一段规范化后不足 15 字，不入库', async () => {
  // 同一段、中间夹非空白字；各连续段规范化后都不足 15 字
  const shortBody = '短句甲。预算先不考虑。短句乙。';
  const sourceId = seedDoc('short.md', shortBody);
  const splicedShort = '短句甲。短句乙。';
  expect(groundExcerptInSegment(splicedShort, shortBody)).toBeNull();

  await expect(
    extractorWith([item(splicedShort, '太短的依据')]).extractSource(sourceId),
  ).rejects.toThrow(/依据对不上原文/);
  expect(items.list({ projectId: null, state: 'current' })).toHaveLength(0);
});

it('条件 4：3 条里 2 条靠打捞、1 条编的 → 入库 2、丢 1，任务成功，审计 salvaged=2 dropped=1', async () => {
  const sourceId = seedDoc('three.md', BODY);
  const stats = await extractorWith([
    item(SPLICED, '结论甲：打捞成功'),
    item(`${LONG_B}和一段原文没有的尾巴`, '结论乙：打捞成功'),
    item('这是模型自己编的一段话，原文里根本没有。', '结论丙：编的'),
  ]).extractSource(sourceId);

  expect(stats.inserted).toBe(2);
  const rows = items.list({ projectId: null, state: 'current' });
  expect(rows.map((r) => r.statement).sort()).toEqual(['结论甲：打捞成功', '结论乙：打捞成功']);
  expect(rows.some((r) => r.statement === '结论丙：编的')).toBe(false);

  const salvage = listAuditEvents(db).find((e) => e.kind === 'extract.excerpt_salvaged');
  expect(salvage).toBeDefined();
  const detail = JSON.parse(salvage!.detail_json) as {
    sourceId: string;
    salvaged: number;
    dropped: number;
  };
  expect(detail.sourceId).toBe(sourceId);
  expect(detail.salvaged).toBe(2);
  expect(detail.dropped).toBe(1);
});

it('条件 5：全部打捞不到 → 整份作废，旧理解不变', async () => {
  const sourceId = seedDoc('keep-old.md', BODY);
  await extractorWith([item(LONG_A_FLAT, '有效旧结论')]).extractSource(sourceId);
  const before = items.list({ projectId: null, state: 'current' }).map((x) => x.id);
  expect(before.length).toBe(1);

  await expect(
    extractorWith([
      item('这是模型自己编的一段话，原文里根本没有。', '新的编造甲'),
      item('另一段完全编出来的话也不在原文。', '新的编造乙'),
    ]).extractSource(sourceId),
  ).rejects.toThrow(/依据对不上原文/);

  const after = items.list({ projectId: null, state: 'current' });
  expect(after.map((x) => x.id)).toEqual(before);
  expect(after[0]!.statement).toBe('有效旧结论');
});

it('条件 6：系统提示词含规格那句，版本是 v6', () => {
  expect(EXTRACT_PROMPT_VERSION).toBe('v6');
  expect(EXTRACT_SYSTEM_PROMPT).toContain(SALVAGE_SENTENCE);
});

it('条件 7：只排因依据问题失败的来源，每个来源一个；网络/限流不动；返回值等于排的个数', () => {
  const queue = new JobQueue(db, { warn: () => undefined, info: () => undefined });
  const insert = (
    sourceId: string,
    error: string,
    createdAt: string,
    status: 'failed' | 'succeeded' = 'failed',
  ) => {
    db.prepare(
      `INSERT INTO jobs (id, kind, status, payload_json, progress, error, retry_count, created_at, updated_at)
       VALUES (?, 'extract', ?, ?, 0, ?, 3, ?, ?)`,
    ).run(crypto.randomUUID(), status, JSON.stringify({ sourceId }), error, createdAt, createdAt);
  };

  insert('src-a', '更早一次也依据对不上原文', '2026-09-18T00:00:00.000Z');
  insert(
    'src-a',
    '分析「甲」时，模型给的 3 条依据对不上原文，所以这次没有改理解',
    '2026-09-20T00:00:00.000Z',
  );
  insert('src-b', '无效引用/依据：摘录对不上', '2026-09-20T00:00:00.000Z');
  insert('src-c', '网络错误: TypeError: fetch failed', '2026-09-20T00:00:00.000Z');
  insert('src-d', 'API 错误 429 Too Many Requests', '2026-09-20T00:00:00.000Z');
  insert('src-e', '依据对不上原文', '2026-09-19T00:00:00.000Z', 'succeeded');

  const n = requeueFailedExtractions(db);
  expect(n).toBe(2);

  const queued = db
    .prepare("SELECT payload_json, status FROM jobs WHERE status = 'queued'")
    .all() as Array<{ payload_json: string; status: string }>;
  const ids = queued.map((r) => JSON.parse(r.payload_json).sourceId as string).sort();
  expect(ids).toEqual(['src-a', 'src-b']);
  expect(queued).toHaveLength(2);

  const stillFailed = db
    .prepare("SELECT payload_json, error FROM jobs WHERE status = 'failed'")
    .all() as Array<{ payload_json: string; error: string }>;
  const failedSources = stillFailed.map((r) => JSON.parse(r.payload_json).sourceId as string);
  expect(failedSources).toContain('src-c');
  expect(failedSources).toContain('src-d');
  expect(
    stillFailed.some(
      (r) => JSON.parse(r.payload_json).sourceId === 'src-a' && r.error.includes('更早一次'),
    ),
  ).toBe(true);
  queue.stop();
});
