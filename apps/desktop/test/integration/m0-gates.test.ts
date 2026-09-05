import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  FakeProvider,
  JobQueue,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  ImportService,
  ItemService,
  migrate,
  openDatabase,
  sha256,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, type AppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { LocalServer } from '../../src/main/server/localServer.js';

/**
 * v0.1.1 M0 门槛测试（计划 M0 验收）：
 * 1. 新版本到达时任务正在运行 → 完成后识别滞后并补最新版本分析；
 * 2. 窗口内退出重启 → 持久化版本差让重启后找回未完成工作；
 * 3. 取消后模型返回 → 不发新块、不提交结果、旧理解不变、analyzed 不推进；
 * 4. 恢复失败保留待处理状态（版本差持久存在）。
 */

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

const dbs: CoreDatabase[] = [];
const queues: JobQueue[] = [];

const servers: FastifyInstance[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const queue of queues.splice(0)) queue.stop();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  vi.restoreAllMocks();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-m0-gate-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  dbs.push(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const projects = new ProjectService(db);
  const project = projects.create({ name: 'm0', rootPath: null, description: null });
  const file = join(dir, 'seed.md');
  writeFileSync(file, `# M0 门槛\n\n${'GATE_SEED_'.repeat(30)}\n`, 'utf8');
  const created = new ImportService(db, vault, permissions, sources).importFile(file, {
    projectId: project.id,
    permissionId: permissions.grantFile(file).id,
  }).created[0]!;
  let config: AppConfig = {
    ...defaultAppConfig(),
    localToken: 'm0-local-token',
  };
  config.capture.enabled = true;
  config.capture.autoAnalyze = true;
  config.extension = { token: 'm0-ext-token', pairedAt: new Date().toISOString() };
  permissions.grantDomain('chatgpt.com');
  const onCaptured = vi.fn();
  const onConversationResumed = vi.fn();
  const localServer = new LocalServer({
    db,
    vault,
    permissions,
    sources,
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    onCaptured,
    onConversationResumed,
  });
  const http = Fastify();
  servers.push(http);
  await localServer.register(http);
  await http.ready();
  const capture = (externalId: string, texts: string[]) =>
    http.inject({
      method: 'POST',
      url: '/api/extension/capture',
      headers: {
        authorization: 'Bearer m0-ext-token',
        origin: 'chrome-extension://m0',
      },
      payload: {
        conversation: { externalId, sessionId: 'm0-session-00001', title: 'ChatGPT' },
        clientTimestamp: new Date().toISOString(),
        turns: texts.map((text, order) => ({
          order,
          role: order % 2 === 0 ? 'user' : 'assistant',
          text,
          contentHash: sha256(text),
        })),
      },
    });
  return {
    http,
    capture,
    dir,
    db,
    vault,
    permissions,
    sources,
    project,
    source: created,
    items: new ItemService(db),
    getConfig: () => config,
    onCaptured,
    onConversationResumed,
    localServer,
  };
}

function runtimeFor(f: Awaited<ReturnType<typeof fixture>>) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this;
    },
  };
  const jobs = new JobQueue(f.db, logger);
  queues.push(jobs);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    ...f,
    dataDir: f.dir,
    configFile: join(f.dir, 'config.json'),
    config: f.getConfig(),
    logger,
    jobs,
    stopServer: vi.fn(async () => {}),
    startServer: vi.fn(async () => {}),
  });
  (runtime as unknown as { registerJobHandlers(): void }).registerJobHandlers();
  return runtime;
}

async function tick(queue: JobQueue): Promise<void> {
  await (queue as unknown as { tick(): Promise<void> }).tick();
}

