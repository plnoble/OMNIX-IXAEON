import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
      // 对话恢复回调（修复 M0.2：恢复允许后处理最新版本）：
      // 该会话来源中「欠分析」的补一次自动提取（受开关/暂停/授权复查约束）
      onConversationResumed: (externalIds: string[]): void => {
        const rt = runtimeRef.current;
        if (!rt) return;
        for (const ext of externalIds) {
          const row = rt.db
            .prepare(
              "SELECT id FROM sources WHERE provider = 'chatgpt_web' AND external_id = ? AND content_revision > analyzed_revision",
            )
            .get(ext) as { id: string } | undefined;
          if (row) rt.enqueueAutoExtraction(row.id);
        }
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
    // C02：启动阶段先恢复上一运行代次真正遗留的 running 任务
    //（此时队列必空闲，running 记录没有执行者），再扫描欠分析来源
    runtime.recoverOrphanedJobs();
    runtime.sweepPendingAnalysis();
    await runtime.startServer();
    return runtime;
  }

  /** 自动分析队列（来源去重：任务表中已有同来源 queued/running 提取则跳过）。 */
  /**
   * 自动分析入队（修复 R7/M0.2 第 1 条）：同一来源最多一个 queued/running
   * 的自动提取 —— 已排队的任务执行时读取最新内容版本，天然合并窗口内的
   * 多次更新；任务执行期间的新内容由完成后的滞后检查补队（不丢工作）。
   */
  private enqueueAutoExtraction(sourceId: string, excludeJobId?: string): void {
    // excludeJobId：完成路径的滞后补队 —— 当前任务尚为 running，需排除自身，
    // 否则滞后检查会被自己的运行状态挡住（丢失补分析，修复门槛 1）
    if (this.hasActiveExtractJob(sourceId, excludeJobId)) return;
    this.enqueueExtract(sourceId, true);
  }

  private hasActiveExtractJob(sourceId: string, excludeJobId?: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS one FROM jobs
         WHERE kind = 'extract' AND status IN ('queued', 'running')
           AND payload_json LIKE ? AND id != ?
         LIMIT 1`,
      )
      .get(`%"sourceId":"${sourceId}"%`, excludeJobId ?? '') as { one: number } | undefined;
    return row !== undefined;
  }

  private enqueueExtract(sourceId: string, auto: boolean): void {
    const job = this.jobs.enqueue('extract', auto ? { sourceId, auto: true } : { sourceId });
    recordAudit(this.db, 'extract.enqueued', { jobId: job.id, sourceId, auto });
    this.jobs.kick();
  }

  /**
   * 恢复上一运行代次真正遗留的任务（C02：只在启动时执行一次）。
   * 「遗留」判定：本队列实例**空闲**（无任何在途执行）时，数据库中的
   * running 记录必然没有执行者（上一进程崩溃/退出遗留）——转为 queued
   * 重排队（保留重试预算）。若本队列正在执行任务，绝不触碰 running 记录
   *（那是在途任务，不是遗留）。
   */
  recoverOrphanedJobs(): number {
    if (!this.jobs.idleExecution) return 0; // 有在途执行：无「遗留」可言
    const orphaned = this.db
      .prepare("SELECT id FROM jobs WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    let recovered = 0;
    for (const job of orphaned) {
      if (this.jobs.isExecuting(job.id)) continue; // 双保险：内存事实优先
      this.db
        .prepare(
          "UPDATE jobs SET status = 'queued', error = '上一运行代次中断的任务已恢复排队', updated_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(new Date().toISOString(), job.id);
      recordAudit(this.db, 'job.orphan_requeued', { jobId: job.id });
      recovered += 1;
    }
    return recovered;
  }

  /**
   * 扫描「欠分析」的来源并补队（修复 M0.2 第 2/3 条：待分析状态持久化，
   * 崩溃重启后能找出未完成工作；不再依赖内存计时器）。
   * - 网页来源（chatgpt_web）：遵守采集开关、自动分析开关、域授权与暂停；
   * - 其他来源（导入等）：沿用导入管线的重试语义（非自动任务）。
   * - 已有 queued/running 提取任务的来源跳过（合并）；数量上限防风暴。
   * - C02：日常扫描不碰 running 任务 —— 遗留恢复仅由启动阶段的
   *   recoverOrphanedJobs 负责（且要求队列空闲）。
   */
  sweepPendingAnalysis(limit = 50): number {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.provider FROM sources s
         WHERE s.content_revision > s.analyzed_revision
         ORDER BY s.imported_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; provider: string }>;
    let enqueued = 0;
    const cfg = this.getConfig();
    for (const row of rows) {
      if (this.hasActiveExtractJob(row.id)) continue;
      if (row.provider === 'chatgpt_web') {
        if (!cfg.capture.enabled || !cfg.capture.autoAnalyze) continue;
        if (!this.permissions.activePermissionForDomain('chatgpt.com')) continue;
        if (this.isSourceConversationPaused(row.id)) continue;
        this.enqueueExtract(row.id, true);
      } else {
        this.enqueueExtract(row.id, false);
      }
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.jobs.kick();
      recordAudit(this.db, 'analysis.sweep', { enqueued });
    }
    return enqueued;
  }

  /**
   * 来源所属对话是否被用户暂停（修复 F4）：按来源的 externalId 与其绑定的
   * 会话标识（含别名解析）检查暂停状态。自动任务执行前与各块之间复查用。
   */
  isSourceConversationPaused(sourceId: string): boolean {
    const source = this.sources.get(sourceId);
    if (!source) return false;
    const capture = this.getConfig().capture;
    if (capture.pausedConversations.includes(source.external_id)) return true;
    const meta = (() => {
      try {
        const parsed = JSON.parse(source.metadata_json) as unknown;
        return parsed !== null && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })();
    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : null;
    if (sessionId !== null && capture.pausedSessions.includes(sessionId)) return true;
    // 别名解析（M0 收尾：session_aliases 已迁入 SQLite）
    const aliased = this.db
      .prepare('SELECT session_id AS s FROM session_aliases WHERE external_id = ?')
      .get(source.external_id) as { s: string } | undefined;
    if (aliased && capture.pausedSessions.includes(aliased.s)) return true;
    return false;
  }

  private registerJobHandlers(): void {
    // 提取任务（M2）：结构化提取 → items + item_evidence。
    // 模型未配置时任务失败并给出明确原因（配置后可重试）。
    this.jobs.register('extract', async (job, ctx) => {
      const payload = JSON.parse(job.payload_json) as {
        sourceId: string;
        /** 自动分析任务标记：执行时复查开关/暂停；手动任务不查自动分析开关 */
        auto?: boolean;
      };
      const isAuto = payload.auto === true;
      // 修复 F4：自动任务在真正执行前重新检查开关、来源授权与对话暂停状态 ——
      // 排队时允许不代表执行时仍被允许。手动任务只受授权约束（关闭自动分析
      // 不封死仍获授权的手动操作；撤销授权则一律禁止，由提取器内检查）。
      const autoGuardSatisfied = (): boolean => {
        if (!isAuto) return true;
        const cfg = this.getConfig();
        if (!cfg.capture.autoAnalyze) return false;
        if (!cfg.capture.enabled) return false;
        if (this.isSourceConversationPaused(payload.sourceId)) return false;
        return true;
      };
      if (!autoGuardSatisfied()) {
        const err = new IxaError(
          ErrorCodes.JOB_CANCELLED,
          '自动提取已取消（自动分析开关、采集开关或对话暂停状态在排队后发生变化）',
        ) as IxaError & { jobCancelled: boolean };
        err.jobCancelled = true;
        recordAudit(this.db, 'extract.cancelled_before_model', {
          sourceId: payload.sourceId,
          auto: isAuto,
        });
        throw err;
      }
      const provider = this.getProvider();
      if (!provider) {
        throw new Error(
          'IXA0010 模型未配置：请在设置中填写 OpenAI API Key 与模型名称后重试该提取任务',
        );
      }
      const extractor = new Extractor(this.db, provider);
      // 修复 M0.2 第 6 条：任务以「开始执行时的内容版本」为目标版本 ——
      // 执行期间的新内容不会混入本次结果，由完成后的滞后检查补分析。
      const targetRevision = this.sources.getRevisions(payload.sourceId).content;
      // 修复 G1：把队列的真实取消信号（ctx.signal）与自动任务的开关/暂停检查
      // 组合 —— 手动与自动任务都受取消约束；取消发生在模型等待期间时，
      // 已发出的网络请求无法收回，但不再发送后续块、不提交结果、不推进版本。
      const stats = await extractor.extractSource(payload.sourceId, {
        shouldContinue: () => !ctx.signal.aborted && autoGuardSatisfied(),
      });
      if (ctx.signal.aborted) {
        // 提交后队列会按 abort 落 cancelled；此处不再推进 analyzed 版本
        const cancelledErr = new IxaError(
          ErrorCodes.JOB_CANCELLED,
          '提取已取消（任务在执行期间被用户取消）',
        ) as IxaError & { jobCancelled: boolean };
        cancelledErr.jobCancelled = true;
        throw cancelledErr;
      }
      // 修复 M0.2：成功后推进「已分析版本」（只前进不回退）；若执行期间
      // 又有新内容（content > analyzed）→ 合并为一次补分析，不丢工作。
      this.sources.advanceAnalyzedRevision(payload.sourceId, targetRevision);
      const revisions = this.sources.getRevisions(payload.sourceId);
      if (revisions.content > revisions.analyzed) {
        this.enqueueAutoExtraction(payload.sourceId, job.id);
        this.jobs.kick();
      }
      recordAudit(this.db, 'extract.completed', {
        sourceId: payload.sourceId,
        auto: isAuto,
        targetRevision,
        contentRevision: revisions.content,
        analyzedRevision: revisions.analyzed,
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
   * 恢复在临时目录完成全部校验后原子替换当前数据。
   * 失败处理按实际进度分类（修复 N4/N5）：
   * - 凭证/预校验失败（发生在关库之前）：原运行时未被触动，直接复用，
   *   重启本地服务后重新抛出 —— 不叠加第二套服务（否则后续合法恢复会
   *   因旧连接占用数据库文件而 EBUSY）；
   * - 磁盘替换失败且回滚完整：重开数据库、重建全部依赖服务并恢复本地
   *   服务与任务队列（修复 R2 运行时缺口）；
   * - 回滚自身未完成：进入明确的恢复故障状态 —— 不重建、不启动服务、
   *   不自动创建空数据库，保留备份目录位置并如实记录日志。
   * 必须携带 previewRestore 签发的一次性凭证（不允许绕过预览）。
   */
  async restoreData(previewToken: string): Promise<{ ok: true; restartRequired: true }> {
    await this.stopServer();
    // 修复 F3：不再在凭证校验前清空待分析状态 —— 无效/过期凭证等早期失败
    // 必须完整保留原运行时（含待补分析计时器）。清理移入 closeCurrentDb 回调：
    // 只有校验全部通过、即将替换磁盘数据时才停止后台任务。
    const archive = new ArchiveService(this.db, {
      dataDir: this.dataDir,
      dbPath: join(this.dataDir, 'ixaeon.db'),
      vault: this.vault,
      closeCurrentDb: () => {
        // 修复 N3：先停止本地服务的后台补分析计时器，再关闭数据库 ——
        // 替换后旧回调不得访问已关闭的连接（可选链：运行时可能尚未完全装配）
        this.localServer?.stopBackgroundTasks();
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
      const rollbackIncomplete =
        (err as { rollbackIncomplete?: boolean }).rollbackIncomplete === true;
      const dbStillOpen = this.db.open === true;
      if (dbStillOpen && !rollbackIncomplete) {
        // 关库之前失败（凭证无效/过期/包损坏等）：磁盘与运行时都未被触动，
        // 原运行时仍然有效 —— 直接复用，不叠加第二套服务（修复 N4/T7）
        this.logger.warn('数据恢复被拒绝（原运行时保持可用）', { error: String(err) });
        await this.startServer();
        throw err;
      }
      if (rollbackIncomplete) {
        // 修复 N5/T8：回滚自身未完成 —— 磁盘状态不一致，旧数据仅在备份目录。
        // 进入恢复故障状态：不重建、不创建空库、不恢复正常写入。
        this.logger.error(
          '数据恢复失败且回滚未完成：进入恢复故障状态（不自动重建）。' +
            '旧数据完整保留在备份目录中，请根据日志中的备份路径手动恢复后重启应用',
          { error: String(err) },
        );
        throw err;
      }
      // 磁盘替换失败但回滚完整：重开数据库、重建服务，再恢复本地服务
      this.logger.error('数据恢复失败，磁盘已回滚，正在恢复运行时可用状态', {
        error: String(err),
      });
      try {
        this.rebuildRuntimeServices();
      } catch (rebuildErr) {
        this.logger.error('运行时重建失败（数据文件已回滚，需重启应用）', {
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
    // 修复 N5 兜底：回滚未完成时正式位置可能没有数据库文件 ——
    // 此时绝不能让 openDatabase 静默创建一个空库当作运行数据库。
    if (!existsSync(dbPath)) {
      throw new Error(
        'IXA0019 数据库文件缺失（恢复回滚未完成）：拒绝创建空数据库，请从备份目录手动恢复',
      );
    }
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
    // 修复 N3：应用退出时清理本地服务的后台补分析计时器，无残留回调
    this.localServer?.stopBackgroundTasks();
    // 修复 M0.2 第 8 条：退出前取消并**等待**在途写入任务结束，再关库
    this.jobs.stop();
    await this.jobs.idle();
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
