import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  ArchiveService,
  AskService,
  Extractor,
  FakeProvider,
  ItemService,
  OpenAIResponsesProvider,
  ImportService,
  JobQueue,
  Logger,
  openDatabase,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  Vault,
  ensureDataDirLayout,
  loadConfig,
  migrate,
  recordAudit,
  resolveDataDir,
  saveConfig,
  setDataDirChoice,
  type AskResult,
  type CoreDatabase,
  type ModelProvider,
} from '@ixaeon/core';
import {
  ErrorCodes,
  IxaError,
  LOCAL_HTTP_PORT,
  type AppConfig,
  type ExportResult,
  type Project,
  type RestorePreview,
  type SetupInput,
  type WorkRun,
} from '@ixaeon/contracts';
import Fastify from 'fastify';
import { LocalServer } from './server/localServer.js';
import { decryptApiKey, encryptApiKey } from './ipc.js';

/**
 * 桌面应用主运行时：集中持有数据库、服务与本地 HTTP 服务。
 * 应用打开时初始化，退出时全部停止。
 */
export class AppRuntime {
  readonly db: CoreDatabase;
  readonly vault: Vault;
  readonly permissions: PermissionService;
  readonly sources: SourceStore;
  readonly projects: ProjectService;
  readonly search: SearchService;
  readonly imports: ImportService;
  readonly items: ItemService;
  readonly jobs: JobQueue;
  readonly logger: Logger;
  readonly localServer: LocalServer;
  private readonly fakeProvider = new FakeProvider('fake-model-v1');
  private fastify: ReturnType<typeof Fastify> | null = null;
  private config: AppConfig;
  private readonly configFile: string;
  private readonly dataDir: string;
  private modelCallCount = 0;

  private constructor(deps: {
    dataDir: string;
    configFile: string;
    config: AppConfig;
    db: CoreDatabase;
    vault: Vault;
    permissions: PermissionService;
    sources: SourceStore;
    projects: ProjectService;
    search: SearchService;
    imports: ImportService;
    items: ItemService;
    jobs: JobQueue;
    logger: Logger;
    localServer: LocalServer;
  }) {
    this.dataDir = deps.dataDir;
    this.configFile = deps.configFile;
    this.config = deps.config;
    this.db = deps.db;
    this.vault = deps.vault;
    this.permissions = deps.permissions;
    this.sources = deps.sources;
    this.projects = deps.projects;
    this.search = deps.search;
    this.imports = deps.imports;
    this.items = deps.items;
    this.jobs = deps.jobs;
    this.logger = deps.logger;
    this.localServer = deps.localServer;
  }

  static async create(): Promise<AppRuntime> {
    const resolved = resolveDataDir();
    const layout = ensureDataDirLayout(resolved.dataDir);
    const logger = new Logger({
      file: join(layout.logsDir, `ixaeon-${new Date().toISOString().slice(0, 10)}.log`),
      baseFields: { app: 'ixaeon', pid: process.pid },
    });
    logger.info('运行时初始化', { dataDir: resolved.dataDir, source: resolved.source });

    const db = openDatabase(layout.dbFile);
    migrate(db);
    const vault = new Vault(layout.vaultDir);
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const projects = new ProjectService(db);
    const search = new SearchService(db);
    const imports = new ImportService(db, vault, permissions, sources);
    const items = new ItemService(db);
    const jobs = new JobQueue(db, logger.child({ component: 'jobs' }));

    const config = loadConfig(layout.configFile);
    // 确保本地令牌存在（MCP / 本地 API 用）
    if (!config.localToken) {
      config.localToken = randomBytes(32).toString('hex');
      saveConfig(layout.configFile, config);
    }

    // localServer 的配置回调闭包引用 runtime 变量：构造完成前不会启动服务，
    // 因此回调被调用时 runtime 一定已赋值。闭包内只读不重绑定，用 const。
    const runtimeRef: { current: AppRuntime | null } = { current: null };
    const localServer = new LocalServer({
      db,
      permissions,
      sources,
      vault,
      getConfig: (): AppConfig => {
        if (!runtimeRef.current) throw new Error('IXA0017 运行时尚未初始化');
        return runtimeRef.current.config;
      },
      updateConfig: (mutate: (c: AppConfig) => AppConfig): void => {
        if (!runtimeRef.current) return;
        runtimeRef.current.config = mutate(runtimeRef.current.config);
        saveConfig(layout.configFile, runtimeRef.current.config);
      },
    });

    const runtime = new AppRuntime({
      dataDir: resolved.dataDir,
      configFile: layout.configFile,
      config,
      db,
      vault,
      permissions,
      sources,
      projects,
      search,
      imports,
      items,
      jobs,
      logger,
      localServer,
    });
    runtimeRef.current = runtime;
    runtime.registerJobHandlers();
    jobs.start();
    await runtime.startServer();
    return runtime;
  }