it('门槛 1：新版本在任务运行期间到达 → 完成后识别滞后并补最新版本分析', async () => {
  const f = await fixture();
  const runtime = runtimeFor(f);
  const provider = new FakeProvider('m0-lag');
  provider.enqueueStructured({ items: [] });
  provider.enqueueStructured({ items: [] });
  provider.enqueueStructured({ items: [] });
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  const orig = provider.chatStructured.bind(provider);
  vi.spyOn(provider, 'chatStructured').mockImplementation(async (input) => {
    const result = await orig(input);
    // 任务正在运行（第一块之后）：新内容到达，content_revision 递增
    if (provider.structuredCalls.length === 1) {
      f.sources.appendCapturedTurns(f.source.id, [
        { order: 10, role: 'user', text: '运行期间到达的新版本 LATE_REVISION' },
      ]);
    }
    return result;
  });

  const job = runtime.jobs.enqueue('extract', { sourceId: f.source.id, auto: true });
  await tick(runtime.jobs);
  // 第一次完成：analyzed = 目标版本 1，滞后于 content 2 → 自动补队
  const afterFirst = f.sources.getRevisions(f.source.id);
  expect(afterFirst.content).toBe(2);
  expect(afterFirst.analyzed).toBe(1);
  await tick(runtime.jobs);
  // 补分析读取最新版本 2 → 追平
  expect(f.sources.getRevisions(f.source.id)).toEqual({ content: 2, analyzed: 2 });
  expect(runtime.jobs.get(job.id)!.status).toBe('succeeded');
  // 首次提取 1 块 + 补分析把新旧片段合并为 1 块 → 共 2 次模型调用
  expect(provider.structuredCalls.length).toBe(2);
});

it('门槛 2：窗口内退出重启 → 持久化版本差让重启后找回未完成工作', async () => {
  const f = await fixture();
  // 「旧进程」：采集入库（content 2 / analyzed 0），未及分析即退出
  const captureResult = await f.capture('/c/gate-restart-001', ['问题一', '回答一']);
  expect(captureResult.statusCode).toBe(200);
  const capturedSourceId = captureResult.json().sourceId;
  const revisionsAtExit = f.sources.getRevisions(capturedSourceId);
  expect(revisionsAtExit.content).toBe(2);
  expect(revisionsAtExit.analyzed).toBe(0);
  // 旧进程退出：队列里没有任何可恢复任务（内存状态全部丢失）
  expect(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='queued'").get()).toEqual({ n: 0 });

  // 「新进程」：同一数据库，全新运行时（provider 先就绪：sweep 会立即 kick 队列）
  const runtime = runtimeFor(f);
  const provider = new FakeProvider('m0-restart');
  provider.enqueueStructured({ items: [] });
  vi.spyOn(runtime, 'getProvider').mockReturnValue(provider);
  // sweep 找回未完成工作并立即 kick 执行（provider 已就绪）→ 分析追平最新版本
  const enqueuedCount = runtime.sweepPendingAnalysis();
  expect(enqueuedCount).toBeGreaterThanOrEqual(1);
  await runtime.jobs.idle(); // kick 是异步执行，等待在途任务完成
  const afterSweep = f.sources.getRevisions(capturedSourceId);
  expect(afterSweep).toEqual({ content: 2, analyzed: 2 });
  // 本次重启期间为该来源入队过的提取任务存在（succeeded = 已被 kick 执行完成）
  const processed = f.db
    .prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE kind='extract' AND status='succeeded' AND payload_json LIKE ?",
    )
    .get(`%"sourceId":"${capturedSourceId}"%`) as { n: number };
  expect(processed.n).toBeGreaterThanOrEqual(1);
});

