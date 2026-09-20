import { app, safeStorage } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ArchiveService,
  Extractor,
  FakeProvider,
  ItemService,
  RelationService,
  proposeObviousRelations,
  buildPersonalOverview,
  ResearchChecker,
  systemClock,
  CodingOrchestrator,
  FakeCodingExecutor,
  CodexCliExecutor,
  resolveCodexLocator,
  HermesRuntimeAdapter,
  AgentSession,
  ConversationStore,
  OllamaEmbedder,
  SemanticIndex,
  SkillCandidateStore,
  CoreToolBroker,
  OpenAIResponsesProvider,
  listUpstreamModels,
  ImportService,
  JobQueue,
  Logger,
  openDatabase,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  extractSuggestedTodos,
  parseUserTodo,
  Vault,
  ensureDataDirLayout,
  loadConfig,
  migrate,
  backupBeforeMigrate,
  recordAudit,
  resolveDataDir,
  saveConfig,
  setDataDirChoice,
  createWebSearchExecutor,
  runControlledVerifyCommand,
  fetchApprovedSource,
  ContextSelector,
  memoryOriginTag,
  includesAiAdvice,
  AI_ADVICE_NOTE,
  CORE_TOOL_NAMES,
  addRejectedWatchDirection,
  buildWatchPrompt,
  collectWatchMemories,
  listRejectedWatchDirections,
  mapWatchDirections,
  watchDirectionsSchema,
  type WatchDirection,
  getDisclosureEpoch,
  isPathInside,
  localDay,
  locateHermes,
  personalMemoryToChat,
  setPersonalMemoryToChat,
  markOverviewFindingsSeen,
  type HermesLocator,
  type AgentSessionPreview,
  type AskResult,
  type CoreDatabase,
  type ModelProvider,
  type WebSearchExecutor,
} from '@ixaeon/core';
import {
  ErrorCodes,
  IxaError,
  LOCAL_HTTP_PORT,
  HERMES_BRIDGE_TOOL_WIRE_NAMES,
  type AppConfig,
  type AskDeltaEvent,
  type AskPhase,
  type AskProgressEvent,
  type HermesBridgeToolName,
  type ExportResult,
  type Permission,
  type Project,
  type RestorePreview,
  type SetupInput,
  type Todo,
  type TodoStatus,
  type TodoView,
  type WorkRun,
} from '@ixaeon/contracts';
import Fastify from 'fastify';
import { LocalServer } from './server/localServer.js';
import { bridgeBlockedReason, bridgeEntry, writeHermesBridgeEntry } from './hermesBridge.js';
import { decryptApiKey, decodeLegacyPlainApiKey, encryptApiKey } from './ipc.js';
import { desktopResearchFetchDeps, createDesktopTinyFishFetcher } from './researchFetch.js';
import type { TinyFishFetcher } from '@ixaeon/core';
import { syncBundledExtension } from './extensionBundle.js';

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
  relations: RelationService;
  research: ResearchChecker;
  coding: CodingOrchestrator;
  jobs: JobQueue;
  /** D2/D4：对话与消息的权威记录。R1 起可重赋值（恢复回滚后重建）。 */
  conversations: ConversationStore;
  todos: TodoStore;
  readonly logger: Logger;
  readonly localServer: LocalServer;
  private readonly fakeProvider = new FakeProvider('fake-model-v1');
  /** 测试模型响应脚本是否已加载（IXAEON_FAKE_MODEL_SCRIPT，仅一次） */
  private fakeScriptLoaded = false;
  private fastify: ReturnType<typeof Fastify> | null = null;
  private config: AppConfig;
  private readonly configFile: string;
  private readonly dataDir: string;
  private extensionLoadDir: string | null = null;
  private modelCallCount = 0;
  private researchTimer: NodeJS.Timeout | null = null;
  /**
   * D4：引擎会话按对话隔离。原来是一个全局 currentAsk 字段——一次只能有
   * 一个对话，切换话题会串台。现在每个对话一个 AgentSession（进而一个引擎
   * 侧 session_id），互不污染。
   * 这个 Map 活在进程里；应用重启后引擎会话全部消失，届时由
   * ConversationStore.clearEngineSessions() 清掉库里的陈旧 id，
   * 并靠 D3 的 priorTurns 重新喂上下文。
   */
  private readonly askSessions = new Map<string, AgentSession>();
  /** 每个对话当前在跑的 runId（用于按对话取消）。 */
  private readonly activeAskRuns = new Map<string, string>();
  /**
   * R1：本机语义索引（Ollama + qwen3-embedding:0.6b，用户 2026-09-17 批准）。
   * IXAEON_EMBED_MODEL=none 关闭；Ollama 没开时聊天照常，预注入记忆退回关键词并如实说明。
   * R1 起可重赋值（恢复回滚后按新连接重建，见 createSemanticIndex）。
   */
  semanticIndex: SemanticIndex | null;
  /** 正在跑的补向量回合（同一时间只跑一个）；提问前会等它，见 awaitSemanticBackfill。 */
  private semanticBackfillRun: Promise<void> | null = null;
  private semanticUnavailableLogged = false;
  /** R2：最近一次补向量失败原因（给人看的中文）；成功后清空。 */
  private semanticLastError: string | null = null;
  /** S1：把回答分段推到当前窗口。 */
  private askDeltaSink: ((e: AskDeltaEvent) => void) | null = null;
  /** P2：把等待阶段推到当前窗口。 */
  private askProgressSink: ((e: AskProgressEvent) => void) | null = null;
  /** S1：取消后丢掉迟到的分段，不再写库、不再发事件。 */
  private cancelledAskRuns = new Set<string>();
  /** P1：预热好的空闲问答会话（最多一个），见 prewarmChat。 */
  private warm: { session: AgentSession; contextRef: string; timer: NodeJS.Timeout } | null = null;
  private warming = false;
  /** 这一问用掉了预热会话：答完再备一个。 */
  private rewarmAfterAsk = false;
  /** S3a：列出后的内存清单（编号 → 路径、授权），30 分钟过期。 */
  private agentSessionLists: Map<
    string,
    { root: string; permissionId: string; sessions: AgentSessionPreview[]; expiresAt: number }
  > | null = null;

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
    relations: RelationService;
    research: ResearchChecker;
    coding: CodingOrchestrator;
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
    this.relations = deps.relations;
    this.research = deps.research;
    this.coding = deps.coding;
    this.jobs = deps.jobs;
    this.logger = deps.logger;
    this.localServer = deps.localServer;
    this.conversations = new ConversationStore(deps.db);
    this.todos = new TodoStore(deps.db);
    this.semanticIndex = createSemanticIndex(deps.db);
    // D4：引擎会话活在引擎进程里，上一次运行留下的 engine_session_id 早已失效。
    // 启动时清空，避免重开旧对话时去续一个不存在的会话。
    const cleared = this.conversations.clearEngineSessions();
    if (cleared > 0) {
      this.logger.info('清理上次运行遗留的引擎会话', { conversations: cleared });
    }
    // 上次在回答途中退出时留下的 streaming 占位：新进程里不可能还在回答。
    const interrupted =
      this.conversations.failInterruptedMessages('应用在回答过程中退出，这一轮没有完成。');
    if (interrupted > 0) {
      this.logger.info('收尾上次运行中断的回答', { messages: interrupted });
    }
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
    backupThenMigrate(db, layout, logger);
    const vault = new Vault(layout.vaultDir);
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const projects = new ProjectService(db);
    const search = new SearchService(db);
    const imports = new ImportService(db, vault, permissions, sources);
    const items = new ItemService(db);
    const relations = new RelationService(db);
    // 搜索执行器惰性解析：构造时配置未必就绪，闭包经 runtimeRef 在检查时取当前值
    const research = new ResearchChecker(
      db,
      systemClock,
      desktopResearchFetchDeps(() => runtimeRef.current?.getTinyFishFetcher() ?? undefined),
      () => runtimeRef.current?.getWebSearchExecutor() ?? undefined,
      () => runtimeRef.current?.getProvider() ?? null,
    );
    const coding = new CodingOrchestrator(db, createCodingExecutor(), resolved.dataDir);
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
      getWebSearchExecutor: () => runtimeRef.current?.getWebSearchExecutor() ?? null,
      fetchWebPage: async (url: string) => {
        const rt = runtimeRef.current;
        if (!rt) throw new IxaError(ErrorCodes.SERVER_UNAVAILABLE, '运行时不可用');
        const deps = desktopResearchFetchDeps(() => rt.getTinyFishFetcher() ?? undefined);
        const fetched = await fetchApprovedSource(url, deps);
        return {
          finalUrl: fetched.finalUrl,
          status: fetched.status,
          excerpt: fetched.body.slice(0, 3000),
        };
      },
      getCodingOrchestrator: () => {
        const rt = runtimeRef.current;
        if (!rt) throw new IxaError(ErrorCodes.SERVER_UNAVAILABLE, '运行时不可用');
        return rt.coding;
      },
      hermesTool: (name, args) => {
        const rt = runtimeRef.current;
        if (!rt) throw new IxaError(ErrorCodes.SERVER_UNAVAILABLE, '运行时不可用');
        return rt.hermesTool(name, args);
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
      relations,
      research,
      coding,
      jobs,
      logger,
      localServer,
    });
    runtimeRef.current = runtime;
    runtime.registerJobHandlers();
    // RF08：旧版落盘的 plain:（Base64 可逆编码）密钥迁移 ——
    // 系统加密可用 → 原地升级为 safeStorage 密文；不可用 → 清除旧值
    //（保持可理解可恢复：用户在设置页重新输入），两种路径都不把
    // 可解码原文继续留在磁盘上。
    runtime.migrateLegacyPlainApiKey();
    const requeued = jobs.requeueNetworkFailures();
    if (requeued > 0) {
      logger.info('已把因网络失败的分析任务重新排队', { count: requeued });
    }
    jobs.start();
    // C02：启动阶段先恢复上一运行代次真正遗留的 running 任务
    //（此时队列必空闲，running 记录没有执行者），再扫描欠分析来源
    runtime.recoverOrphanedJobs();
    runtime.coding.store.markUnknownRunning();
    runtime.sweepPendingAnalysis();
    runtime.startResearchScheduler();
    // A06：上一进程遗留的 running 运行账本行没有执行者——按崩解标
    // failed（不冒充仍在运行）。与任务队列的孤儿恢复同一口径。
    const orphanRuns = AgentSession.recoverOrphanedRuns(runtime.db);
    if (orphanRuns > 0) {
      logger.info('已收尾上一进程遗留的运行账本', { count: orphanRuns });
    }
    try {
      const ext = syncBundledExtension();
      runtime.extensionLoadDir = ext.loadUnpackedDir;
      logger.info('扩展已同步到加载目录', {
        dir: ext.loadUnpackedDir,
        available: ext.available,
      });
    } catch (err) {
      logger.warn('扩展同步失败（不影响其它功能）', { error: String(err) });
    }
    await runtime.startServer();
    // R2：启动后在后台补齐记忆向量（不阻塞启动；Ollama 没开时只记一次日志）
    runtime.kickSemanticBackfill();
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

  /** S3a：扫描文件夹，返回带清单号的会话列表（渲染层只拿编号）。 */
  async listAgentSessions(input: { root: string; permissionId: string }) {
    // 授权必须真的覆盖这个目录：列出会读目录下所有会话的开头与末尾，
    // 不能只靠调用方传了个 id 就放行（整合方复审 2026-09-20 补）。
    const perm = this.permissions.get(input.permissionId);
    if (!perm || perm.status !== 'active' || !isPathInside(perm.locator, input.root)) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '这个文件夹没有有效授权，不能列出会话');
    }
    const preview = this.imports.previewAgentSessions(input.root);
    const listId = randomUUID();
    (this.agentSessionLists ??= new Map()).set(listId, {
      root: input.root,
      permissionId: input.permissionId,
      sessions: preview.sessions,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    return {
      listId,
      sessions: preview.sessions.map(({ path: _p, ...rest }) => rest),
      unrecognizedCount: preview.unrecognizedCount,
      subagentCount: preview.subagentCount,
    };
  }

  async estimateAgentSessions(input: { listId: string; ids: number[] }) {
    const list = this.requireAgentSessionList(input.listId, input.ids);
    return this.imports.estimateAgentSessions(list.root, input.ids, list.sessions);
  }

  async importAgentSessions(input: { listId: string; ids: number[]; projectId: string | null }) {
    const list = this.requireAgentSessionList(input.listId, input.ids);
    const opts = { permissionId: list.permissionId, projectId: input.projectId };
    const result = this.imports.importSelectedAgentSessions(
      list.root,
      input.ids,
      opts,
      list.sessions,
    );
    for (const source of result.pendingExtraction) this.enqueueExtract(source.id, true);
    return {
      created: result.created.length,
      unchanged: result.unchanged.length,
      failed: result.failed,
    };
  }

  private requireAgentSessionList(listId: string, ids: number[]) {
    const list = this.agentSessionLists?.get(listId);
    if (!list || Date.now() > list.expiresAt) {
      this.agentSessionLists?.delete(listId);
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '清单号无效或已过期');
    }
    if (ids.some((id) => !list.sessions.some((s) => s.id === id)))
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '编号不在这次清单里');
    return list;
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
         WHERE s.archived_at IS NULL
           AND s.content_revision > s.analyzed_revision
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
      if (this.sources.isArchived(payload.sourceId)) {
        const err = new IxaError(
          ErrorCodes.JOB_CANCELLED,
          '提取已取消（来源已归档，不再生成现行理解）',
        ) as IxaError & { jobCancelled: boolean };
        err.jobCancelled = true;
        throw err;
      }
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
      // E5：本机向量服务用来认出聊天存档里 AI 复述已注入记忆的回声（没开时只做字面比对）
      const index = this.semanticIndex;
      const extractor = new Extractor(this.db, provider, {
        similarity: index ? (texts, refs) => index.maxSimilarity(texts, refs) : undefined,
      });
      // 修复 M0.2 第 6 条：任务以「开始执行时的内容版本」为目标版本 ——
      // 执行期间的新内容不会混入本次结果，由完成后的滞后检查补分析。
      const targetRevision = this.sources.getRevisions(payload.sourceId).content;
      // 修复 G1：把队列的真实取消信号（ctx.signal）与自动任务的开关/暂停检查
      // 组合 —— 手动与自动任务都受取消约束；取消发生在模型等待期间时，
      // 已发出的网络请求无法收回，但不再发送后续块、不提交结果、不推进版本。
      // 聊天优先：提问期间队列处于让路状态，本任务在下一次模型调用之前停下，
      // 回到排队稍后重做（提取是整份替换，半途的结果不提交）。
      const stats = await extractor
        .extractSource(payload.sourceId, {
          shouldContinue: () => !ctx.signal.aborted && autoGuardSatisfied() && !this.jobs.isHeld(),
        })
        .catch((err: unknown) => {
          if ((err as { jobCancelled?: boolean }).jobCancelled && this.jobs.isHeld()) {
            (err as { jobPreempted?: boolean }).jobPreempted = true;
          }
          throw err;
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
      // 成功但有话要说：引用核对不上的结论被丢掉了，用户有权知道丢了几条。
      if (stats.skippedBadRef > 0) {
        this.db
          .prepare('UPDATE jobs SET note = ? WHERE id = ?')
          .run(
            `本次有 ${stats.skippedBadRef} 条结论的依据和原文对不上，已丢弃；其余 ${stats.inserted} 条照常入库。可点「重新分析」再试一次。`,
            job.id,
          );
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
      // R2：新提炼出的记忆立刻补向量，不等下一问。
      void this.kickSemanticBackfill();
    });
  }

  /**
   * RF08：旧版落盘的 plain:（Base64 可逆编码，非加密）API Key 迁移。
   * - safeStorage 可用：解码后立即用系统加密重存，旧值被覆盖，
   *   可解码原文不再留在磁盘（迁移本身记审计，不记录密钥内容）。
   * - safeStorage 不可用：清除旧值并把 apiKeyPresent 置 false ——
   *   保持可理解、可恢复的状态（设置页可见「需要重新输入」），
   *   绝不让明文可逆密钥继续静默落盘。
   * 返回值：'migrated' | 'cleared' | null（无旧格式密钥）。
   */
  migrateLegacyPlainApiKey(): 'migrated' | 'cleared' | null {
    const encrypted = this.config.model.apiKeyEncrypted;
    if (!encrypted || !encrypted.startsWith('plain:')) return null;
    const plain = decodeLegacyPlainApiKey(encrypted);
    if (safeStorage.isEncryptionAvailable() && plain) {
      const reencrypted = safeStorage.encryptString(plain).toString('base64');
      this.config = {
        ...this.config,
        model: { ...this.config.model, apiKeyEncrypted: reencrypted, apiKeyPresent: true },
      };
      saveConfig(this.configFile, this.config);
      recordAudit(this.db, 'settings.api_key_migrated', { from: 'plain', to: 'safeStorage' });
      this.logger.info('旧 plain: API Key 已迁移为系统加密存储（RF08）', {});
      return 'migrated';
    }
    this.config = {
      ...this.config,
      model: { ...this.config.model, apiKeyEncrypted: null, apiKeyPresent: false },
    };
    saveConfig(this.configFile, this.config);
    recordAudit(this.db, 'settings.api_key_cleared', {
      from: 'plain',
      reason: 'encryption_unavailable',
    });
    this.logger.warn(
      '系统加密不可用：旧 plain: API Key 已从磁盘清除，需要用户在设置页重新输入（RF08）',
      {},
    );
    return 'cleared';
  }

  /**
   * RF08：设置页提示 —— 旧明文密钥被清除后需要重新输入（从审计事件推导，
   * 不在 config.json 里新增持久状态）。
   */
  apiKeyNeedsReentry(): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS one FROM audit_events
         WHERE kind = 'settings.api_key_cleared' LIMIT 1`,
      )
      .get() as { one: number } | undefined;
    return row !== undefined && !this.config.model.apiKeyPresent;
  }

  /**
   * 当前可用的模型提供者。API Key 解密失败或未配置时返回 null。
   * 测试可用 IXAEON_FAKE_MODEL=1 注入 FakeProvider（绝不连接网络）；
   * 配合 IXAEON_FAKE_MODEL_SCRIPT 指向的 JSON 脚本文件可预置结构化响应
   * （仅该环境变量存在时读取；正常用户运行不受影响，不构成任意写库入口）。
   */
  getProvider(): ModelProvider | null {
    if (process.env.IXAEON_FAKE_MODEL === '1') {
      const scriptPath = process.env.IXAEON_FAKE_MODEL_SCRIPT;
      if (scriptPath && !this.fakeScriptLoaded) {
        this.fakeScriptLoaded = true;
        try {
          const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as {
            structured?: unknown[];
            text?: string[];
          };
          for (const item of script.structured ?? []) this.fakeProvider.enqueueStructured(item);
          for (const item of script.text ?? []) this.fakeProvider.enqueueText(item);
          this.logger.info('已加载测试模型响应脚本（IXAEON_FAKE_MODEL_SCRIPT）', {});
        } catch (err) {
          this.logger.warn('测试模型响应脚本加载失败', { error: String(err) });
        }
      }
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
      // 配置的 API 地址优先（用户在向导/设置填写）；环境变量仅测试用
      baseUrl: config.model.apiBaseUrl?.trim() || process.env.IXAEON_OPENAI_BASE_URL,
    });
  }

  /**
   * 受控网页搜索执行器（B3）。未配置/未保存 Key/解密失败 → null（search_web 诚实失败）。
   */
  getWebSearchExecutor(): WebSearchExecutor | null {
    const ws = this.config.webSearch;
    if (!ws || ws.provider === 'none' || !ws.apiKeyPresent) return null;
    const encrypted = ws.apiKeyEncrypted;
    if (!encrypted) return null;
    const apiKey = decryptApiKey(encrypted);
    if (!apiKey) {
      this.logger.warn('搜索 API Key 解密失败（可能迁移自其他机器）', {});
      return null;
    }
    try {
      return createWebSearchExecutor(ws.provider, apiKey);
    } catch (err) {
      this.logger.warn('搜索执行器创建失败', { error: String(err) });
      return null;
    }
  }

  /**
   * TinyFish 动态网页抓取器（B3 阶段 2）。配置了 TinyFish 时在遇到 SPA 页面时触发渲染抓取。
   */
  getTinyFishFetcher(): TinyFishFetcher | null {
    const ws = this.config.webSearch;
    if (!ws || ws.provider !== 'tinyfish' || !ws.apiKeyPresent) return null;
    const encrypted = ws.apiKeyEncrypted;
    if (!encrypted) return null;
    const apiKey = decryptApiKey(encrypted);
    if (!apiKey) return null;
    try {
      return createDesktopTinyFishFetcher(apiKey);
    } catch (err) {
      this.logger.warn('TinyFish 抓取器创建失败', { error: String(err) });
      return null;
    }
  }

  /** 设置页「测试搜索」：真实查询一次，结果只回标题/URL/摘要，不落库。 */
  async testWebSearch(input: { query: string; apiKey?: string }): Promise<{
    provider: 'brave' | 'tavily' | 'tinyfish';
    hits: Array<{ title: string; url: string; snippet: string }>;
  }> {
    const query = input.query.trim();
    if (!query) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '测试搜索需要查询词');
    }
    const provider = this.config.webSearch?.provider ?? 'none';
    if (provider === 'none') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '请先选择搜索服务并保存 Key');
    }
    const apiKey = input.apiKey?.trim() ?? '';
    if (!apiKey) {
      const decrypted = this.getWebSearchExecutor();
      if (!decrypted) {
        throw new IxaError(
          ErrorCodes.VALIDATION_FAILED,
          '已保存的 Key 不可用：请重新输入（Key 不回显）',
        );
      }
      const outcome = await decrypted.search(query, 3);
      return { provider: outcome.provider, hits: outcome.hits };
    }
    const outcome = await createWebSearchExecutor(provider, apiKey).search(query, 3);
    return { provider: outcome.provider, hits: outcome.hits };
  }

  /**
   * 拉取上游可用模型列表（设置向导/设置页「获取可用模型」）。
   * Key 只在本次请求内存中使用，不落盘。
   */
  async listAvailableModels(input: {
    apiBaseUrl: string;
    apiKey: string;
  }): Promise<{ models: Array<{ id: string }> }> {
    // 输入框留空时用已保存的 Key（在主进程里解密，只用于这一次请求，不回传界面），
    // 用户换模型就不必每次重新粘贴。但只限 API 地址没变：地址换成另一家服务时
    // 还沿用旧 Key，等于把 A 家的密钥发给 B 家（用户 2026-09-17 要求兼顾隐私）。
    let apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      const saved = this.config.model;
      if (!saved.apiKeyPresent || !saved.apiKeyEncrypted) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, '还没有保存过 API Key，请先填写');
      }
      if (normalizeApiBase(input.apiBaseUrl) !== normalizeApiBase(saved.apiBaseUrl)) {
        throw new IxaError(
          ErrorCodes.VALIDATION_FAILED,
          'API 地址和已保存的不一样。为避免把原来的密钥发给新地址，请填写这个地址对应的 API Key',
        );
      }
      apiKey = decryptApiKey(saved.apiKeyEncrypted) ?? '';
      if (apiKey.length === 0) {
        throw new IxaError(
          ErrorCodes.VALIDATION_FAILED,
          '已保存的 API Key 无法解密（可能来自另一台电脑），请重新填写',
        );
      }
    }
    try {
      const models = await listUpstreamModels({
        apiBaseUrl: input.apiBaseUrl,
        apiKey,
      });
      return { models };
    } catch (err) {
      throw new IxaError(
        ErrorCodes.MODEL_CALL_FAILED,
        `获取模型列表失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 问答：先探 Hermes，未接通则走 Core 有界工具循环。不是单轮检索冒充 Agent。 */
  /**
   * A03（审核 2026-09-13）：问答存档的授权状态机。
   * - 从无 ask.ixaeon.local 授权行 → 首次建档（用户 2026-09-13「所有问答
   *   都进 Core」的常设指示，建档本身记审计）。
   * - 存在 revoked 行且无 active 行 → 用户已撤销：返回 null，普通提问
   *   不隐式重建授权、不存档（重启/再问都保持停用）。
   * - 存在 active 行（含撤销后经显式入口恢复的新行）→ 正常存档。
   */
  private ensureAskCapturePermission(): Permission | null {
    const rows = this.db
      .prepare("SELECT * FROM permissions WHERE locator='ask.ixaeon.local' ORDER BY granted_at")
      .all() as Permission[];
    if (rows.length === 0) {
      const created = this.permissions.grantDomain('ask.ixaeon.local');
      recordAudit(this.db, 'ask.capture_first_grant', { permissionId: created.id });
      return created;
    }
    const active = rows.find((p) => p.status === 'active');
    return active ?? null;
  }

  /** 问答存档当前状态（设置页显示）：enabled / revoked。 */
  askCaptureStatus(): 'enabled' | 'revoked' {
    const rows = this.db
      .prepare(
        "SELECT status FROM permissions WHERE locator='ask.ixaeon.local' ORDER BY granted_at",
      )
      .all() as Array<{ status: string }>;
    if (rows.length === 0) return 'enabled';
    return rows.some((r) => r.status === 'active') ? 'enabled' : 'revoked';
  }

  /** 显式恢复入口（设置页）：撤销后重新开启问答存档；记录审计。 */
  enableAskCapture(): 'enabled' {
    const current = this.ensureAskCapturePermission();
    if (!current) {
      const created = this.permissions.grantDomain('ask.ixaeon.local');
      recordAudit(this.db, 'ask.capture_enabled', { permissionId: created.id });
    } else {
      recordAudit(this.db, 'ask.capture_enabled', { permissionId: current.id });
    }
    return 'enabled';
  }

  /**
   * 权限或披露变更时使全部长驻引擎上下文失效（D02）。
   * D4：改为遍历所有对话的会话——撤权必须对每个对话都生效，
   * 不能因为切到另一个对话就还拿着旧披露纪元的引擎上下文。
   *
   * 这里只丢进程内的会话，不写库：conversations.engine_session_id 由启动时的
   * clearEngineSessions() 统一清理，一列一个归属。stop() 也走这条路径，
   * 关机时不该再往正要关闭的库里写一遍冗余的 null。
   */
  invalidateContext(contextRef?: string): void {
    for (const session of this.askSessions.values()) {
      session.invalidateContext(contextRef);
    }
    this.askSessions.clear();
    this.disposeWarmSession();
  }

  /** 显式停用入口（设置页）：撤销问答存档授权；已存记录保留但不新增。 */
  disableAskCapture(): 'revoked' {
    const rows = this.db
      .prepare("SELECT id FROM permissions WHERE locator='ask.ixaeon.local' AND status='active'")
      .all() as Array<{ id: string }>;
    if (rows.length === 0) {
      // 尚无记录（初次提问前用户即关闭）：显式写入已撤销记录，固化停用决定
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at)
           VALUES (?, 'domain', 'ask.ixaeon.local', 'continuous', 'revoked', ?, ?)`,
        )
        .run(id, now, now);
      recordAudit(this.db, 'ask.capture_disabled', { permissionId: id });
    } else {
      for (const row of rows) {
        this.permissions.revoke(row.id);
        recordAudit(this.db, 'ask.capture_disabled', { permissionId: row.id });
      }
    }
    this.invalidateContext();
    return 'revoked';
  }

  /**
   * 提问。
   *
   * D3/D4：提问现在必定落在某个对话里。不传 conversationId 就新建一个——
   * 没有「对话之外的提问」这种东西，否则消息就没有归属，重启后也找不回来。
   * 历史轮次从 ConversationStore 取，随本轮一起交给引擎（见 AgentSession.run
   * 的 priorTurns）；引擎会话按对话隔离，两个对话交替提问不会串台。
   */
  async ask(input: {
    conversationId?: string | null;
    projectId: string | null;
    question: string;
  }): Promise<AskResult & { conversationId: string; userMessageId: string; messageId: string }> {
    const { projectId, question } = input;
    this.cancelledAskRuns ??= new Set();
    // A06（审核 2026-09-13）：Hermes 引擎不依赖 IXAEON 的模型配置（那是
    // core-bounded 兜底循环用的）。真 Hermes 可用时即使未配 key 也要放行——
    // 否则「装了引擎却用不上」。两者都没有才如实拒绝。
    const provider = this.getProvider();
    const hermesAvailable = this.hermesFound();
    if (!provider && !hermesAvailable) {
      throw new IxaError(
        ErrorCodes.MODEL_NOT_CONFIGURED,
        'IXA0010 模型未配置：请在设置中填写 OpenAI API Key，或安装 Hermes 引擎后使用问答',
      );
    }

    // R2：新提炼出的记忆先补向量。这里只是发起，等在下面——先把问题和占位回答落库，
    // 界面立刻看得到这一问，再去等向量。
    void this.kickSemanticBackfill();

    const conversation =
      input.conversationId != null && input.conversationId.length > 0
        ? this.conversations.get(input.conversationId)
        : this.conversations.create({ projectId });
    const conversationId = conversation.id;

    // 先取历史，再落本轮提问——否则会把刚问的这句当成「此前的内容」喂回去。
    const priorTurns = this.conversations
      .recentTurns(conversationId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const userMessage = this.conversations.appendMessage(conversationId, {
      role: 'user',
      content: question,
    });
    const userTodoTitle = parseUserTodo(question);
    const userTodo = userTodoTitle
      ? this.todos.add({
          title: userTodoTitle,
          conversationId,
          messageId: userMessage.id,
        })
      : null;
    // 紧跟着占住回答的位置（streaming 占位），再去等模型。
    // 回答的 seq 必须是真实分配的，不能用 userMessage.seq + 1 去「预测」：
    // 同一对话两问并发时，A 的问题是 1、B 的问题是 2，A 预测的「2」其实是
    // B 的问题——派生来源里 A 的回答会被当成旧版本覆盖掉（整合复核时复现过）。
    // 两次落库之间没有 await，所以问与答的 seq 必然相邻。
    // 这也是第 2 周流式输出要的结构：分片直接追加到这条占位消息上。
    const assistantMessage = this.conversations.appendMessage(conversationId, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    // 聊天优先：后台分析与聊天共用同一个模型网关账号（有并发上限），提问期间让后台
    // 分析让路，答完再继续（2026-09-18 真机：两边抢名额，聊天被 429 拒到超时）。
    // 紧挨着 try 获取、在 finally 释放——中间出任何错都不会让后台分析永远停着。
    const releaseJobs = (this.jobs as JobQueue | undefined)?.hold() ?? (() => undefined);

    // S1：回答分段。推给界面是即时的；写库合并成每 200ms 一次（≤5 次/秒），
    // 结束或失败时把剩下的写掉——失败时用户也能看到已经答出的那半截。
    // 推送或写库出错只记下、不往外抛：分段是锦上添花，不能把 Hermes 的事件流打断。
    let pendingDelta = '';
    let lastDeltaWrite = 0;
    let deltaTimer: NodeJS.Timeout | null = null;
    const flushDeltas = (): void => {
      if (deltaTimer) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
      }
      if (this.cancelledAskRuns.has(runId) || pendingDelta.length === 0) {
        pendingDelta = '';
        return;
      }
      const chunk = pendingDelta;
      pendingDelta = '';
      lastDeltaWrite = Date.now();
      try {
        this.conversations.appendContent(assistantMessage.id, chunk);
      } catch {
        /* 库已关闭等：最终内容由 finishMessage 写入，这里丢一段不影响结果 */
      }
    };
    const emitProgress = (phase: AskPhase): void => {
      if (this.cancelledAskRuns.has(runId)) return;
      try {
        this.askProgressSink?.({
          conversationId,
          messageId: assistantMessage.id,
          phase,
        });
      } catch {
        /* 窗口已关闭等：界面收不到进度，回答照常完成 */
      }
    };
    emitProgress('preparing');
    const onDelta = (text: string): void => {
      if (this.cancelledAskRuns.has(runId) || text.length === 0) return;
      pendingDelta += text;
      try {
        this.askDeltaSink?.({ conversationId, messageId: assistantMessage.id, delta: text });
      } catch {
        /* 窗口已关闭等：界面收不到分段，回答照常完成 */
      }
      const wait = 200 - (Date.now() - lastDeltaWrite);
      if (wait <= 0) {
        flushDeltas();
      } else if (!deltaTimer) {
        deltaTimer = setTimeout(flushDeltas, wait);
        deltaTimer.unref?.();
      }
    };

    try {
      // 选材前把向量补齐（有上限），别让第一问抢在补向量前面走关键词路径。
      await this.awaitSemanticBackfill();
      // A06：同一对话复用 AgentSession（进而复用引擎侧 Hermes 会话）。
      // D4：按 conversationId 取，不再是全局单例。
      // P1：对话还没有会话时，先接过预热好的那个（省掉 5–9 秒组装），没有才新建。
      const session =
        this.askSessions.get(conversationId) ??
        this.adoptWarmSession(projectId) ??
        this.newAskSession().session;
      this.askSessions.set(conversationId, session);
      this.activeAskRuns.set(conversationId, runId);
      const result = await session.run({
        goal: question,
        projectId,
        runId,
        priorTurns,
        onDelta,
        onProgress: (phase) => emitProgress(phase),
      });
      flushDeltas();
      // 用户指示（2026-09-13）：所有问答内容都进 Core。
      // A03（审核 2026-09-13）：问答存档挂独立的启用/撤销状态——
      // 用户在授权列表撤销过 ask.ixaeon.local 后，普通提问**不再隐式重建授权**，
      // 重启/再次提问都保持停用；恢复需要走显式入口（设置页 enableAskCapture）。
      // 有实际回答时把问答对存为 ask_session 来源并入队提取（走既有
      // 「提案→用户确认」管线）；存档/提取失败不吞掉回答，如实附注。
      // T2b：这一轮新建的编码任务逐个进待办——拍板「要做」= 批准并排队（acceptTodo）、
      // 「不做」= 取消（rejectTodo），状态一律以任务表为准。
      // 你拒绝过的同样的事：起草的任务自动取消，不出现在回答上。
      const codingTodos: Array<{ id: string; title: string }> = [];
      try {
        const tasks = this.db
          .prepare(
            `SELECT id, goal FROM coding_tasks
             WHERE created_at >= ? AND project_id IS NOT NULL
             ORDER BY created_at DESC LIMIT 5`,
          )
          .all(startedAt) as Array<{ id: string; goal: string }>;
        for (const t of tasks) {
          const title = t.goal.split('\n')[0]!.trim().slice(0, 80);
          if (title.length === 0) continue;
          const row = this.todos.propose({
            title,
            conversationId,
            messageId: assistantMessage.id,
            linked: { kind: 'coding_task', id: t.id },
          });
          if (row) codingTodos.push({ id: row.id, title: row.title });
          else this.coding.cancel(t.id);
        }
      } catch {
        // ignore
      }

      // T2a：回答末尾的「建议待办」由代码变成待办（见下面 finishMessage 前），
      // 存档、消息正文、返回值都用拆掉这一段之后的回答——否则同一件事会被
      // 记忆提炼再记成一条「AI 建议」，下一轮背景里也会带着它。
      const extracted = extractSuggestedTodos(result.answer);
      result.answer = extracted.answer;

      if (result.answer.trim().length > 0 && result.engine !== 'missing') {
        const askPerm = this.ensureAskCapturePermission();
        if (askPerm) {
          try {
            const captured = this.imports.captureAsk({
              question,
              answer: result.answer,
              conversationId,
              userSeq: userMessage.seq,
              assistantSeq: assistantMessage.seq,
              runId,
              engine: result.engine,
              model: result.modelName,
              projectId,
              permissionId: askPerm.id,
            });
            if (captured.created) {
              this.conversations.setSourceId(conversationId, captured.source.id);
            }
            this.enqueueExtract(captured.source.id, false);
            result.notice = `${result.notice}；问答已存入 IXAEON 记忆（日常偏好与事实自动沉淀生效；若有冲突或关键决策，将在「待讨论」等你确认）。`;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn('问答落 Core 失败', { runId, error: message });
            recordAudit(this.db, 'ask.capture_failed', { runId, error: message.slice(0, 300) });
            result.notice = `${result.notice}；注意：问答存档失败（${message.slice(0, 120)}）。`;
          }
        } else {
          result.notice = `${result.notice}；问答存档已停用（授权曾被撤销）。如需恢复请在设置中开启「问答存档」。`;
        }
      }

      // D3/D4：回答收尾到占位消息上。取消的回合按 cancelled 记，不冒充完成——
      // 下一轮的 priorTurns 只取 complete，半截回答不会变成背景。
      const cancelled = result.notice?.includes('用户取消') === true;
      const proposedTodos: Array<{ id: string; title: string }> = [...codingTodos];
      if (!cancelled) {
        for (const title of extracted.todos) {
          const row = this.todos.propose({
            title,
            conversationId,
            messageId: assistantMessage.id,
          });
          if (row) proposedTodos.push({ id: row.id, title: row.title });
        }
      }
      this.conversations.finishMessage(assistantMessage.id, {
        content: extracted.answer,
        status: cancelled ? 'cancelled' : 'complete',
        runId,
        engine: result.engine,
        modelName: result.modelName,
        citations: result.citations,
        meta: {
          notice: result.notice,
          usedChars: result.usedChars,
          coverage: result.coverage,
          steps: result.steps,
          // E5：这一轮给模型看了哪些记忆——回答下面列出来供当场纠正；
          // 提炼这段回答时据此认出复述（回声）。空数组也要存：表示「这一轮一条都没给」。
          memoryUsed: result.memoryUsed,
          // P3：这一轮带上的项目近况计数（没带不写；回答下面一行灰字用它）。
          ...(result.projectBrief ? { projectBrief: result.projectBrief } : {}),
          ...(proposedTodos.length > 0 ? { proposedTodos } : {}),
          ...(userTodo ? { userTodo: { id: userTodo.id, title: userTodo.title } } : {}),
        },
      });
      // 引擎会话 id 落库：仅用于显示「这个对话上次用的是哪个引擎会话」。
      // 它进程内有效，下次启动会被 clearEngineSessions 清掉。
      this.conversations.setEngineSession(
        conversationId,
        result.engine,
        session.getEngineSessionId(),
      );

      return {
        ...result,
        conversationId,
        userMessageId: userMessage.id,
        messageId: assistantMessage.id,
      };
    } catch (err) {
      // 失败也要在对话里留痕：把占位消息收尾成 failed，否则用户看到的是
      // 一句话发出去、然后一个永远在转圈的空气泡。已经答出的那半截先写进去。
      flushDeltas();
      const message = err instanceof Error ? err.message : String(err);
      try {
        this.conversations.finishMessage(assistantMessage.id, {
          status: 'failed',
          runId,
          errorMessage: message.slice(0, 500),
          // 回答失败，你写的「待办：…」照样加上了：提示也要留着
          ...(userTodo ? { meta: { userTodo: { id: userTodo.id, title: userTodo.title } } } : {}),
        });
      } catch {
        // 收尾本身失败（例如库已关闭）不能盖掉原始错误；
        // 遗留的 streaming 占位由下次启动时的 failInterruptedMessages 清理。
      }
      throw err;
    } finally {
      releaseJobs();
      if (this.rewarmAfterAsk) {
        // 刚用掉了预热的会话：这一问答完后再备一个，下一个新对话也不用等组装
        this.rewarmAfterAsk = false;
        const t = setTimeout(() => void this.prewarmChat(projectId), 1_000);
        t.unref?.();
      }
      if (this.activeAskRuns.get(conversationId) === runId) {
        // A06：正常终态保留会话引用供复用（复用是引擎侧同 session_id 的
        // 连续性，不是执行状态残留）；这里只清掉「在跑」的标记。
        this.activeAskRuns.delete(conversationId);
      }
      this.cancelledAskRuns.delete(runId);
    }
  }

  /**
   * 聊天（Hermes）用哪个模型：设置页的「聊天模型」，留空则跟随分析用的模型。
   * 都为空时返回 null —— 不干预，用 Hermes 自己 config.yaml 里的。
   */
  chatModelName(): string | null {
    const m = this.config.model;
    return m.chatModelName?.trim() || m.modelName?.trim() || null;
  }

  /** 记忆桥开着时的 Hermes 专用令牌；关着返回 null（启动网关时就不传）。 */
  hermesBridgeToken(): string | null {
    // 测试里用 Object.create 搭的运行时可能没有 config：当作记忆桥关着
    const b = (this.config as AppConfig | undefined)?.hermesBridge;
    return b?.enabled === true && b.token ? b.token : null;
  }

  /**
   * 记忆桥（F1）：Hermes 经 MCP 调来的工具。受众一律是 model——与聊天自动附带的记忆
   * 同一套规则（含个人结论、不含个人聊天原文）。编码类工具不在此列，由 localServer
   * 的白名单挡在外面。
   */
  async hermesTool(name: HermesBridgeToolName, args: Record<string, unknown>): Promise<unknown> {
    recordAudit(this.db, 'hermes_bridge.tool', { name });
    if (name === 'search_memory') {
      const query = String(args.query ?? '').trim();
      if (!query) throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'search_memory 需要 query');
      const limit = Math.min(12, Math.max(1, Math.trunc(Number(args.limit ?? 8)) || 8));
      await this.awaitSemanticBackfill();
      const r = await new ContextSelector(this.db).selectForQuestionHybrid(query, null, {
        audience: 'model',
        maxItems: limit,
        semantic: this.semanticIndex,
      });
      return {
        today: localDay(new Date()),
        items: r.items.map((i) => ({
          id: i.id,
          type: i.type,
          statement: i.statement,
          origin: memoryOriginTag(i),
          recordedAt: localDay(i.recordedAt),
          // E1：事情本身已经过去（内容日期已过或用户确认已结束），别当成眼下的事
          ...(i.over ? { over: i.pastDay ? `所述日期 ${i.pastDay} 已过` : '用户确认已结束' } : {}),
        })),
        notice: r.retrievalNotice ?? (r.items.length === 0 ? '没有找到相关记忆。' : null),
        ...(includesAiAdvice(r.items) ? { adviceNote: AI_ADVICE_NOTE } : {}),
      };
    }
    const broker = new CoreToolBroker(this.db, this.items, this.search, this.coding, this.projects);
    const ctx = { audience: 'model' as const, runId: 'hermes-bridge', projectId: null };
    if (name === 'get_evidence') return broker.invoke('get_evidence', { itemId: args.itemId }, ctx);
    return broker.invoke('record_observation', { statement: args.statement }, ctx);
  }

  /** E6：个人记忆给聊天用的开关状态，以及没归项目的记忆有多少条（设置页用）。 */
  personalMemoryToChatStatus(): { enabled: boolean; personalItems: number } {
    const personalItems = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM items
           WHERE scope != 'project' AND state IN ('current', 'disputed')
             AND shelved_at IS NULL AND confirmation != 'rejected'`,
        )
        .get() as { n: number }
    ).n;
    return { enabled: personalMemoryToChat(this.db), personalItems };
  }

  /**
   * E6：开关「个人记忆给聊天用」。只影响 IXAEON 自己的聊天（model 受众）；
   * 编码客户端仍须逐条分享。开关一变，带着旧可见范围的会话（含预热的）一并作废。
   */
  setPersonalMemoryToChat(enabled: boolean): { enabled: boolean; personalItems: number } {
    setPersonalMemoryToChat(this.db, enabled);
    this.invalidateContext();
    return this.personalMemoryToChatStatus();
  }

  /** 记忆桥当前状态（设置页用）：开着没有；关着的话现在能不能开、不能开为什么。 */
  hermesBridgeStatus(locate: () => HermesLocator = locateHermes): {
    enabled: boolean;
    blockedReason: string | null;
  } {
    const enabled = this.hermesBridgeToken() !== null;
    return { enabled, blockedReason: enabled ? null : bridgeBlockedReason(locate()) };
  }

  /**
   * 开关记忆桥（F1）。
   * - 开：Hermes 的模型网关必须是 HTTPS → 在 Hermes 配置里登记 mcp_servers.ixaeon
   *   （先备份）→ 生成新令牌。登记失败就不开。
   * - 关：**先作废令牌**（旧网关进程手里的立即失效），再把 Hermes 配置改成
   *   enabled: false——改配置失败也已经关上了，只提示一句。
   * 两种情况都丢掉在跑的引擎会话：令牌是网关的启动参数。
   * deps 仅供测试替换（真实 Hermes 的写入另有测试覆盖）。
   */
  async setHermesBridge(
    enabled: boolean,
    deps: {
      locate?: () => HermesLocator;
      write?: typeof writeHermesBridgeEntry;
      execPath?: string;
    } = {},
  ): Promise<{ enabled: boolean; backupPath: string | null; warning: string | null }> {
    const locator = (deps.locate ?? locateHermes)();
    const write = deps.write ?? writeHermesBridgeEntry;
    const execPath = deps.execPath ?? process.execPath;
    if (enabled) {
      const blocked = bridgeBlockedReason(locator);
      if (blocked) throw new IxaError(ErrorCodes.VALIDATION_FAILED, blocked);
      const backupPath = await write(locator, bridgeEntry(execPath, true));
      this.updateConfig((c) => ({
        ...c,
        hermesBridge: { enabled: true, token: randomBytes(32).toString('hex') },
      }));
      this.resetChatSessions();
      recordAudit(this.db, 'hermes_bridge.enabled', {});
      return { enabled: true, backupPath, warning: null };
    }
    this.updateConfig((c) => ({ ...c, hermesBridge: { enabled: false, token: null } }));
    this.resetChatSessions();
    recordAudit(this.db, 'hermes_bridge.disabled', {});
    try {
      const backupPath = await write(locator, bridgeEntry(execPath, false));
      return { enabled: false, backupPath, warning: null };
    } catch (err) {
      return {
        enabled: false,
        backupPath: null,
        warning:
          '记忆桥已关闭（令牌已作废，Hermes 查不到记忆了），但 Hermes 配置没能改成停用：' +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  /**
   * 换了聊天模型后，丢掉在跑的引擎会话：模型是网关启动参数，旧进程不会改模型。
   * 先 invalidateContext 让长驻网关进程退出，再清空映射，下一问从新进程开始。
   */
  resetChatSessions(): number {
    const n = this.askSessions.size;
    for (const session of this.askSessions.values()) session.invalidateContext();
    this.askSessions.clear();
    this.conversations.clearEngineSessions();
    this.disposeWarmSession();
    return n;
  }

  /** 新建一个问答会话（含它自己的 Hermes 适配器）。提问与预热共用，两条路建出来的完全一样。 */
  private newAskSession(): { session: AgentSession; adapter: HermesRuntimeAdapter } {
    const broker = new CoreToolBroker(
      this.db,
      this.items,
      this.search,
      this.coding,
      this.projects,
      desktopResearchFetchDeps(() => this.getTinyFishFetcher() ?? undefined),
      this.getWebSearchExecutor() ?? undefined,
    );
    const adapter = new HermesRuntimeAdapter(broker, undefined, () => ({
      chatModel: this.chatModelName(),
      bridgeToken: this.hermesBridgeToken(),
    }));
    const bridged = this.hermesBridgeToken() !== null;
    const session = new AgentSession(this.db, adapter, broker, this.getProvider(), {
      semantic: this.semanticIndex,
      // F1 记忆桥：开着时才让模型调 IXAEON 的记忆工具（关着时 Hermes 里没有这些工具）。
      memoryBridge: bridged,
      // 记忆桥工具由 Hermes 经 MCP 执行（结果经协议回交），网关侧不在本地重复执行；
      // 名字是 Hermes 里的真名 mcp__ixaeon__<工具>，账本据此标注执行方。
      mcpBridgedTools: bridged ? [...HERMES_BRIDGE_TOOL_WIRE_NAMES] : [],
    });
    return { session, adapter };
  }

  /**
   * P1 会话预热：备一个已经建好 Hermes 会话的空闲问答会话，新对话第一问直接接过去用。
   *
   * 2026-09-18 真机时间线：新会话建好后，Hermes 要花 5–9 秒组装助手（发现工具、查模型
   * 信息），期间没有任何输出——用户每开一个新对话都要白等这一段。Hermes 在建会话时就
   * 在后台组装，所以提前建好即可。
   *
   * 只备一个；有问题正在答时不预热（Hermes 组装时也会访问模型网关，别和正在进行的提问
   * 抢网关账号的并发名额）；20 分钟没被用掉就释放（空闲的 Hermes 进程占内存）。
   * 预热失败什么都不影响：第一问照常冷启动。
   */
  async prewarmChat(projectId: string | null): Promise<{ warmed: boolean }> {
    if (!this.hermesFound()) return { warmed: false };
    if (this.activeAskRuns.size > 0) return { warmed: false };
    const contextRef = projectId ?? 'personal';
    if (this.warm?.contextRef === contextRef) return { warmed: true };
    if (this.warming) return { warmed: false };
    this.disposeWarmSession();
    const { session, adapter } = this.newAskSession();
    this.warming = true;
    try {
      const ready = await adapter.prewarm({
        runId: `prewarm-${randomUUID()}`,
        goal: '',
        contextRef,
        allowedTools: [...CORE_TOOL_NAMES],
        permissionVersion: getDisclosureEpoch(this.db),
        budget: { maxToolCalls: 4, timeoutMs: 120_000 },
        idempotencyKey: `prewarm-${contextRef}`,
      });
      if (!ready) return { warmed: false };
      const timer = setTimeout(() => this.disposeWarmSession(), 20 * 60_000);
      timer.unref?.();
      this.warm = { session, contextRef, timer };
      return { warmed: true };
    } catch (err) {
      session.invalidateContext();
      this.logger.info('会话预热失败，第一问照常冷启动', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { warmed: false };
    } finally {
      this.warming = false;
    }
  }

  /** 接过预热好的会话（同一个 contextRef 才接）。接走后腾出位置，等这一问结束再备下一个。 */
  private adoptWarmSession(projectId: string | null): AgentSession | null {
    const warm = this.warm;
    if (!warm || warm.contextRef !== (projectId ?? 'personal')) return null;
    clearTimeout(warm.timer);
    this.warm = null;
    this.rewarmAfterAsk = true;
    return warm.session;
  }

  private disposeWarmSession(): void {
    const warm = this.warm;
    if (!warm) return;
    clearTimeout(warm.timer);
    this.warm = null;
    warm.session.invalidateContext();
  }

  /**
   * R2：后台给缺向量的记忆补向量。同一时间只跑一个；Ollama 没开或模型缺失时
   * 只记一次日志，不打扰使用（聊天会在说明里写明本轮按关键词选取）。
   */
  kickSemanticBackfill(): Promise<void> {
    const index = this.semanticIndex;
    if (!index) return Promise.resolve();
    if (this.semanticBackfillRun) return this.semanticBackfillRun;
    const run = index
      .backfill({ batchSize: 16 })
      .then((r) => {
        if (this.semanticIndex !== index) return; // R1：重建后旧索引的迟到结果不写新状态
        this.semanticLastError = null;
        this.semanticUnavailableLogged = false;
        if (r.embedded > 0) {
          this.logger.info('语义索引已补向量', { embedded: r.embedded, remaining: r.remaining });
        }
      })
      .catch((err: unknown) => {
        if (this.semanticIndex !== index) return; // R1：旧索引随旧连接失效，失败是预期
        const msg = err instanceof Error ? err.message : String(err);
        this.semanticLastError = msg;
        if (!this.semanticUnavailableLogged) {
          this.semanticUnavailableLogged = true;
          this.logger.info('语义索引暂不可用，聊天记忆按关键词选取', {
            model: index.modelId,
            reasonCode: /还没有模型/.test(msg)
              ? 'model_missing'
              : /连不上/.test(msg)
                ? 'service_unreachable'
                : 'error',
          });
        }
      })
      .finally(() => {
        // R1：只清自己那一轮。旧索引迟到结束时，不能把新索引已经开始的补向量清掉。
        if (this.semanticBackfillRun === run) this.semanticBackfillRun = null;
      });
    this.semanticBackfillRun = run;
    return run;
  }

  /**
   * 提问前等补向量，最多等 timeoutMs。
   *
   * 2026-09-18 真机：应用启动 2 秒后就提问，向量还没补上（启动那次补向量还撞上
   * Ollama 未就绪），那一问整轮按关键词选材，又把 7 月的门店开业资料塞了进去——
   * 正是语义检索要解决的问题。没向量的条目按关键词判断是「补向量期间不变差」的
   * 兜底，不该用在「第一问」这种最需要准的时候。
   * 等不到就照常提问（说明里会写明本轮有多少条没走语义）。
   */
  private async awaitSemanticBackfill(timeoutMs = 30_000): Promise<void> {
    const run = this.kickSemanticBackfill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * 取消。传 conversationId 只取消那个对话；不传则取消当前唯一在跑的回合
   *（多个对话同时在跑时不传 id 属于调用方错误，如实拒绝，不随便挑一个杀）。
   */
  cancelAsk(conversationId?: string | null): { cancelled: boolean; runId: string | null } {
    this.cancelledAskRuns ??= new Set();
    let target = conversationId ?? null;
    if (target === null) {
      if (this.activeAskRuns.size !== 1) return { cancelled: false, runId: null };
      target = [...this.activeAskRuns.keys()][0]!;
    }
    const runId = this.activeAskRuns.get(target);
    const session = this.askSessions.get(target);
    if (!runId || !session) return { cancelled: false, runId: null };
    session.cancel(runId);
    this.cancelledAskRuns.add(runId);
    return { cancelled: true, runId };
  }

  setAskDeltaSink(fn: ((e: AskDeltaEvent) => void) | null): void {
    this.askDeltaSink = fn;
  }

  setAskProgressSink(fn: ((e: AskProgressEvent) => void) | null): void {
    this.askProgressSink = fn;
  }

  // 待办（T3；T2b：底下是编码任务的，拍板即批准 / 取消，完成以任务表为准）
  listTodos(input?: { status?: TodoStatus[] }): TodoView[] {
    // 「要做」的待办，底下编码任务已经 completed 的，跟着算做完
    for (const t of this.todos.list({ status: ['accepted'] })) {
      if (t.linkedStatus === 'completed') this.todos.complete(t.id);
    }
    return this.todos.list(input);
  }
  addTodo(title: string): Todo {
    return this.todos.add({ title });
  }
  async acceptTodo(id: string): Promise<Todo> {
    const todo = this.todos.get(id);
    // 先看待办能不能改成「要做」：已经不是等你拍板的（连点两下、别处改过），
    // 直接由 accept 报状态冲突，不能先把编码任务批准了、待办却改不成
    if (todo.status === 'proposed' && todo.linked_kind === 'coding_task' && todo.linked_id) {
      // 拍板「要做」= 批准编码任务并排队；批准失败原样报错，待办不动
      await this.coding.approveAndQueue(todo.linked_id);
    }
    return this.todos.accept(id);
  }
  async rejectTodo(id: string): Promise<Todo> {
    const todo = this.todos.get(id);
    const rejectable = todo.status === 'proposed' || todo.status === 'accepted';
    if (rejectable && todo.linked_kind === 'coding_task' && todo.linked_id) {
      // 「不做」= 取消还没结束的任务；已经结束的只改待办，不动任务
      const row = this.db
        .prepare('SELECT status FROM coding_tasks WHERE id = ?')
        .get(todo.linked_id) as { status: string } | undefined;
      if (row && !['completed', 'failed', 'cancelled'].includes(row.status)) {
        this.coding.cancel(todo.linked_id);
      }
    }
    return this.todos.reject(id);
  }
  completeTodo(id: string): Todo {
    return this.todos.complete(id);
  }

  getSemanticIndexStatus(): {
    enabled: boolean;
    model: string | null;
    indexed: number;
    total: number;
    lastError: string | null;
  } {
    const index = this.semanticIndex;
    if (!index) {
      return { enabled: false, model: null, indexed: 0, total: 0, lastError: null };
    }
    const cov = index.coverage();
    return {
      enabled: true,
      model: index.modelId,
      indexed: cov.indexed,
      total: cov.total,
      lastError: this.semanticLastError ?? null,
    };
  }

  async rebuildSemanticIndex(): Promise<{ embedded: number; remaining: number }> {
    const index = this.semanticIndex;
    if (!index) return { embedded: 0, remaining: 0 };
    try {
      const result = await index.rebuild();
      this.semanticLastError = null;
      return result;
    } catch (err: unknown) {
      this.semanticLastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  personalOverview() {
    return buildPersonalOverview(this.db);
  }

  markFindingsSeen(): { ok: true } {
    markOverviewFindingsSeen(this.db);
    return { ok: true };
  }

  proposeRelations() {
    return proposeObviousRelations(this.db);
  }

  researchSnapshot() {
    const topics = this.research.store.listTopics().map((t) => ({
      ...t,
      sources: this.research.store.listSources(t.id),
      findings: this.research.store.listFindings(t.id),
      runs: this.research.store.listRuns(t.id),
    }));
    const searchConfigured = this.research.searchAvailable;
    return {
      mode: (searchConfigured ? 'approved-sources-plus-search' : 'approved-sources-only') as
        'approved-sources-only' | 'approved-sources-plus-search',
      searchConfigured,
      notice: searchConfigured
        ? '已配置搜索服务：出门说法经本地脱敏后发往搜索服务检索候选；预批预算内定时轮次自动搜索并研读。研读阶段会向模型服务发送具体研究问题与抓取内容，每轮最多 8 次模型调用（超出走规则研读）。'
        : '当前未配置搜索服务。只给方向、不给网址时不能完成真实搜索；已批准来源检查不是全网检索。可在设置页「网页搜索」配置。研读阶段每轮最多 8 次模型调用。',
      topics,
    };
  }

  previewWatchDirections() {
    return { memoryCount: collectWatchMemories(this.db).length };
  }

  async suggestWatchDirections() {
    const provider = this.getProvider();
    if (!provider) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '未配置模型，提不了关注方向（先在设置页配置模型）',
      );
    }
    const memories = collectWatchMemories(this.db);
    const raw = await provider.chatStructured({
      ...buildWatchPrompt(memories, this.projects.list()),
      schema: watchDirectionsSchema,
    });
    // 把记忆发给模型是一次外发：留痕（只记条数，不记内容）。整合方复审 2026-09-20 补。
    recordAudit(this.db, 'research.watch_directions_suggested', {
      memoryCount: memories.length,
      model: provider.modelName,
    });
    return {
      searchConfigured: this.research.searchAvailable,
      directions: mapWatchDirections(
        raw,
        memories,
        listRejectedWatchDirections(this.db),
        this.research.store.listTopics().map((t) => ({
          question: t.question,
          publicDescription: t.public_description,
        })),
      ),
    };
  }

  async followWatchDirection(input: Omit<WatchDirection, 'basis'>): Promise<{ id: string }> {
    const search = this.research.searchAvailable;
    const topic = this.research.createTopic({
      ...input,
      sources: [],
      interval_ms: 86_400_000,
      paid_budget_mode: search ? 'request_cap' : 'none',
      request_cap: search ? 3 : 0,
    });
    this.research.store.setEnabled(topic.id, true);
    return { id: topic.id };
  }

  skipWatchDirection(input: { question: string; publicDescription: string }): { ok: true } {
    addRejectedWatchDirection(this.db, input);
    return { ok: true };
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
    backupThenMigrate(db, ensureDataDirLayout(this.dataDir), this.logger);
    const vault = new Vault(join(this.dataDir, 'vault'));
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const projects = new ProjectService(db);
    const search = new SearchService(db);
    const imports = new ImportService(db, vault, permissions, sources);
    const items = new ItemService(db);
    const relations = new RelationService(db);
    // 搜索执行器惰性解析：恢复路径直接用当前实例
    const research = new ResearchChecker(
      db,
      systemClock,
      desktopResearchFetchDeps(() => this.getTinyFishFetcher() ?? undefined),
      () => this.getWebSearchExecutor() ?? undefined,
      () => this.getProvider(),
    );
    const coding = new CodingOrchestrator(db, createCodingExecutor(), this.dataDir);
    const jobs = new JobQueue(db, this.logger.child({ component: 'jobs' }));
    this.db = db;
    // R1：conversations 与 semanticIndex 原来只在构造函数里建一次，
    // 回滚后还拿着已关闭的旧连接——聊天列表、打开对话、提问全部报
    // 「database connection is not open」。按新连接重建。
    this.conversations = new ConversationStore(db);
    this.todos = new TodoStore(db);
    this.semanticIndex = createSemanticIndex(db);
    // R1：旧索引的在途补向量（如果有）绑着已关的旧连接——弃置引用，
    // 迟到的失败不写新状态（kickSemanticBackfill 里有同样的守卫）。
    // 语义索引没有常驻定时器，后台工作只有按需补向量的 promise。
    this.semanticBackfillRun = null;
    this.semanticLastError = null;
    this.semanticUnavailableLogged = false;
    // R1：懒建的引擎会话持着旧连接，同样不能留（下一问会重建，历史靠 priorTurns 重新喂）。
    // 测试桩用 Object.create 绕过构造函数时没有这个 Map，不能清。
    this.askSessions?.clear();
    this.vault = vault;
    this.permissions = permissions;
    this.sources = sources;
    this.projects = projects;
    this.search = search;
    this.imports = imports;
    this.items = items;
    this.relations = relations;
    this.research = research;
    this.coding = coding;
    this.jobs = jobs;
    // localServer 持有的是旧 db 引用：用新服务重建其依赖（复用同一实例）
    this.localServer.rebindDeps({
      db,
      permissions,
      sources,
      vault,
    });
    this.registerJobHandlers();
    const requeued = jobs.requeueNetworkFailures();
    if (requeued > 0) {
      this.logger.info('已把因网络失败的分析任务重新排队', { count: requeued });
    }
    jobs.start();
    this.startResearchScheduler();
    this.coding.store.markUnknownRunning();
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

  startResearchScheduler(): void {
    if (this.researchTimer) return;
    this.researchTimer = setInterval(() => {
      void this.research.tick().catch((err) => {
        this.logger.warn('研究调度失败', { error: String(err) });
      });
    }, 60_000);
  }

  /**
   * S2-02（审核 2026-09-15）：受控对照评测入口。
   * 不信任调用方自报的退出码/输出/时间——
   * 1. 基线必须来自已记录的失败运行；
   * 2. 验证命令由受控沙箱（限 node）现在真实执行；
   * 3. 证据绑定当前候选版本与方法快照。
   * 兼容从 input.command 或 input.evidence.command 提取命令，
   * 但调用方自报的 exitCode / output / verifiedAt 一律丢弃不采信。
   */
  async evaluateSkillWithEvidence(input: {
    id: string;
    method?: string;
    command?: string[];
    evidence?: { command?: string[] };
    taskId?: string | null;
    benefit: string;
  }): Promise<{ ok: true }> {
    const command = input.command ?? input.evidence?.command;
    if (!command || !Array.isArray(command) || command.length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '受控评测必须提供验证命令 argv');
    }
    const store = new SkillCandidateStore(this.db);
    const candidate = store.get(input.id);
    if (!input.taskId) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '受控评测必须绑定有效的编码任务工作区，未提供有效工作区或路径不存在，拒绝在应用数据目录执行',
      );
    }
    const task = this.db
      .prepare('SELECT project_id, workspace_path FROM coding_tasks WHERE id = ?')
      .get(input.taskId) as { project_id: string; workspace_path: string | null } | undefined;

    if (!task?.workspace_path || !existsSync(task.workspace_path)) {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '受控评测必须绑定有效的编码任务工作区，未提供有效工作区或路径不存在，拒绝在应用数据目录执行',
      );
    }

    // RR02 (F02)：严格核对技能候选所属项目与任务工作区项目归属，严禁跨项目越界执行
    if (candidate.project_id && task.project_id && candidate.project_id !== task.project_id) {
      throw new IxaError(
        ErrorCodes.SCOPE_DENIED,
        '受控评测绑定的任务不属于该技能候选所属的项目，拒绝跨项目执行',
      );
    }

    if (this.dataDir && resolve(task.workspace_path) === resolve(this.dataDir)) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '受控评测禁止将应用数据目录作为执行工作区');
    }
    const runDir = task.workspace_path;
    await store.runControlledEvaluation(input.id, {
      method: input.method,
      benefit: input.benefit,
      command,
      cwd: runDir,
      runVerify: (argv, dir) => runControlledVerifyCommand(argv, dir),
    });
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (this.researchTimer) {
      clearInterval(this.researchTimer);
      this.researchTimer = null;
    }
    // 修复 N3：应用退出时清理本地服务的后台补分析计时器，无残留回调
    this.localServer?.stopBackgroundTasks();
    // 修复 M0.2 第 8 条：退出前取消并**等待**在途写入任务结束，再关库
    this.jobs.stop();
    await this.jobs.idle();
    await this.stopServer();
    // S2-03 / R09（审核 2026-09-15）：关库之前先释放长驻 Agent 会话——
    // 否则退出路径只关数据库，Hermes 侧会话/进程仍持有旧上下文引用。
    this.invalidateContext();
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
  completeSetup(input: SetupInput): {
    ok: true;
    restartRequired: boolean;
    /** Key 保存失败原因（设置已完成，但 Key 未保存成功，需提示用户） */
    apiKeyWarning: string | null;
  } {
    const customDir = input.dataDir?.trim() ?? '';
    // Key 保存失败不静默：完成设置可以继续，但必须把失败原因带回给界面
    let apiKeyEncrypted = this.config.model.apiKeyEncrypted;
    let apiKeyWarning: string | null = null;
    if (input.apiKey.length > 0) {
      try {
        apiKeyEncrypted = encryptApiKey(input.apiKey);
      } catch (err) {
        apiKeyWarning = `API Key 未能保存：${err instanceof Error ? err.message : String(err)}`;
        this.logger.warn('首次设置：API Key 保存失败', { error: String(err) });
      }
    }
    const projectName = input.projectName.trim();
    const modelPatch = {
      modelName: input.modelName,
      apiBaseUrl: input.apiBaseUrl.trim(),
      apiKeyEncrypted,
      apiKeyPresent: apiKeyEncrypted !== null,
    };

    if (customDir.length === 0) {
      // 默认目录：当前进程就地完成（无需重启）
      this.updateConfig((c) => ({
        ...c,
        setupComplete: true,
        model: { ...c.model, ...modelPatch },
      }));
      if (projectName.length > 0) this.ensureFirstProject(projectName, input.projectRootPath);
      recordAudit(this.db, 'setup.completed', {
        hasApiKey: apiKeyEncrypted !== null,
        apiKeySaved: input.apiKey.length > 0 && apiKeyWarning === null,
      });
      return { ok: true, restartRequired: false, apiKeyWarning };
    }

    // 自定义目录：全部数据写入新目录，成功后才切换指针
    const targetDir = resolve(customDir);
    const layout = ensureDataDirLayout(targetDir); // 不可写/无法创建 → 抛错，旧指针未动
    const newConfig: AppConfig = {
      ...this.config,
      setupComplete: true,
      model: { ...this.config.model, ...modelPatch },
    };
    if (!newConfig.localToken) {
      newConfig.localToken = randomBytes(32).toString('hex');
    }
    // 先写新目录的完整 config（含 localToken），再建库与首个项目
    saveConfig(layout.configFile, newConfig);
    const newDb = openDatabase(layout.dbFile);
    try {
      backupThenMigrate(newDb, layout, this.logger);
      if (projectName.length > 0) {
        const newProjects = new ProjectService(newDb);
        const exists = newProjects
          .list()
          .find((p: Project) => p.name.toLowerCase() === projectName.toLowerCase());
        if (!exists) {
          newProjects.create({
            name: projectName,
            rootPath: input.projectRootPath,
            description: null,
          });
        }
      }
      recordAudit(newDb, 'setup.completed', {
        hasApiKey: apiKeyEncrypted !== null,
        apiKeySaved: input.apiKey.length > 0 && apiKeyWarning === null,
        dataDir: targetDir,
      });
    } finally {
      newDb.close();
    }
    // 全部成功 → 最后切换指针（失败时上面已抛错，指针未改）
    setDataDirChoice(targetDir);
    return { ok: true, restartRequired: true, apiKeyWarning };
  }

  /** 在当前库中确保第一个项目存在（默认目录路径用；项目名空则跳过）。 */
  private ensureFirstProject(projectName: string, projectRootPath: string | null): void {
    const existing = this.projects
      .list()
      .find((p: Project) => p.name.toLowerCase() === projectName.toLowerCase());
    if (!existing) {
      this.projects.create({
        name: projectName,
        rootPath: projectRootPath,
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
  codingExecutorName(): string {
    return this.coding.executorName;
  }

  hermesFound(): boolean {
    return new HermesRuntimeAdapter().probe().locator.found;
  }

  hermesNotice(): string {
    const caps = new HermesRuntimeAdapter().probe();
    if (caps.locator.found) {
      return `已找到 Hermes：${caps.locator.exe}。stdio 会话探针尚未通过，问答走 Core 有界工具循环，不是完整 Hermes。`;
    }
    return `Hermes 未安装：${caps.locator.reason}`;
  }

  extensionUnpackedDir(): string | null {
    return this.extensionLoadDir;
  }

  lastCaptureAt(): string | null {
    const row = this.db
      .prepare(
        "SELECT imported_at AS t FROM sources WHERE provider='chatgpt_web' ORDER BY imported_at DESC LIMIT 1",
      )
      .get() as { t: string } | undefined;
    return row?.t ?? null;
  }

  // Skill 候选（A09：真实入口版本批准与生效）
  listSkillCandidates(projectId?: string | null) {
    const skills = new SkillCandidateStore(this.db);
    return skills.list(projectId);
  }

  approveSkillCandidate(id: string, version?: number) {
    const skills = new SkillCandidateStore(this.db);
    return skills.approve(id, version !== undefined ? { version } : undefined);
  }

  retireSkillCandidate(id: string) {
    const skills = new SkillCandidateStore(this.db);
    return skills.retire(id);
  }

  proposeSkillCandidate(input: {
    projectId: string | null;
    workRunId?: string | null;
    task: string;
    summary: string;
  }) {
    const skills = new SkillCandidateStore(this.db);
    return skills.proposeFromFailure(input);
  }

  /**
   * Mobius 启发：自演进聚合器（从历史连续失败中自动反思并提炼 Skill 候选）
   */
  autoEvolveSkillCandidates(projectId?: string | null) {
    const skills = new SkillCandidateStore(this.db);
    return skills.autoEvolveFromFailurePatterns(projectId);
  }
}

/**
 * 比较两个 API 地址是否指向同一服务：协议与主机不分大小写、忽略末尾斜杠；
 * 路径大小写保留。空值表示官方默认地址。
 */
export function normalizeApiBase(url: string | null | undefined): string {
  const raw = (url ?? '').trim();
  if (raw.length === 0) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/**
 * 有待执行的迁移时先备份；备份失败就不迁移。
 * 全新库 / 已是最新版本会返回 null，不影响。
 */
function backupThenMigrate(
  db: CoreDatabase,
  layout: { backupsDir: string; configFile: string },
  logger: Logger,
): void {
  let backupDir: string | null;
  try {
    backupDir = backupBeforeMigrate(db, {
      backupsDir: layout.backupsDir,
      configPath: layout.configFile,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`迁移前备份失败，已停止迁移：${reason}`);
  }
  if (backupDir) {
    const dirName = backupDir.replace(/\\/g, '/').split('/').pop() ?? backupDir;
    logger.info('迁移前已备份', { dirName });
    recordAudit(db, 'migration.backup', { dirName });
  }
  migrate(db);
}

/** 用户已确认隔离默认值：有 Codex 就真机派发，否则 Fake。 */
function createCodingExecutor(): FakeCodingExecutor | CodexCliExecutor {
  const locator = resolveCodexLocator();
  if (locator) return new CodexCliExecutor(locator);
  return new FakeCodingExecutor();
}

/**
 * R1：语义索引按当前环境建（构造与恢复重建共用，不复制两份）。
 * IXAEON_EMBED_MODEL 设为 none 或空串 → null（不建）。
 */
function createSemanticIndex(db: CoreDatabase): SemanticIndex | null {
  const embedModel = (process.env.IXAEON_EMBED_MODEL ?? 'qwen3-embedding:0.6b').trim();
  return embedModel === '' || embedModel === 'none'
    ? null
    : new SemanticIndex(db, new OllamaEmbedder({ model: embedModel }));
}