  private registerJobHandlers(): void {
    // 提取任务（M2）：结构化提取 → items + item_evidence。
    // 模型未配置时任务失败并给出明确原因（配置后可重试）。
    this.jobs.register('extract', async (job) => {
      const payload = JSON.parse(job.payload_json) as { sourceId: string };
      const provider = this.getProvider();
      if (!provider) {
        throw new Error(
          'IXA0010 模型未配置：请在设置中填写 OpenAI API Key 与模型名称后重试该提取任务',
        );
      }
      const extractor = new Extractor(this.db, provider);
      const stats = await extractor.extractSource(payload.sourceId);
      recordAudit(this.db, 'extract.completed', {
        sourceId: payload.sourceId,
        inserted: stats.inserted,
        skippedBadRef: stats.skippedBadRef,
        disputed: stats.disputed,
        needsReview: stats.needsReview,
      });
    });
  }

  /**
   * 当前可用的模型提供者。API Key 解密失败或未配置时返回 null。
   * 测试可用 IXAEON_FAKE_MODEL=1 注入 FakeProvider（绝不连接网络）。
   */
  getProvider(): ModelProvider | null {
    if (process.env.IXAEON_FAKE_MODEL === '1') {
      return this.fakeProvider;
    }
    const config = this.config;
    if (!config.model.apiKeyPresent || !config.model.modelName) return null;
    const encrypted = config.model.apiKeyEncrypted;
    if (!encrypted) return null;
    const apiKey = decryptApiKey(encrypted);
    if (!apiKey) {
      this.logger.warn('API Key 解密失败（可能迁移自其他机器）', {});
      return null;
    }
    return new OpenAIResponsesProvider({
      apiKey,
      modelName: config.model.modelName,
      baseUrl: process.env.IXAEON_OPENAI_BASE_URL,
    });
  }

  /** 问答（Ask 页）。模型未配置时明确报错。 */
  async ask(projectId: string | null, question: string): Promise<AskResult> {
    const provider = this.getProvider();
    if (!provider) {
      throw new IxaError(
        ErrorCodes.MODEL_NOT_CONFIGURED,
        'IXA0010 模型未配置：请在设置中填写 OpenAI API Key 后使用问答',
      );
    }
    const asker = new AskService(this.db, provider);
    return asker.ask(projectId, question);
  }

  /** 工作记录列表（M3：最近工作展示）。 */
  listWorkRuns(projectId: string, limit: number): Array<WorkRun> {
    return this.db
      .prepare(`SELECT * FROM work_runs WHERE project_id = ? ORDER BY finished_at DESC LIMIT ?`)
      .all(projectId, limit) as WorkRun[];
  }

  // --- 导出 / 恢复（M5） ---

  /** 导出全部数据到 ZIP。 */
  exportData(targetPath: string): Promise<ExportResult> {
    const archive = new ArchiveService(this.db, {
      dataDir: this.dataDir,
      dbPath: join(this.dataDir, 'ixaeon.db'),
      vault: this.vault,
      closeCurrentDb: () => {},
    });
    return archive.exportData(targetPath);
  }

  /** 恢复预览（只读）。 */
  previewRestore(zipPath: string): Promise<RestorePreview> {
    const archive = new ArchiveService(this.db, {
      dataDir: this.dataDir,
      dbPath: join(this.dataDir, 'ixaeon.db'),
      vault: this.vault,
      closeCurrentDb: () => {},
    });
    return archive.previewRestore(zipPath);
  }

