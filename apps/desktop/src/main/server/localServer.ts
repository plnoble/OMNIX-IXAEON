import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import type { CoreDatabase } from '@ixaeon/core';
import {
  type PermissionService,
  type SourceStore,
  McpService,
  Vault,
  recordAudit,
} from '@ixaeon/core';
import {
  ErrorCodes,
  IxaError,
  captureBatchSchema,
  pairRequestSchema,
  prepareTaskInputSchema,
  searchContextInputSchema,
  getSourceExcerptInputSchema,
  recordWorkResultInputSchema,
  type AppConfig,
  type CaptureBatch,
  type CaptureBatchResponse,
  type ExtensionStatusResponse,
  type HealthResponse,
  type PairResponse,
} from '@ixaeon/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

const APP_VERSION = '0.2.1';
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024; // 扩展单次提交上限 1MB
const CAPTURE_DOMAIN = 'chatgpt.com';
/** 每来源自动提取去重窗口（毫秒）：窗口内同一来源重复提交不再生成提取任务 */
const AUTO_ANALYZE_DEDUPE_MS = 60_000;

/** 一次性配对码（内存保存，10 分钟有效，单次使用）。 */
interface PairingCode {
  code: string;
  expiresAt: number;
}

/**
 * 本地 HTTP 接口（仅 127.0.0.1:43191）：
 * - /api/health：无鉴权健康检查（只暴露 ok / 版本 / 设置状态）
 * - /api/extension/*：浏览器扩展配对与增量提交（Bearer 扩展令牌）
 * - /api/mcp/*：MCP STDIO 转发端点（localToken）
 *
 * 安全规则：
 * - 所有非 health 请求要求 Authorization: Bearer <token>
 * - 扩展端点校验 Origin（chrome-extension://）
 * - 请求体大小限制 1MB
 * - 撤销 chatgpt.com 授权后立即拒绝采集
 * - 暂停的对话（config.capture.pausedConversations）双方强制执行
 * - 采集成功且 autoAnalyze=true 时经 onCaptured 回调排队提取（去重防抖）
 */
/** LocalServer 依赖（rebindDeps 支持运行时重建，修复 R2）。 */
interface LocalServerDeps {
  db: CoreDatabase;
  permissions: PermissionService;
  sources: SourceStore;
  vault: Vault;
  getConfig: () => AppConfig;
  updateConfig: (mutate: (config: AppConfig) => AppConfig) => void;
  /** 采集成功回调（sourceId + 该批 accepted 数；autoAnalyze=true 时由 AppRuntime 排队提取） */
  onCaptured?: (sourceId: string, acceptedCount: number) => void;
  /** 对话恢复回调（该会话的全部 externalId 别名；用于恢复后补一次最新版本分析） */
  onConversationResumed?: (externalIds: string[]) => void;
}

