import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
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
  type CoreDatabase,
} from '@ixaeon/core';
import { LOCAL_HTTP_PORT, type AppConfig, type Project, type SetupInput } from '@ixaeon/contracts';
import Fastify from 'fastify';
import { LocalServer } from './server/localServer.js';
import { encryptApiKey } from './ipc.js';

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
  readonly jobs: JobQueue;
  readonly logger: Logger;
  readonly localServer: LocalServer;
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
    // M1：导入后的提取任务。模型未配置时任务失败并给出明确原因（可在配置后重试）。
    this.jobs.register('extract', async (job) => {
      const payload = JSON.parse(job.payload_json) as { sourceId: string };
      const config = this.config;
      if (!config.model.apiKeyPresent || !config.model.modelName) {
        throw new Error(
          'IXA0010 模型未配置：请在设置中填写 OpenAI API Key 与模型名称后重试该提取任务',
        );
      }
      // M2 实现：结构化提取 → items + item_evidence
      void payload;
      throw new Error('IXA0022 提取功能将在 M2 里程碑启用');
    });
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
    if (this.fastify) {
      await this.fastify.close();
      this.fastify = null;
    }
    this.db.close();
    this.logger.info('运行时已停止');
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