  /**
   * 恢复（整体替换）。恢复完成后当前进程的数据库/文件句柄已失效，
   * 调用方应提示用户重启应用（恢复即返回 { ok: true, restartRequired: true }）。
   */
  async restoreData(zipPath: string): Promise<{ ok: true; restartRequired: true }> {
    // 先停本地 HTTP 服务（释放 db 并发访问）
    await this.stopServer();
    const archive = new ArchiveService(this.db, {
      dataDir: this.dataDir,
      dbPath: join(this.dataDir, 'ixaeon.db'),
      vault: this.vault,
      closeCurrentDb: () => {
        try {
          this.jobs.stop();
        } catch {
          // job 轮询停止失败不影响恢复
        }
        try {
          this.db.close();
        } catch {
          // 已关闭
        }
      },
    });
    await archive.restoreData(zipPath);
    // 数据已替换：当前进程所有内存态服务均失效，要求重启
    this.logger.info('数据恢复完成，等待应用重启', {});
    return { ok: true, restartRequired: true };
  }

  private async startServer(): Promise<void> {
    const fastify = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024,
    });
    await this.localServer.register(fastify);
    try {
      await fastify.listen({ port: LOCAL_HTTP_PORT, host: '127.0.0.1' });
      this.fastify = fastify;
      this.logger.info('本地服务已启动', { host: '127.0.0.1', port: LOCAL_HTTP_PORT });
    } catch (err) {
      this.logger.error('本地服务启动失败', { error: String(err) });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.jobs.stop();
    await this.stopServer();
    this.db.close();
    this.logger.info('运行时已停止');
  }

  /** 停止本地 HTTP 服务（恢复数据前调用，避免恢复期间并发访问）。 */
  private async stopServer(): Promise<void> {
    if (this.fastify) {
      await this.fastify.close();
      this.fastify = null;
      this.logger.info('本地服务已停止（数据恢复）');
    }
  }

  get state() {
    return {
      version: app.getVersion() || '0.1.0',
      dataDir: this.dataDir,
      setupComplete: this.config.setupComplete,
      serverRunning: this.fastify !== null,
      serverPort: LOCAL_HTTP_PORT,
      platform: process.platform,
    };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  updateConfig(mutate: (config: AppConfig) => AppConfig): AppConfig {
    this.config = mutate(this.config);
    saveConfig(this.configFile, this.config);
    return this.config;
  }

  /** 首次设置完成：数据目录、模型、第一个项目。 */
  completeSetup(input: SetupInput): { ok: true } {
    if (input.dataDir && input.dataDir.trim().length > 0) {
      // 记录选择（bootstrap.json 指向新目录；本进程继续用当前目录，重启后生效）
      setDataDirChoice(input.dataDir.trim());
    }
    const apiKeyEncrypted =
      input.apiKey.length > 0 ? encryptApiKey(input.apiKey) : this.config.model.apiKeyEncrypted;
    this.updateConfig((c) => ({
      ...c,
      setupComplete: true,
      model: {
        ...c.model,
        modelName: input.modelName,
        apiKeyEncrypted,
        apiKeyPresent: apiKeyEncrypted !== null,
      },
    }));
    // 创建第一个项目
    const existing = this.projects
      .list()
      .find((p: Project) => p.name.toLowerCase() === input.projectName.toLowerCase());
    if (!existing) {
      this.projects.create({
        name: input.projectName,
        rootPath: input.projectRootPath,
        description: null,
      });
    }
    recordAudit(this.db, 'setup.completed', { hasApiKey: input.apiKey.length > 0 });
    return { ok: true };
  }

  /** 模型调用计数（诊断与测试）。 */
  noteModelCall(): void {
    this.modelCallCount += 1;
  }

  get modelCalls(): number {
    return this.modelCallCount;
  }

  /** 最近一次扩展同步时间（弹窗状态显示）。 */
  lastCaptureAt(): string | null {
    const row = this.db
      .prepare(
        "SELECT imported_at AS t FROM sources WHERE provider='chatgpt_web' ORDER BY imported_at DESC LIMIT 1",
      )
      .get() as { t: string } | undefined;
    return row?.t ?? null;
  }
}