export class LocalServer {
  private pairingCode: PairingCode | null = null;
  /** deps 允许重绑（恢复失败后的运行时重建，修复 R2） */
  private deps: LocalServerDeps;
  /** 窗口内已有排队任务、且窗口期间又到了新内容的来源（key = sourceId，修复 F2） */
  private pendingAnalysis = new Map<string, boolean>();
  /** 补分析计时器（key = sourceId，携带对话身份供暂停复查；修复 N3/F2） */
  private trailingTimers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      sourceId: string;
      externalId: string;
      sessionId: string | null;
    }
  >();
  /** 最近一次自动提取排队时间（key = sourceId；修复 F2） */
  private lastAutoEnqueue = new Map<string, number>();

  constructor(deps: LocalServerDeps) {
    this.deps = deps;
  }

  /**
   * 恢复失败后的运行时重建（修复 R2）：把数据/权限/来源服务重绑到新数据库句柄。
   * 配置回调闭包不依赖 db，无需更换。
   */
  rebindDeps(next: Pick<LocalServerDeps, 'db' | 'permissions' | 'sources' | 'vault'>): void {
    this.deps = { ...this.deps, ...next };
  }

  generatePairingCode(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.pairingCode = { code, expiresAt };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private requireToken(authorization: unknown): 'extension' | 'local' {
    const config = this.deps.getConfig();
    const header = typeof authorization === 'string' ? authorization : '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match?.[1] ?? '';
    if (!token) {
      throw new IxaError(ErrorCodes.INVALID_TOKEN, '缺少访问令牌');
    }
    if (config.extension.token && token === config.extension.token) return 'extension';
    if (config.localToken && token === config.localToken) return 'local';
    throw new IxaError(ErrorCodes.INVALID_TOKEN, '访问令牌无效');
  }

  /** MCP 端点专用：只接受 localToken（扩展令牌不可访问 MCP 工具）。 */
  private requireLocalToken(authorization: unknown): void {
    const config = this.deps.getConfig();
    const header = typeof authorization === 'string' ? authorization : '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match?.[1] ?? '';
    if (!token || !config.localToken || token !== config.localToken) {
      throw new IxaError(
        ErrorCodes.INVALID_TOKEN,
        'MCP 端点需要本地令牌（IXAEON_DATA_DIR/config.json 的 localToken）',
      );
    }
  }

  /** 统一错误序列化（IxaError → HTTP 状态码 + code/message）。 */
  private sendError(reply: FastifyReply, err: unknown): FastifyReply {
    const apiErr =
      err instanceof IxaError
        ? err.toApiError()
        : { code: ErrorCodes.UNKNOWN, message: String(err) };
    const status =
      apiErr.code === ErrorCodes.NOT_FOUND || apiErr.code === ErrorCodes.INVALID_REFERENCE
        ? 404
        : apiErr.code === ErrorCodes.INVALID_TOKEN || apiErr.code === ErrorCodes.PERMISSION_REVOKED
          ? 401
          : apiErr.code === ErrorCodes.VALIDATION_FAILED
            ? 400
            : 500;
    return reply.code(status).send(apiErr);
  }

  /**
   * 对话是否被用户暂停（服务端强制执行，与扩展端双保险）。
   * 修复 N1：暂停同时覆盖 externalId 与稳定会话标识（sessionId）——
   * 身份转正后旧 externalId 的暂停状态经会话延续。
   */
  private isConversationPaused(externalId: string, sessionId: string | null): boolean {
    const capture = this.deps.getConfig().capture;
    if (capture.pausedConversations.includes(externalId)) return true;
    if (sessionId !== null && capture.pausedSessions.includes(sessionId)) return true;
    // 该 externalId 的会话曾被暂停（经别名解析，修复 N1）
    const aliased = this.lookupSessionAlias(externalId);
    if (aliased !== null && capture.pausedSessions.includes(aliased)) return true;
    return false;
  }

  /**
   * externalId → sessionId 别名（M0 收尾：迁入 SQLite —— 别名随采集无限增长，
   * 不再写入 config.json；每批采集避免整份配置文件重写）。上限 500 条，
   * 超出按创建时间裁剪最旧的。
   */
  private lookupSessionAlias(externalId: string): string | null {
    const row = this.deps.db
      .prepare('SELECT session_id FROM session_aliases WHERE external_id = ?')
      .get(externalId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  private recordSessionAlias(externalId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.deps.db
      .prepare(
        `INSERT INTO session_aliases (external_id, session_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(externalId, sessionId, now);
    this.deps.db
      .prepare(
        `DELETE FROM session_aliases WHERE external_id NOT IN (
           SELECT external_id FROM session_aliases ORDER BY created_at DESC LIMIT 500
         )`,
      )
      .run();
  }

  /** 同一会话的全部有效 externalId 别名（恢复时清除暂停用）。 */
  private externalIdsOfSession(sessionId: string): string[] {
    const rows = this.deps.db
      .prepare('SELECT external_id FROM session_aliases WHERE session_id = ?')
      .all(sessionId) as Array<{ external_id: string }>;
    return rows.map((r) => r.external_id);
  }

  /**
   * 暂停/恢复对话（修复 N2）：暂停同时落到 externalId 与其稳定会话（sessionId）；
   * 恢复时清除该会话的全部有效别名（临时 ID + 正式 ID），保证
   * 「暂停临时对话 → 身份转正 → 明确继续 → 成功采集」完整闭环。
   * 同时取消该会话的待补分析计时器（修复 N3）。
   */
  private setConversationPaused(
    externalId: string,
    sessionId: string | null,
    paused: boolean,
  ): void {
    const session = sessionId ?? this.lookupSessionAlias(externalId);
    this.deps.updateConfig((c) => {
      const pc = new Set(c.capture.pausedConversations);
      const ps = new Set(c.capture.pausedSessions);
      if (paused) {
        pc.add(externalId);
        if (session !== null) ps.add(session);
      } else {
        pc.delete(externalId);
        if (session !== null) {
          ps.delete(session);
          // 清除同一会话的全部有效别名暂停（临时 ID + 已知正式 ID，修复 N2）
          for (const ext of this.externalIdsOfSession(session)) {
            pc.delete(ext);
          }
        }
      }
      return {
        ...c,
        capture: { ...c.capture, pausedConversations: [...pc], pausedSessions: [...ps] },
      };
    });
    if (paused) {
      this.cancelPendingAnalysisFor(externalId, session);
    } else if (session !== null) {
      // M0.2：恢复后处理最新版本 —— 该会话来源中「欠分析」的补一次
      this.deps.onConversationResumed?.(this.externalIdsOfSession(session));
    }
  }

  /** 取消一个对话（及其会话别名）的待补分析计时器（修复 N3）。 */
  private cancelPendingAnalysisFor(externalId: string, sessionId: string | null): void {
    const session = sessionId ?? this.lookupSessionAlias(externalId);
    const sessionExternalIds =
      session !== null ? new Set(this.externalIdsOfSession(session)) : null;
    for (const [key, entry] of [...this.trailingTimers.entries()]) {
      const keySession = entry.sessionId ?? this.lookupSessionAlias(entry.externalId);
      if (
        entry.externalId === externalId ||
        key === externalId ||
        (session !== null && (keySession === session || (sessionExternalIds?.has(key) ?? false)))
      ) {
        clearTimeout(entry.timer);
        this.trailingTimers.delete(key);
        this.pendingAnalysis.delete(key);
      }
    }
  }

  /** 停止全部后台补分析计时器（恢复前、应用退出时调用，修复 N3）。 */
  stopBackgroundTasks(): void {
    for (const entry of this.trailingTimers.values()) clearTimeout(entry.timer);
    this.trailingTimers.clear();
    this.pendingAnalysis.clear();
  }

  async register(app: FastifyInstance): Promise<void> {
    // 健康检查：不要求令牌（不泄露任何数据）
    app.get('/api/health', async (): Promise<HealthResponse> => {
      const config = this.deps.getConfig();
      return {
        ok: true,
        app: 'ixaeon',
        version: APP_VERSION,
        setupComplete: config.setupComplete,
      };
    });

    // --- MCP 端点（localToken 认证；STDIO 服务器转发） ---
    app.post('/api/mcp/prepare-task', {
      config: { bodyLimit: 64 * 1024 },
      handler: async (request, reply) => {
        try {
          this.requireLocalToken(request.headers.authorization);
          const parsed = prepareTaskInputSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply.code(400).send({
              code: ErrorCodes.VALIDATION_FAILED,
              message: `prepare_task 参数错误: ${parsed.error.message}`,
            });
          }
          const mcp = new McpService(this.deps.db);
          return reply.send(mcp.prepareTask(parsed.data));
        } catch (err) {
          return this.sendError(reply, err);
        }
      },
    });

    app.post('/api/mcp/search-context', {
      config: { bodyLimit: 64 * 1024 },
      handler: async (request, reply) => {
        try {
          this.requireLocalToken(request.headers.authorization);
          const parsed = searchContextInputSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply.code(400).send({
              code: ErrorCodes.VALIDATION_FAILED,
              message: `search_context 参数错误: ${parsed.error.message}`,
            });
          }
          const mcp = new McpService(this.deps.db);
          return reply.send(mcp.searchContext(parsed.data));
        } catch (err) {
          return this.sendError(reply, err);
        }
      },
    });

    app.post('/api/mcp/get-source-excerpt', {
      config: { bodyLimit: 64 * 1024 },
      handler: async (request, reply) => {
        try {
          this.requireLocalToken(request.headers.authorization);
          const parsed = getSourceExcerptInputSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply.code(400).send({
              code: ErrorCodes.VALIDATION_FAILED,
              message: `get_source_excerpt 参数错误: ${parsed.error.message}`,
            });
          }
          const mcp = new McpService(this.deps.db);
          return reply.send(mcp.getSourceExcerpt(parsed.data.ref, parsed.data.max_chars));
        } catch (err) {
          return this.sendError(reply, err);
        }
      },
    });

    app.post('/api/mcp/record-work-result', {
      config: { bodyLimit: 1024 * 1024 },
      handler: async (request, reply) => {
        try {
          this.requireLocalToken(request.headers.authorization);
          const parsed = recordWorkResultInputSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply.code(400).send({
              code: ErrorCodes.VALIDATION_FAILED,
              message: `record_work_result 参数错误: ${parsed.error.message}`,
            });
          }
          const mcp = new McpService(this.deps.db);
          return reply.send(mcp.recordWorkResult(parsed.data));
        } catch (err) {
          return this.sendError(reply, err);
        }
      },
    });

    // --- 扩展端点 ---
    app.post('/api/extension/pair', {
      config: { bodyLimit: 1024 },
      handler: async (request, reply) => {
        const parsed = pairRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            code: ErrorCodes.VALIDATION_FAILED,
            message: '配对请求格式错误',
          });
        }
        const { code } = parsed.data;
        const pc = this.pairingCode;
        this.pairingCode = null; // 一次性使用
        if (!pc || pc.code !== code || Date.now() > pc.expiresAt) {
          return reply.code(401).send({
            code: ErrorCodes.INVALID_PAIRING_CODE,
            message: '配对码无效或已过期',
          });
        }
        // 配对成功：发放扩展令牌 + 授予 chatgpt.com 持续授权
        const token = randomBytes(36).toString('hex');
        this.deps.updateConfig((c) => ({
          ...c,
          extension: { token, pairedAt: new Date().toISOString() },
        }));
        this.deps.permissions.grantDomain(CAPTURE_DOMAIN);
        recordAudit(this.deps.db, 'extension.paired', {});
        const body: PairResponse = { token };
        return reply.send(body);
      },
    });

    app.get('/api/extension/status', {
      config: { bodyLimit: 1024 },
      handler: async (request, reply) => {
        try {
          const which = this.requireToken(request.headers.authorization);
          if (which !== 'extension') throw new IxaError(ErrorCodes.INVALID_TOKEN, '需要扩展令牌');
          const config = this.deps.getConfig();
          const domainPermission = this.deps.permissions.activePermissionForDomain(CAPTURE_DOMAIN);
          const body: ExtensionStatusResponse = {
            paired: true,
            captureEnabled: config.capture.enabled && domainPermission !== null,
            serverTime: new Date().toISOString(),
          };
          return reply.send(body);
        } catch (err) {
          const apiErr =
            err instanceof IxaError
              ? err.toApiError()
              : { code: ErrorCodes.INVALID_TOKEN, message: String(err) };
          return reply.code(401).send(apiErr);
        }
      },
    });

    // 暂停状态读写（扩展 popup 用；扩展令牌只读，写入走 desktop 设置页也可以）
    app.get('/api/extension/paused', {
      config: { bodyLimit: 1024 },
      handler: async (request, reply) => {
        try {
          const which = this.requireToken(request.headers.authorization);
          if (which !== 'extension') throw new IxaError(ErrorCodes.INVALID_TOKEN, '需要扩展令牌');
          const config = this.deps.getConfig();
          return reply.send({ paused: config.capture.pausedConversations });
        } catch (err) {
          const apiErr =
            err instanceof IxaError
              ? err.toApiError()
              : { code: ErrorCodes.INVALID_TOKEN, message: String(err) };
          return reply.code(401).send(apiErr);
        }
      },
    });

    app.post('/api/extension/pause-conversation', {
      config: { bodyLimit: 4 * 1024 },
      handler: async (request, reply) => {
        try {
          const which = this.requireToken(request.headers.authorization);
          if (which !== 'extension') throw new IxaError(ErrorCodes.INVALID_TOKEN, '需要扩展令牌');
          const body = (request.body ?? {}) as {
            externalId?: unknown;
            paused?: unknown;
            sessionId?: unknown;
          };
          if (typeof body.externalId !== 'string' || body.externalId.length === 0) {
            throw new IxaError(ErrorCodes.VALIDATION_FAILED, '缺少 externalId');
          }
          const paused = body.paused !== false; // 默认 true（暂停）
          this.setConversationPaused(
            body.externalId,
            typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null,
            paused,
          );
          recordAudit(this.deps.db, 'extension.pause_conversation', {
            externalIdHash: hashLabel(body.externalId),
            paused,
          });
          return reply.send({ ok: true, paused });
        } catch (err) {
          return this.sendError(reply, err);
        }
      },
    });

    app.post('/api/extension/capture', {
      config: { bodyLimit: MAX_BODY_BYTES },
      handler: async (request, reply) => {
        try {
          // 令牌与 Origin 双重校验
          const which = this.requireToken(request.headers.authorization);
          if (which !== 'extension') {
            throw new IxaError(ErrorCodes.INVALID_TOKEN, '需要扩展令牌');
          }
          const origin = String(request.headers.origin ?? '');
          if (!origin.startsWith('chrome-extension://')) {
            throw new IxaError(ErrorCodes.BAD_ORIGIN, `拒绝非扩展来源: ${origin || '(空)'}`);
          }
          const config = this.deps.getConfig();
          // 采集总开关 + chatgpt.com 授权必须同时有效
          if (!config.capture.enabled) {
            throw new IxaError(ErrorCodes.DISABLED, '采集已暂停（全局开关关闭）');
          }
          const domainPermission = this.deps.permissions.activePermissionForDomain(CAPTURE_DOMAIN);
          if (!domainPermission) {
            throw new IxaError(
              ErrorCodes.PERMISSION_REVOKED,
              'chatgpt.com 授权已撤销，扩展停止采集',
            );
          }
          const parsed = captureBatchSchema.safeParse(request.body);
          if (!parsed.success) {
            throw new IxaError(ErrorCodes.VALIDATION_FAILED, '采集批次格式错误');
          }
          const batch = parsed.data;
          // 记录 externalId → sessionId 别名（修复 N1/N2：在任何拒绝路径之前记录，
          // 用户恢复正式对话时才能解析到同一会话并清除其全部有效别名）。
          // M0 收尾：写入 SQLite 而非 config.json —— 别名随采集无限增长，
          // 每批采集重写整份配置文件不可接受。
          if (batch.conversation.sessionId) {
            this.recordSessionAlias(batch.conversation.externalId, batch.conversation.sessionId);
          }
          // 当前对话暂停：服务端强制拒绝（扩展端也有本地开关，双保险）。
          // 暂停检查同时覆盖 externalId 与稳定会话标识（修复 N1）。
          if (
            this.isConversationPaused(
              batch.conversation.externalId,
              batch.conversation.sessionId ?? null,
            )
          ) {
            throw new IxaError(
              ErrorCodes.DISABLED,
              `该对话已被用户暂停，扩展不再提交其内容（externalId: ${hashLabel(
                batch.conversation.externalId,
              )}）`,
            );
          }
          const response = this.handleCaptureBatch(batch);
          return reply.send(response);
        } catch (err) {
          const apiErr =
            err instanceof IxaError
              ? err.toApiError()
              : { code: ErrorCodes.UNKNOWN, message: String(err) };
          const status =
            apiErr.code === ErrorCodes.INVALID_TOKEN ||
            apiErr.code === ErrorCodes.PERMISSION_REVOKED ||
            apiErr.code === ErrorCodes.BAD_ORIGIN
              ? 401
              : apiErr.code === ErrorCodes.DISABLED
                ? 403
                : 400;
          return reply.code(status).send(apiErr);
        }
      },
    });
  }

  /**
   * 幂等处理扩展批次：找到或创建 chatgpt_web 来源，追加去重（含版本管理），
   * 并把完整对话原文（按当前全部片段组装）存入 vault。
   *
   * 对话身份合并（修复 P1-6.5）：批次带正式 /c/<id> 而库里只有同内容的
   * page:<hash> 临时来源时，把临时来源合并进正式来源（不重复、不丢内容）。
   *
   * 自动分析（修复 P1-6.1）：域授权有效 + 采集开启 + autoAnalyze=true 且本批
   * 有新内容时，经 onCaptured 回调由 AppRuntime 排队提取任务；去重窗口内
   * 同一来源不重复入队（防抖）。
   */
  private handleCaptureBatch(batch: CaptureBatch): CaptureBatchResponse {
    const { sources, db, permissions, vault } = this.deps;
    const externalId = batch.conversation.externalId;
    const batchSession = batch.conversation.sessionId ?? null;
    // 身份模型（修复 F1，见 docs/identity-lifecycle.md）：
    // - 正式对话（/c/<id>）：稳定对话身份 = URL 本身。sessionId 只是「本次页面
    //   采集实例」（刷新/新标签页会变），绝不因它换 sourceId（U1/U2）。
    // - 草稿（page:<hash>）：稳定身份 = 采集会话标识 sessionId。同一路径下的
    //   不同草稿是不同对话；草稿再次提交必须按 sessionId 找回自己的来源（U3）。
    const isDraft = !isFormalConversationId(externalId);
    const candidates = db
      .prepare(
        "SELECT * FROM sources WHERE provider = 'chatgpt_web' AND external_id = ? ORDER BY imported_at DESC",
      )
      .all(externalId) as Array<{
      id: string;
      permission_id: string;
      metadata_json: string;
    }>;
    let existing: { id: string; permission_id: string; metadata_json: string } | undefined;
    if (isDraft && batchSession !== null) {
      // 草稿：按「会话标识」精确找回（同路径的草稿 A→B→A 各自归位）
      existing = candidates.find(
        (s) => safeParseMetadata(s.metadata_json).sessionId === batchSession,
      );
    } else if (!isDraft) {
      // 正式对话：URL 即身份，任意采集实例都落到同一来源
      existing = candidates[0];
    }
    // 兜底：无会话标识的旧客户端草稿 —— 保守起见不与同路径其他来源合并，
    // 仅当「只有这一条同路径来源且它也没有会话标识」时延续旧来源
    if (!existing && isDraft && candidates.length === 1) {
      const only = candidates[0]!;
      if (safeParseMetadata(only.metadata_json).sessionId === undefined && batchSession === null) {
        existing = only;
      }
    }

    // 身份合并（修复 R8）：仅当存在可靠绑定关系时才迁移身份；证据不足保留两个来源
    if (!existing && isFormalConversationId(externalId)) {
      const temp = db
        .prepare(
          'SELECT s.id, s.permission_id, s.captured_at, s.title, s.metadata_json, s.external_id, s.project_id FROM sources s ' +
            "WHERE s.provider = 'chatgpt_web' AND s.external_id LIKE 'page:%' " +
            'ORDER BY s.imported_at DESC',
        )
        .all() as Array<{
        id: string;
        permission_id: string;
        captured_at: string | null;
        title: string;
        metadata_json: string;
        external_id: string;
        project_id: string | null;
      }>;
      for (const t of temp) {
        // 修复 R8：仅当存在可靠绑定关系时才识别为同一场对话（见 isMergeCandidate）
        if (!this.isMergeCandidate(db, t, batch)) continue;
        // 修复 R8b/N2：临时身份被暂停时，正式身份继承暂停状态并立即拒绝采集，
        // 绝不允许借身份变化绕过暂停。迁移按会话进行（externalId + sessionId
        // 双落点），用户在正式对话上点「继续」即可清除整个会话的暂停。
        const config = this.deps.getConfig();
        if (config.capture.pausedConversations.includes(t.external_id)) {
          this.deps.updateConfig((cf) => {
            const session =
              batchSession ??
              (typeof safeParseMetadata(t.metadata_json).sessionId === 'string'
                ? (safeParseMetadata(t.metadata_json).sessionId as string)
                : null);
            return {
              ...cf,
              capture: {
                ...cf.capture,
                pausedConversations: [...new Set([...cf.capture.pausedConversations, externalId])],
                pausedSessions:
                  session !== null
                    ? [...new Set([...cf.capture.pausedSessions, session])]
                    : cf.capture.pausedSessions,
              },
            };
          });
          if (batchSession) this.recordSessionAlias(externalId, batchSession);
          recordAudit(db, 'capture.merge_identity_paused', {
            fromExternalIdHash: hashLabel(t.external_id),
            toExternalIdHash: hashLabel(externalId),
          });
          throw new IxaError(
            ErrorCodes.DISABLED,
            '该对话已被用户暂停（临时身份的暂停状态已随身份转正继承），扩展不再提交其内容',
          );
        }
        // 先创建正式来源（沿用临时来源的授权），再把临时片段合并进来。
        // 修复 F1 要求 5：建源 + 合并在同一事务，失败完整回滚。
        const now = new Date().toISOString();
        const formalId = randomUUID();
        const initialText = batch.turns
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((x) => `${x.role === 'user' ? '用户' : 'AI'}：${x.text}`)
          .join('\n\n');
        const { hash } = vault.store(initialText);
        const mergeResult = db.transaction(() => {
          db.prepare(
            `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
              captured_at, imported_at, permission_id, project_id, metadata_json, content_revision)
             VALUES (?, 'conversation', 'chatgpt_web', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            formalId,
            externalId,
            batch.conversation.title || t.title,
            hash,
            Vault.relativePathFor(hash),
            batch.clientTimestamp,
            now,
            t.permission_id,
            t.project_id, // M1.1：草稿的项目绑定随身份转正继承
            JSON.stringify(mergeMetadata(batch.conversation.sessionId, t.metadata_json)),
          );
          return sources.mergeConversationSources(t.id, formalId);
        })();
        recordAudit(db, 'capture.merge_identity', {
          fromSourceId: t.id,
          intoSourceId: formalId,
          moved: mergeResult.moved,
          deduplicated: mergeResult.deduplicated,
          boundBy: batch.conversation.sessionId ? 'sessionId' : 'content-containment',
        });
        existing = db
          .prepare('SELECT id, permission_id, metadata_json FROM sources WHERE id = ?')
          .get(formalId) as { id: string; permission_id: string; metadata_json: string };
        break;
      }
    }

    let sourceId: string;
    let permissionId: string;
    if (existing) {
      sourceId = existing.id;
      permissionId = existing.permission_id;
      // 修复 F1 要求 5：来源更新与片段登记在同一事务（失败完整回滚，不留半成品）
      const appendResult = db.transaction(() => {
        // 修复 N1：来源缺少会话标识而批次携带时，补绑（供后续身份判定与合并）
        if (batchSession !== null) {
          const meta = safeParseMetadata(existing.metadata_json);
          if (typeof meta.sessionId !== 'string') {
            meta.sessionId = batchSession;
            db.prepare('UPDATE sources SET metadata_json = ? WHERE id = ?').run(
              JSON.stringify(meta),
              sourceId,
            );
          }
        }
        return sources.appendCapturedTurns(
          sourceId,
          batch.turns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
          { title: batch.conversation.title },
        );
      })();
      this.persistWebRaw(sourceId, vault);
      this.maybeAutoAnalyze(
        sourceId,
        externalId,
        batchSession,
        // 分支切换（accepted=0 但旧指纹重新激活）也是内容变化 ——
        // content_revision 已递增，必须触发分析（修复：知道变了就要开始处理）
        appendResult.accepted > 0 || appendResult.branchSwitched,
        permissionId,
      );
      return { accepted: appendResult.accepted, deduplicated: appendResult.deduplicated, sourceId };
    }
    // 新对话：创建来源（需要一条 active 的 chatgpt.com 授权）
    const domainPermission = permissions.activePermissionForDomain(CAPTURE_DOMAIN);
    if (!domainPermission) {
      throw new IxaError(ErrorCodes.PERMISSION_REVOKED, 'chatgpt.com 授权不存在');
    }
    const now = new Date().toISOString();
    sourceId = randomUUID();
    const initialText = batch.turns
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => `${t.role === 'user' ? '用户' : 'AI'}：${t.text}`)
      .join('\n\n');
    const { hash } = vault.store(initialText);
    // 修复 N1/T1：创建来源时持久化可靠的会话标识（草稿身份的依据）
    const newMetadata: Record<string, unknown> = { via: 'extension', first_seen: now };
    if (batchSession !== null) newMetadata.sessionId = batchSession;
    // 修复 F1 要求 5：建源 + 片段登记同一事务 —— 失败完整回滚，不留半成品
    const createResult = db.transaction(() => {
      db.prepare(
        `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
          captured_at, imported_at, permission_id, project_id, metadata_json, content_revision)
         VALUES (?, 'conversation', 'chatgpt_web', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)`,
      ).run(
        sourceId,
        externalId,
        batch.conversation.title,
        hash,
        Vault.relativePathFor(hash),
        batch.clientTimestamp,
        now,
        domainPermission.id,
        JSON.stringify(newMetadata),
      );
      return sources.appendCapturedTurns(
        sourceId,
        batch.turns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
      );
    })();
    recordAudit(db, 'capture.web', {
      sourceId,
      externalIdHash: hashLabel(externalId),
      accepted: createResult.accepted,
      deduplicated: createResult.deduplicated,
    });
    this.maybeAutoAnalyze(
      sourceId,
      externalId,
      batchSession,
      createResult.accepted > 0 || createResult.branchSwitched,
      domainPermission.id,
    );
    return { accepted: createResult.accepted, deduplicated: createResult.deduplicated, sourceId };
  }

  /**
   * 自动分析排队（修复 P1-6 + R7）：
   * - 窗口外新内容：立即排队提取；
   * - 窗口内（60 秒防抖）又到新内容：标记 pending，窗口结束后补一次最新版本分析；
   * - 完全重复提交（无新片段且无分支切换）：不触发，也不清除 pending；
   *   分支切换虽 accepted=0，但 content_revision 已递增 → 触发（修复：
   *   「知道内容变了却未必开始处理」的缺口）；
   * - 补分析前复查：采集开关、自动分析开关、域授权。
   */
  private maybeAutoAnalyze(
    sourceId: string,
    externalId: string,
    sessionId: string | null,
    /** 内容是否发生变化：新增片段 或 分支切换（旧指纹重新激活） */
    contentChanged: boolean,
    permissionId: string,
  ): void {
    if (!contentChanged) return;
    const config = this.deps.getConfig();
    if (!config.capture.enabled || !config.capture.autoAnalyze) return;
    // 域授权仍有效（持续采集下的自动分析必须可追溯授权）
    const domainPermission = this.deps.permissions.activePermissionForDomain(CAPTURE_DOMAIN);
    if (!domainPermission) return;
    const now = Date.now();
    // 修复 F2：防抖与合并以**稳定来源身份**（sourceId）为单位，
    // 不以临时网页地址为单位 —— 同路径的草稿 A/B/C 各有独立的待分析状态，
    // 互不覆盖；同一来源的多次更新仍合并为一次。
    const last = this.lastAutoEnqueue.get(sourceId) ?? 0;
    if (now - last < AUTO_ANALYZE_DEDUPE_MS) {
      // 窗口内：合并变更，窗口结束后补一次分析（修复 R7）
      this.pendingAnalysis.set(sourceId, true);
      this.scheduleTrailingAnalysis(sourceId, externalId, sessionId, permissionId, now - last);
      return;
    }
    this.lastAutoEnqueue.set(sourceId, now);
    this.pendingAnalysis.set(sourceId, false);
    recordAudit(this.deps.db, 'capture.auto_analyze_enqueued', { sourceId, permissionId });
    this.deps.onCaptured?.(sourceId, 0);
  }

  /**
   * 窗口结束后的补分析（每来源只安排一个计时器；窗口内多次变更合并为一次）。
   * 计时器按 sourceId 建（修复 F2），并携带对话身份（修复 N3）：触发前复查
   * 该会话的暂停状态 —— 用户暂停后不再触发待补分析；应用恢复/退出前由
   * stopBackgroundTasks 统一清理。
   */
  private scheduleTrailingAnalysis(
    sourceId: string,
    externalId: string,
    sessionId: string | null,
    permissionId: string,
    elapsedMs: number,
  ): void {
    if (this.trailingTimers.has(sourceId)) return;
    const remaining = Math.max(AUTO_ANALYZE_DEDUPE_MS - elapsedMs, 0) + 250;
    const timer = setTimeout(() => {
      this.trailingTimers.delete(sourceId);
      if (!this.pendingAnalysis.get(sourceId)) return; // 窗口内无新增变更
      this.pendingAnalysis.set(sourceId, false);
      // 补分析前复查（R7 + N3）：开关、授权与该会话的暂停状态
      const config = this.deps.getConfig();
      if (!config.capture.enabled || !config.capture.autoAnalyze) return;
      if (!this.deps.permissions.activePermissionForDomain(CAPTURE_DOMAIN)) return;
      if (this.isConversationPaused(externalId, sessionId)) return;
      this.lastAutoEnqueue.set(sourceId, Date.now());
      recordAudit(this.deps.db, 'capture.auto_analyze_trailing', { sourceId, permissionId });
      this.deps.onCaptured?.(sourceId, 0);
    }, remaining);
    (timer as { unref?: () => void }).unref?.();
    this.trailingTimers.set(sourceId, { timer, sourceId, externalId, sessionId });
  }

  /**
   * 合并候选判定（修复 R8）：可靠绑定优先。
   * a) 双方都有 sessionId → 必须一致（跨标签页/新对话必然不同）；
   * b) 任一方缺 sessionId → 回退完整包含检查：临时来源的全部片段
   *    （order+hash）都必须出现在本批次 —— 仅首句相同绝不构成合并依据。
   */
  private isMergeCandidate(
    db: CoreDatabase,
    temp: { id: string; metadata_json: string },
    batch: CaptureBatch,
  ): boolean {
    const tempMeta = safeParseMetadata(temp.metadata_json);
    const tempSession = typeof tempMeta.sessionId === 'string' ? tempMeta.sessionId : null;
    const batchSession = batch.conversation.sessionId ?? null;
    if (tempSession !== null && batchSession !== null) {
      return tempSession === batchSession;
    }
    const tempSegs = db
      .prepare('SELECT external_node_id, content_hash FROM segments WHERE source_id = ?')
      .all(temp.id) as Array<{ external_node_id: string | null; content_hash: string }>;
    if (tempSegs.length === 0) return false;
    const batchKeys = new Set(batch.turns.map((t) => `${t.order}|${contentHashOf(t.text)}`));
    return tempSegs.every((s) => batchKeys.has(`${s.external_node_id}|${s.content_hash}`));
  }

  /** 把当前全部片段组装成完整原文写入 vault，并更新 raw_path / content_hash。 */
  private persistWebRaw(sourceId: string, vault: Vault): void {
    const { db, sources } = this.deps;
    const { segments } = sources.getSegments(sourceId, 0, 100_000);
    const roleLabel: Record<string, string> = {
      user: '用户',
      assistant: 'AI',
      system: '系统',
      document: '文档',
    };
    const text = segments.map((s) => `${roleLabel[s.role] ?? s.role}：${s.text}`).join('\n\n');
    const { hash } = vault.store(text);
    db.prepare('UPDATE sources SET content_hash = ?, raw_path = ? WHERE id = ?').run(
      hash,
      Vault.relativePathFor(hash),
      sourceId,
    );
  }
}

/** 正式对话 ID 形如 /c/<uuid>（临时身份以 page: 开头）。 */
function isFormalConversationId(externalId: string): boolean {
  return /^\/c\/[A-Za-z0-9-]{6,}$/.test(externalId);
}

function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 日志/审计安全标签：externalId 本身可能含对话标题哈希，不可逆显示。 */
function hashLabel(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 12);
}

/** 安全解析来源 metadata_json（损坏时回落空对象）。 */
function safeParseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 合并后的来源 metadata：绑定采集会话标识（修复 R8，供后续身份延续判定）。 */
function mergeMetadata(
  batchSessionId: string | undefined,
  tempRaw: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    ...safeParseMetadata(tempRaw),
    via: 'extension',
  };
  if (batchSessionId) meta.sessionId = batchSessionId;
  return meta;
}
