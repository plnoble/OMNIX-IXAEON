/**
 * A1 验收（整合方写死，执行方不改）：分析失败耐心重试。
 * 委派单：docs/委派/A1-分析失败耐心重试.md
 *
 * 真机（2026-09-18）：网关断了几个小时，23 个分析任务各自在 2.5 分钟内重试 3 次后放弃，
 * 用户只能手动点「全部重新分析」；429（并发满）根本不算暂时性失败，一次就判死。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_BACKOFF_MS,
  ImportService,
  JobQueue,
  ModelError,
  OpenAIResponsesProvider,
  PermissionService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';

const HOUR = 3_600_000;
let dir: string;
let db: CoreDatabase;
let queue: JobQueue;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  queue = new JobQueue(db, { warn: () => undefined, info: () => undefined });
});

afterEach(() => {
  queue.stop();
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tick = () => (queue as unknown as { tick(): Promise<void> }).tick();

/** 让排队中的任务马上可以再跑（跳过退避等待）。 */
const due = (id: string) =>
  db.prepare('UPDATE jobs SET not_before = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);

describe('默认退避：几个小时的网关故障也扛得住', () => {
  it('至少 8 次；间隔不递减、单次不超过 1 小时；第一次 10 秒内；合计至少 4 小时', () => {
    const b = DEFAULT_RETRY_BACKOFF_MS;
    expect(b.length).toBeGreaterThanOrEqual(8);
    expect(b[0]).toBeLessThanOrEqual(10_000);
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThanOrEqual(b[i - 1]!);
    expect(Math.max(...b)).toBeLessThanOrEqual(HOUR);
    expect(b.reduce((s, x) => s + x, 0)).toBeGreaterThanOrEqual(4 * HOUR);
  });

  it('默认队列按这张表退避，用完才判失败', async () => {
    let calls = 0;
    queue.register('flaky', async () => {
      calls += 1;
      throw new ModelError('网络错误: TypeError: fetch failed', true);
    });
    const job = queue.enqueue('flaky', {});
    for (let attempt = 0; attempt < DEFAULT_RETRY_BACKOFF_MS.length; attempt++) {
      const before = Date.now();
      await tick();
      const row = queue.get(job.id)!;
      expect(row.status).toBe('queued');
      expect(row.retry_count).toBe(attempt + 1);
      const wait = new Date(row.not_before!).getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(DEFAULT_RETRY_BACKOFF_MS[attempt]! - 2_000);
      expect(wait).toBeLessThanOrEqual(DEFAULT_RETRY_BACKOFF_MS[attempt]! + 2_000);
      due(job.id);
    }
    await tick();
    expect(queue.get(job.id)!.status).toBe('failed');
    expect(calls).toBe(DEFAULT_RETRY_BACKOFF_MS.length + 1);
  });
});

describe('429（并发满、限流）算暂时性失败', () => {
  const provider = (status: number) =>
    new OpenAIResponsesProvider({
      apiKey: 'test-key',
      modelName: 'test-model',
      baseUrl: 'https://gateway.invalid/v1',
      fetchImpl: (async () => new Response('synthetic', { status })) as typeof fetch,
    });

  it('429 → 可重试的 ModelError；401 仍是不可重试', async () => {
    const limited = await provider(429)
      .chatText({ system: 's', user: 'u' })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(limited).toBeInstanceOf(ModelError);
    expect((limited as ModelError).retriable).toBe(true);
    const denied = await provider(401)
      .chatText({ system: 's', user: 'u' })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(denied).toBeInstanceOf(ModelError);
    expect((denied as ModelError).retriable).toBe(false);
  });
});

describe('启动时把因网络失败的任务重新排队', () => {
  function failed(error: string): string {
    const job = queue.enqueue('extract', { sourceId: 'synthetic' });
    db.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, retry_count = 5, not_before = ? WHERE id = ?",
    ).run(error, '2000-01-01T00:00:00.000Z', job.id);
    return job.id;
  }

  it('网络、网关、限流类失败回到排队（从头计次）；内容类、认证类失败不动', () => {
    const network = [
      failed('网络错误: TypeError: fetch failed'),
      failed('API 错误 502: <!DOCTYPE html>'),
      failed('API 错误 503: upstream unavailable'),
      failed('API 错误 429: {"error":{"message":"Concurrency limit exceeded"}}'),
    ];
    const content = failed('分析「合成资料」时，模型给的 1 条依据对不上原文');
    const auth = failed('API 错误 401: invalid key');

    expect(queue.requeueNetworkFailures()).toBe(network.length);
    for (const id of network) {
      const row = queue.get(id)!;
      expect(row.status).toBe('queued');
      expect(row.retry_count).toBe(0);
      expect(row.not_before).toBeNull();
    }
    expect(queue.get(content)!.status).toBe('failed');
    expect(queue.get(auth)!.status).toBe('failed');
    // 再调一次不会重复计数
    expect(queue.requeueNetworkFailures()).toBe(0);
  });
});

describe('资料页看得到「在等重试」', () => {
  it('来源列表带出最近一次任务的重试次数和下次时间', () => {
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, sources);
    const { source } = imports.captureAsk({
      question: '合成问题',
      answer: '合成回答',
      conversationId: 'a1-conv',
      userSeq: 1,
      assistantSeq: 2,
      engine: 'hermes',
      model: null,
      projectId: null,
      permissionId: permissions.grantDomain('ask.ixaeon.local').id,
    });
    const job = queue.enqueue('extract', { sourceId: source.id });
    const next = '2099-01-01T00:10:00.000Z';
    db.prepare(
      "UPDATE jobs SET status = 'queued', retry_count = 2, not_before = ?, error = ? WHERE id = ?",
    ).run(next, '网络错误: TypeError: fetch failed', job.id);

    const row = sources.list({ projectId: null }).find((s) => s.source.id === source.id)!;
    expect(row.analysis.lastJobStatus).toBe('queued');
    expect(row.analysis.lastJobRetryCount).toBe(2);
    expect(row.analysis.lastJobNextAt).toBe(next);
    expect(row.analysis.lastJobError).toContain('网络错误');
  });
});
