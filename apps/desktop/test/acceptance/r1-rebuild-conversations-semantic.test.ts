/**
 * R1 验收（v2 规格：执行方按规格条件写成测试，条件逐条对应）：
 * docs/委派/R1-恢复失败后重建聊天.md
 *
 * 条件 1：恢复失败、回滚完整之后，runtime.conversations 能新建对话、列出对话、
 *          追加一条消息，都不抛错。
 * 条件 2：回滚之后，语义索引开着时用的是新连接（查状态、检索不抛错）；
 *          嵌入模型设为 none 时仍然是 null。
 *          检索的向量计算要 Ollama 在线（CI 没有），检索所依赖的数据库段与
 *          查状态同一连接：用 coverage / backfill（0 条待补时不发网络请求）验证。
 * 条件 3：回滚之后旧语义索引的后台工作不再跑。语义索引没有常驻定时器，
 *          后台工作只有按需补向量的 promise（semanticBackfillRun）：
 *          重建后引用被弃置，下一次补向量从新索引开始。
 *
 * 恢复失败按 lifecycle-round3 T9 的方式注入：vault 目录 renameSync 失败一次
 * （磁盘替换失败、回滚完整 → rebuildRuntimeServices）。
 */
import { afterEach, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArchiveService,
  ImportService,
  JobQueue,
  OllamaEmbedder,
  PermissionService,
  ProjectService,
  SemanticIndex,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type ConversationStore,
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { LocalServer } from '../../src/main/server/localServer.js';

const fault = vi.hoisted(() => ({ mode: '', failures: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const a = String(from).replace(/\\/g, '/');
      if (fault.mode === 'once' && a.includes('.restore-staging-') && a.endsWith('/vault')) {
        fault.failures++;
        fault.mode = '';
        throw new Error('R1_INJECTED_VAULT_RENAME_FAILURE');
      }
      return actual.renameSync(from, to);
    },
  };
});
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

const dbs = new Set<CoreDatabase>();
const queues = new Set<JobQueue>();
const runtimes: AppRuntime[] = [];
const oldEmbedModel = process.env.IXAEON_EMBED_MODEL;

afterEach(() => {
  fault.mode = '';
  fault.failures = 0;
  if (oldEmbedModel === undefined) delete process.env.IXAEON_EMBED_MODEL;
  else process.env.IXAEON_EMBED_MODEL = oldEmbedModel;
  for (const runtime of runtimes.splice(0)) {
    dbs.add(runtime.db);
    queues.add(runtime.jobs);
  }
  for (const queue of queues) queue.stop();
  queues.clear();
  vi.clearAllTimers();
  for (const db of dbs) if (db.open) db.close();
  dbs.clear();
  vi.restoreAllMocks();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-r1-'));
  const dbPath = join(dir, 'ixaeon.db');
  const db = openDatabase(dbPath);
  dbs.add(db);
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const projects = new ProjectService(db);
  const project = projects.create({ name: 'R1 合成项目', rootPath: null, description: null });
  // vault 里得有内容：恢复时 staging vault 才会被安装，renameSync 注入点才存在
  const file = join(dir, 'seed.md');
  writeFileSync(file, '# R1 合成\n\nR1_SYNTHETIC_SEED\n');
  new ImportService(db, vault, permissions, sources).importFile(file, {
    permissionId: permissions.grantFile(file).id,
    projectId: project.id,
  });
  let config = defaultAppConfig();
  const localServer = new LocalServer({
    db,
    vault,
    permissions,
    sources,
    getConfig: () => config,
    updateConfig: (mutate) => {
      config = mutate(config);
    },
    onCaptured: vi.fn(),
  });
  return { dir, dbPath, db, vault, permissions, sources, projects, localServer };
}

function runtimeFor(f: ReturnType<typeof fixture>) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this;
    },
  };
  const jobs = new JobQueue(f.db, logger);
  queues.add(jobs);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime & {
    conversations: ConversationStore;
    semanticIndex: SemanticIndex | null;
    semanticBackfillRun: Promise<void> | null;
  };
  Object.assign(runtime, {
    ...f,
    dataDir: f.dir,
    configFile: join(f.dir, 'config.json'),
    logger,
    jobs,
    fastify: null,
    stopServer: vi.fn(async () => {}),
    startServer: vi.fn(async () => {}),
  });
  runtimes.push(runtime);
  return runtime;
}

