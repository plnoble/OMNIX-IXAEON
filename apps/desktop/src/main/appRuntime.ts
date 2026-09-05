import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
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
  // 恢复失败时需要整体重建（重开数据库 + 重建服务），因此不再声明 readonly
  db: CoreDatabase;
  vault: Vault;
  permissions: PermissionService;
  sources: SourceStore;
  projects: ProjectService;
  search: SearchService;
  imports: ImportService;
  items: ItemService;
  jobs: JobQueue;
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
      // 采集成功回调（修复 P1-6.1）：autoAnalyze=true 时排队提取任务
      onCaptured: (sourceId: string): void => {
        runtimeRef.current?.enqueueAutoExtraction(sourceId);
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

  /** 自动分析队列（来源去重：任务表中已有同来源 queued/running 提取则跳过）。 */
  /**
   * 自动分析入队（修复 R7）：采集回调触达时总是入队。
   * 排队/运行中的已有任务不能丢掉「再次分析」的需求 —— 提取按当前数据库
   * 最新内容整体替换旧理解，重复执行安全（幂等），最终状态一定是最新版本。
   * 频率由 LocalServer 的防抖窗口 + pending 补分析机制控制。
   */
  private enqueueAutoExtraction(sourceId: string): void {
    const job = this.jobs.enqueue('extract', { sourceId, auto: true });
    recordAudit(this.db, 'capture.auto_extract_job', { jobId: job.id, sourceId });
    this.jobs.kick();
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

  // --- 导出 / 恢复（M5；修复 P1-7） ---

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

  /** 恢复预览（只读；签发一次性恢复凭证 previewToken）。 */
  previewRestore(zipPath: string): Promise<RestorePreview> {
    const archive = new ArchiveService(this.db, {
      dataDir: this.dataDir,
      dbPath: join(this.dataDir, 'ixaeon.db'),
      vault: this.vault,
      closeCurrentDb: () => {},
    });
    return archive.previewRestore(zipPath);
  }

  /** 消费恢复凭证（一次预览一次恢复；伪造 / 过期 / 重复使用拒绝）。 */
  consumeRestoreToken(previewToken: string): string {
    const archive = new ArchiveService(this.db, {
      dataDir: this.dataDir,
      dbPath: join(this.dataDir, 'ixaeon.db'),
      vault: this.vault,
      closeCurrentDb: () => {},
    });
    return archive.consumePreviewToken(previewToken);
  }

  /**
   * 恢复（整体替换，原子替换 + 失败回滚）。
   * 恢复在临时目录完成全部校验后原子替换当前数据；失败时按步骤精确回滚
   * （修复 R2），随后重开数据库、重建全部依赖服务并恢复本地服务与任务队列，
   * 保证界面与本地接口继续可用。成功后当前进程运行时失效，要求重启应用。
   * 必须携带 previewRestore 签发的一次性凭证（不允许绕过预览）。
   */
  async restoreData(previewToken: string): Promise<{ ok: true; restartRequired: true }> {
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
    try {
      await archive.restoreDataWithToken(previewToken);
    } catch (err) {
      // 恢复失败：磁盘数据已由 ArchiveService 回滚到旧状态；
      // 运行时侧必须重开数据库、重建服务（修复 R2 运行时缺口），再恢复服务
      this.logger.error('数据恢复失败，正在恢复运行时可用状态', { error: String(err) });
      try {
        this.rebuildRuntimeServices();
      } catch (rebuildErr) {
        this.logger.error('运行时重建失败（数据文件完好，需重启应用）', {
          error: String(rebuildErr),
        });
        throw err;
      }
      await this.startServer();
      throw err;
    }
    // 数据已替换：当前进程所有内存态服务均失效，要求重启
    this.logger.info('数据恢复完成，等待应用重启', {});
    return { ok: true, restartRequired: true };
  }

  /**
   * 恢复失败后的运行时重建：重开数据库、按新句柄重建全部依赖服务、
   * 重启任务队列。旧的服务实例持有的已关闭连接全部弃用。
   */
  private rebuildRuntimeServices(): void {
    const dbPath = join(this.dataDir, 'ixaeon.db');
    const db = openDatabase(dbPath);
    // 按回滚后的磁盘数据重建（结构化迁移在 openDatabase 后执行）
    migrate(db);
    const vault = new Vault(join(this.dataDir, 'vault'));
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const projects = new ProjectService(db);
    const search = new SearchService(db);
    const imports = new ImportService(db, vault, permissions, sources);
    const items = new ItemService(db);
    const jobs = new JobQueue(db, this.logger.child({ component: 'jobs' }));
    this.db = db;
    this.vault = vault;
    this.permissions = permissions;
    this.sources = sources;
    this.projects = projects;
    this.search = search;
    this.imports = imports;
    this.items = items;
    this.jobs = jobs;
    // localServer 持有的是旧 db 引用：用新服务重建其依赖（复用同一实例）
    this.localServer.rebindDeps({
      db,
      permissions,
      sources,
      vault,
    });
    this.registerJobHandlers();
    jobs.start();
    this.logger.info('运行时已重建（恢复失败后）', { dataDir: this.dataDir });
  }

  private async startServer(): Promise<void> {
    if (this.fastify) return;
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

  /** 停止本地 HTTP 服务（数据恢复前调用，避免恢复期间并发访问）。 */
  private async stopServer(): Promise<void> {
    if (this.fastify) {
      await this.fastify.close();
      this.fastify = null;
      this.logger.info('本地服务已停止（数据恢复）');
    }
  }

  get state() {
    // 修复 R9：envOverride 来自数据目录解析的真实结果，不再由渲染层推断
    const resolved = resolveDataDir();
    return {
      version: app.getVersion() || '0.1.0',
      dataDir: this.dataDir,
      setupComplete: this.config.setupComplete,
      serverRunning: this.fastify !== null,
      serverPort: LOCAL_HTTP_PORT,
      platform: process.platform,
      envOverride: resolved.envOverride,
      dataDirSource: resolved.source,
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

  /**
   * 首次设置完成（修复 P1-8）：用户选择新数据目录时，完整迁移流程为
   * 「先验证目标可写 + 写好新目录的全部设置 → 最后切换 bootstrap 指针」。
   * - 新目录写入：config（setupComplete + 模型 + 加密 Key）+ 首个项目；
   * - 切换失败（目标不可写）时旧目录与旧指针保持不变；
   * - 成功后本进程运行时仍指向旧目录：返回 restartRequired=true，
   *   UI 提示重启；绝不在两个目录各留半套数据。
   */
  completeSetup(input: SetupInput): { ok: true; restartRequired: boolean } {
    const customDir = input.dataDir?.trim() ?? '';
    const apiKeyEncrypted =
      input.apiKey.length > 0 ? encryptApiKey(input.apiKey) : this.config.model.apiKeyEncrypted;

    if (customDir.length === 0) {
      // 默认目录：当前进程就地完成（无需重启）
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
      this.ensureFirstProject(input);
      recordAudit(this.db, 'setup.completed', { hasApiKey: input.apiKey.length > 0 });
      return { ok: true, restartRequired: false };
    }

    // 自定义目录：全部数据写入新目录，成功后才切换指针
    const targetDir = resolve(customDir);
    const layout = ensureDataDirLayout(targetDir); // 不可写/无法创建 → 抛错，旧指针未动
    const newConfig: AppConfig = {
      ...this.config,
      setupComplete: true,
      model: {
        ...this.config.model,
        modelName: input.modelName,
        apiKeyEncrypted,
        apiKeyPresent: apiKeyEncrypted !== null,
      },
    };
    if (!newConfig.localToken) {
      newConfig.localToken = randomBytes(32).toString('hex');
    }
    // 先写新目录的完整 config（含 localToken），再建库与首个项目
    saveConfig(layout.configFile, newConfig);
    const newDb = openDatabase(layout.dbFile);
    try {
      migrate(newDb);
      const newProjects = new ProjectService(newDb);
      const exists = newProjects
        .list()
        .find((p: Project) => p.name.toLowerCase() === input.projectName.toLowerCase());
      if (!exists) {
        newProjects.create({
          name: input.projectName,
          rootPath: input.projectRootPath,
          description: null,
        });
      }
      recordAudit(newDb, 'setup.completed', {
        hasApiKey: input.apiKey.length > 0,
        dataDir: targetDir,
      });
    } finally {
      newDb.close();
    }
    // 全部成功 → 最后切换指针（失败时上面已抛错，指针未改）
    setDataDirChoice(targetDir);
    return { ok: true, restartRequired: true };
  }

  /** 在当前库中确保第一个项目存在（默认目录路径用）。 */
  private ensureFirstProject(input: SetupInput): void {
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
