/**
 * R2：语义索引状态、重建、提取成功后立刻补向量。
 * 假向量服务（固定表），不连本机 Ollama。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeProvider,
  ImportService,
  ItemService,
  JobQueue,
  PermissionService,
  ProjectService,
  SemanticIndex,
  SourceStore,
  Vault,
  migrate,
  normalize,
  openDatabase,
  type CoreDatabase,
  type TextEmbedder,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

class TableEmbedder implements TextEmbedder {
  readonly modelId: string;
  fail = false;
  calls = 0;
  constructor(
    modelId: string,
    private readonly docs: Record<string, number[]>,
  ) {
    this.modelId = modelId;
  }
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.fail) throw new Error('连不上本机向量服务（Ollama 是否在运行？）');
    return texts.map((t) => normalize(this.docs[t] ?? [1, 0, 0, 0]));
  }
  async embedQuery(text: string): Promise<Float32Array> {
    this.calls++;
    if (this.fail) throw new Error('连不上本机向量服务（Ollama 是否在运行？）');
    return normalize(this.docs[text] ?? [1, 0, 0, 0]);
  }
}

let dir: string;
let db: CoreDatabase;
const prevEmbed = process.env.IXAEON_EMBED_MODEL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-r2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (prevEmbed === undefined) delete process.env.IXAEON_EMBED_MODEL;
  else process.env.IXAEON_EMBED_MODEL = prevEmbed;
  if (db.open) db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

function makeRuntime(index: SemanticIndex | null): AppRuntime {
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    semanticIndex: index,
    semanticBackfillRun: null,
    semanticUnavailableLogged: false,
    semanticLastError: null,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return runtime;
}

describe('R2 语义索引状态与重建', () => {
  it('getSemanticIndexStatus 的 indexed/total 与实际一致', async () => {
    const items = new ItemService(db);
    const a = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '喜欢绿茶',
      rationale: null,
    });
    items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '不喝咖啡',
      rationale: null,
    });
    const embedder = new TableEmbedder('test:r2', { 喜欢绿茶: [1, 0, 0, 0] });
    const index = new SemanticIndex(db, embedder);
    await index.backfill({ limit: 1 });
    const runtime = makeRuntime(index);
    const status = runtime.getSemanticIndexStatus();
    expect(status.enabled).toBe(true);
    expect(status.model).toBe('test:r2');
    expect(status.indexed).toBe(index.coverage().indexed);
    expect(status.total).toBe(index.coverage().total);
    expect(status.total).toBe(2);
    expect(status.indexed).toBe(1);
    expect(status.lastError).toBeNull();
    void a;
  });

  it('重建后当前模型向量全部重算，另一个模型名下的行数不变', async () => {
    const items = new ItemService(db);
    const item = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '喜欢绿茶',
      rationale: null,
    });
    db.prepare(
      `INSERT INTO item_embeddings (item_id, model, text_hash, dim, vector, created_at)
       VALUES (?, 'other:x', 'old', 4, ?, ?)`,
    ).run(item.id, Buffer.from(new Float32Array([0, 1, 0, 0]).buffer), new Date().toISOString());
    const embedder = new TableEmbedder('test:r2', { 喜欢绿茶: [1, 0, 0, 0] });
    const index = new SemanticIndex(db, embedder);
    const runtime = makeRuntime(index);
    const otherBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM item_embeddings WHERE model = 'other:x'`).get() as {
        n: number;
      }
    ).n;
    const rebuilt = await runtime.rebuildSemanticIndex();
    expect(rebuilt.embedded).toBe(1);
    expect(rebuilt.remaining).toBe(0);
    const current = (
      db.prepare(`SELECT COUNT(*) AS n FROM item_embeddings WHERE model = 'test:r2'`).get() as {
        n: number;
      }
    ).n;
    const otherAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM item_embeddings WHERE model = 'other:x'`).get() as {
        n: number;
      }
    ).n;
    expect(current).toBe(1);
    expect(otherAfter).toBe(otherBefore);
  });

  it('向量服务不可用时点重建：报错，原有向量一条不删（不能删光了却补不回来）', async () => {
    const items = new ItemService(db);
    items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '喜欢绿茶',
      rationale: null,
    });
    const embedder = new TableEmbedder('test:r2', { 喜欢绿茶: [1, 0, 0, 0] });
    const index = new SemanticIndex(db, embedder);
    await index.backfill();
    const count = () =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM item_embeddings WHERE model = 'test:r2'`).get() as {
          n: number;
        }
      ).n;
    expect(count()).toBe(1);
    embedder.fail = true; // Ollama 没开
    const runtime = makeRuntime(index);
    await expect(runtime.rebuildSemanticIndex()).rejects.toThrow(/连不上本机向量服务/);
    expect(count()).toBe(1);
    expect(runtime.getSemanticIndexStatus().lastError).toMatch(/连不上本机向量服务/);
  });

  it('向量服务抛错时 lastError 有中文原因，下次成功后变回 null', async () => {
    const items = new ItemService(db);
    items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'preference',
      statement: '喜欢绿茶',
      rationale: null,
    });
    const embedder = new TableEmbedder('test:r2', { 喜欢绿茶: [1, 0, 0, 0] });
    embedder.fail = true;
    const runtime = makeRuntime(new SemanticIndex(db, embedder));
    await runtime.kickSemanticBackfill();
    const failed = runtime.getSemanticIndexStatus();
    expect(failed.lastError).toContain('连不上本机向量服务');
    embedder.fail = false;
    await runtime.kickSemanticBackfill();
    expect(runtime.getSemanticIndexStatus().lastError).toBeNull();
  });

  it('提取任务成功后会触发补向量', async () => {
    const vault = new Vault(join(dir, 'vault'));
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const projects = new ProjectService(db);
    const project = projects.create({ name: 'r2', rootPath: null, description: null });
    const file = join(dir, 'seed.md');
    writeFileSync(file, '# 笔记\n\n喜欢绿茶，每天一杯。\n', 'utf8');
    const created = new ImportService(db, vault, permissions, sources).importFile(file, {
      projectId: project.id,
      permissionId: permissions.grantFile(file).id,
    }).created[0]!;
    const jobs = new JobQueue(db, { info: () => undefined, warn: () => undefined });
    const embedder = new TableEmbedder('test:r2', {});
    const provider = new FakeProvider('r2-extract');
    provider.enqueueStructured({ items: [] });
    const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
    Object.assign(runtime, {
      db,
      sources,
      jobs,
      semanticIndex: new SemanticIndex(db, embedder),
      semanticBackfillRun: null,
      semanticUnavailableLogged: false,
      semanticLastError: null,
      logger: { info: () => undefined, warn: () => undefined },
      getProvider: () => provider,
      getConfig: () => ({
        capture: { autoAnalyze: true, enabled: true, pausedConversations: [] },
      }),
    });
    (runtime as unknown as { registerJobHandlers(): void }).registerJobHandlers();
    const kick = vi.spyOn(runtime, 'kickSemanticBackfill');
    const job = runtime.jobs.enqueue('extract', { sourceId: created.id });
    await (jobs as unknown as { tick(): Promise<void> }).tick();
    expect(runtime.jobs.get(job.id)?.status, runtime.jobs.get(job.id)?.error ?? '').toBe(
      'succeeded',
    );
    expect(kick).toHaveBeenCalled();
    jobs.stop();
  });

  it('IXAEON_EMBED_MODEL=none 时 enabled:false，重建返回 0 且不报错', async () => {
    process.env.IXAEON_EMBED_MODEL = 'none';
    const runtime = makeRuntime(null);
    const status = runtime.getSemanticIndexStatus();
    expect(status).toEqual({
      enabled: false,
      model: null,
      indexed: 0,
      total: 0,
      lastError: null,
    });
    await expect(runtime.rebuildSemanticIndex()).resolves.toEqual({ embedded: 0, remaining: 0 });
  });
});