/** 建一个旧连接上的运行时并注入一次 vault 安装失败（回滚完整）。 */
async function rolledBackRuntime() {
  const f = fixture();
  const zip = join(f.dir, 'export.zip');
  const exportArchive = new ArchiveService(f.db, {
    dataDir: f.dir,
    dbPath: f.dbPath,
    vault: f.vault,
    closeCurrentDb: () => {},
  });
  await exportArchive.exportData(zip);
  const runtime = runtimeFor(f);
  const preview = await runtime.previewRestore(zip);
  fault.mode = 'once';
  await expect(runtime.restoreData(preview.previewToken)).rejects.toThrow(
    'R1_INJECTED_VAULT_RENAME_FAILURE',
  );
  return { runtime, f };
}

it('条件 1：回滚后 conversations 换了新连接，建/列/追加消息都不抛错', async () => {
  const { runtime } = await rolledBackRuntime();
  const conv = runtime.conversations.create({ projectId: null });
  expect(runtime.conversations.list().map((c) => c.id)).toContain(conv.id);
  const msg = runtime.conversations.appendMessage(conv.id, {
    role: 'user',
    content: 'R1 合成消息',
  });
  expect(msg.role).toBe('user');
});

it('条件 2：回滚后语义索引用新连接（查状态、补向量不抛错）；none 仍是 null', async () => {
  const { runtime } = await rolledBackRuntime();
  expect(runtime.semanticIndex).not.toBeNull();
  const status = runtime.getSemanticIndexStatus();
  expect(status.enabled).toBe(true);
  // 检索/维护依赖的数据库段：0 条待补时 backfill 不发网络请求
  const r = await runtime.semanticIndex!.backfill({});
  expect(r.embedded).toBe(0);

  // none：初始非空，回滚重建后必须是 null
  process.env.IXAEON_EMBED_MODEL = 'none';
  const f2 = fixture();
  const zip2 = join(f2.dir, 'export.zip');
  const arch = new ArchiveService(f2.db, {
    dataDir: f2.dir,
    dbPath: f2.dbPath,
    vault: f2.vault,
    closeCurrentDb: () => {},
  });
  await arch.exportData(zip2);
  const rt2 = runtimeFor(f2);
  Object.assign(rt2, {
    semanticIndex: new SemanticIndex(f2.db, new OllamaEmbedder({ model: 'qwen3-embedding:0.6b' })),
  });
  const preview2 = await rt2.previewRestore(zip2);
  fault.mode = 'once';
  await expect(rt2.restoreData(preview2.previewToken)).rejects.toThrow(
    'R1_INJECTED_VAULT_RENAME_FAILURE',
  );
  expect(rt2.semanticIndex).toBeNull();
});

it('条件 3：旧索引的在途补向量被弃置，新补向量从新索引开始', async () => {
  const f = fixture();
  const zip = join(f.dir, 'export.zip');
  await new ArchiveService(f.db, {
    dataDir: f.dir,
    dbPath: f.dbPath,
    vault: f.vault,
    closeCurrentDb: () => {},
  }).exportData(zip);
  const runtime = runtimeFor(f);
  // 恢复前就有在途补向量（绑着即将关闭的旧连接）
  let settle: (() => void) | null = null;
  const pending = new Promise<void>((r) => {
    settle = r;
  });
  (runtime as unknown as { semanticBackfillRun: Promise<void> | null }).semanticBackfillRun =
    pending;
  const preview = await runtime.previewRestore(zip);
  fault.mode = 'once';
  await expect(runtime.restoreData(preview.previewToken)).rejects.toThrow(
    'R1_INJECTED_VAULT_RENAME_FAILURE',
  );
  expect(
    (runtime as unknown as { semanticBackfillRun: Promise<void> | null }).semanticBackfillRun,
  ).toBeNull();
  // 新的补向量从新索引开始，不抛错（0 条待补，无网络）
  await runtime.kickSemanticBackfill();
  settle?.();
});