it('门槛 3：取消后模型返回 → 不发新块、不提交结果、旧理解与 analyzed 不变', async () => {
  const f = await fixture();
  const runtime = runtimeFor(f);
  // 两块长文（>8000 字符），保证「多块提取间取消」可被触发
  const longFile = join(f.dir, 'gate3-long.md');
  const gate3Seed = ['# 门槛3', '', 'CANCEL_GATE_LONG_'.repeat(1200)].join('\n');
  writeFileSync(longFile, gate3Seed, 'utf8');
  const longSource = new ImportService(f.db, f.vault, f.permissions, f.sources).importFile(
    longFile,
    {
      projectId: f.project.id,
      permissionId: f.permissions.grantFile(longFile).id,
    },
  ).created[0]!;
  // 先建立一次成功理解（analyzed 推进到 1）
  const seeded = new FakeProvider('m0-seed');
  seeded.enqueueStructured({ items: [] });
  seeded.enqueueStructured({ items: [] });
  vi.spyOn(runtime, 'getProvider').mockReturnValue(seeded);
  await tick(runtime.jobs);
  const baselineItems = f.items.list({ projectId: f.project.id }).map((x) => x.id);
  const revisionsAfterSeed = f.sources.getRevisions(longSource.id);

  // 重新提取：两块；第一块返回后关闭自动分析 → 第二块前取消
  const reextract = new FakeProvider('m0-cancel');
  reextract.enqueueStructured({ items: [] });
  reextract.enqueueStructured({ items: [] });
  const orig = reextract.chatStructured.bind(reextract);
  vi.spyOn(runtime, 'getProvider').mockReturnValue(reextract);
  vi.spyOn(reextract, 'chatStructured').mockImplementation(async (input) => {
    const result = await orig(input);
    if (reextract.structuredCalls.length === 1) {
      f.getConfig().capture.autoAnalyze = false; // 执行期间开关变化
    }
    return result;
  });
  const job = runtime.jobs.enqueue('extract', { sourceId: longSource.id, auto: true });
  await tick(runtime.jobs);

  expect(reextract.structuredCalls.length).toBe(1); // 不发新块
  expect(runtime.jobs.get(job.id)!.status).toBe('cancelled'); // 取消可见
  // 旧理解保持不变、analyzed_revision 未推进
  expect(f.items.list({ projectId: f.project.id }).map((x) => x.id)).toEqual(baselineItems);
  expect(f.sources.getRevisions(longSource.id)).toEqual(revisionsAfterSeed);
});

it('门槛 4：恢复被拒绝后，「欠分析」的版本差持久保留', async () => {
  const f = await fixture();
  const runtime = runtimeFor(f);
  // 采集两批：content 2 / analyzed 0（第二批在防抖窗口内，pending 等待补分析）
  const firstCapture = await f.capture('/c/gate-restore-001', ['问题一', '回答一']);
  expect(firstCapture.statusCode).toBe(200);
  const capturedSourceId = firstCapture.json().sourceId;
  expect(
    (await f.capture('/c/gate-restore-001', ['问题一', '回答一', '新回答 GATE_PENDING']))
      .statusCode,
  ).toBe(200);
  const before = f.sources.getRevisions(capturedSourceId);
  // 初次插入 1 + 追加 1 → content 3；尚未分析 → analyzed 0（持久化欠分析状态）
  expect(before).toEqual({ content: 3, analyzed: 0 });

  await expect(runtime.restoreData('invalid-review-token')).rejects.toThrow('恢复凭证无效');

  // 待处理状态以持久化版本差表达，不依赖内存计时器
  const after = f.sources.getRevisions(capturedSourceId);
  expect(after).toEqual(before);
  expect(after.content).toBeGreaterThan(after.analyzed);

  // 重启后 sweep 找回未完成工作（provider 先就绪：sweep 会立即 kick 队列）
  const restarted = runtimeFor(f);
  const restartProvider = new FakeProvider('m0-restart-sweep');
  restartProvider.enqueueStructured({ items: [] });
  vi.spyOn(restarted, 'getProvider').mockReturnValue(restartProvider);
  restarted.sweepPendingAnalysis();
  await restarted.jobs.idle(); // 等 kick 的在途任务完成
  // 重启后欠分析工作被找回并追平最新版本
  expect(f.sources.getRevisions(capturedSourceId)).toEqual({ content: 3, analyzed: 3 });
});
