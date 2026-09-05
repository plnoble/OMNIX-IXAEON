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

const APP_VERSION = '0.1.0';
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
}

export class LocalServer {
  private pairingCode: PairingCode | null = null;
  /** deps 允许重绑（恢复失败后的运行时重建，修复 R2） */
  private deps: LocalServerDeps;
  /** 窗口内已有排队任务、且窗口期间又到了新内容的来源（窗口结束后补一次分析，修复 R7） */
  private pendingAnalysis = new Map<string, boolean>();
  /** 补分析计时器（key = externalId，携带对话身份供暂停复查；修复 N3） */
  private trailingTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; sourceId: string; sessionId: string | null }
  >();
  /** 最近一次自动提取排队时间（externalId → ts）；防抖窗口依据 */
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
    // 该 externalId 的会话曾被暂停（经别名解析）
    const aliased = capture.sessionAliases[externalId];
    if (aliased !== undefined && capture.pausedSessions.includes(aliased)) return true;
    return false;
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
    this.deps.updateConfig((c) => {
      const pc = new Set(c.capture.pausedConversations);
      const ps = new Set(c.capture.pausedSessions);
      const aliases = { ...c.capture.sessionAliases };
      const session = sessionId ?? aliases[externalId] ?? null;
      if (paused) {
        pc.add(externalId);
        if (session !== null) ps.add(session);
        if (session !== null && !aliases[externalId]) aliases[externalId] = session;
      } else {
        pc.delete(externalId);
        if (session !== null) {
          ps.delete(session);
          // 清除同一会话的全部有效别名暂停（临时 ID + 已知正式 ID）
          for (const [ext, sess] of Object.entries(aliases)) {
            if (sess === session) pc.delete(ext);
          }
        }
      }
      return {
        ...c,
        capture: {
          ...c.capture,
          pausedConversations: [...pc],
          pausedSessions: [...ps],
          sessionAliases: aliases,
        },
      };
    });
    if (paused) this.cancelPendingAnalysisFor(externalId, sessionId);
  }

  /** 取消一个对话（及其会话别名）的待补分析计时器（修复 N3）。 */
  private cancelPendingAnalysisFor(externalId: string, sessionId: string | null): void {
    const aliases = this.deps.getConfig().capture.sessionAliases;
    const session = sessionId ?? aliases[externalId] ?? null;
    for (const [key, entry] of [...this.trailingTimers.entries()]) {
      const keySession = aliases[key] ?? null;
      if (key === externalId || (session !== null && keySession === session)) {
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
          // 用户恢复正式对话时才能解析到同一会话并清除其全部有效别名）
          if (batch.conversation.sessionId) {
            const sid = batch.conversation.sessionId;
            this.deps.updateConfig((cf) => ({
              ...cf,
              capture: {
                ...cf.capture,
                sessionAliases: {
                  ...cf.capture.sessionAliases,
                  [batch.conversation.externalId]: sid,
                },
              },
            }));
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
    let existing = db
      .prepare(
        "SELECT * FROM sources WHERE provider = 'chatgpt_web' AND external_id = ? ORDER BY imported_at DESC LIMIT 1",
      )
      .get(externalId) as { id: string; permission_id: string; metadata_json: string } | undefined;
    // 修复 N1/T2：同一 externalId 但会话标识不同 → 是不同对话（例如两个新对话
    // 标签页路径+标题相同），绝不把内容并进别人的来源。
    if (existing && batchSession !== null) {
      const existingSession = safeParseMetadata(existing.metadata_json).sessionId;
      if (typeof existingSession === 'string' && existingSession !== batchSession) {
        existing = undefined;
      }
    }

    // 身份合并（修复 R8）：仅当存在可靠绑定关系时才迁移身份；证据不足保留两个来源
    if (!existing && isFormalConversationId(externalId)) {
      const temp = db
        .prepare(
          'SELECT s.id, s.permission_id, s.captured_at, s.title, s.metadata_json, s.external_id FROM sources s ' +
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
                sessionAliases: {
                  ...cf.capture.sessionAliases,
                  [externalId]: session ?? externalId,
                },
              },
            };
          });
          recordAudit(db, 'capture.merge_identity_paused', {
            fromExternalIdHash: hashLabel(t.external_id),
            toExternalIdHash: hashLabel(externalId),
          });
          throw new IxaError(
            ErrorCodes.DISABLED,
            '该对话已被用户暂停（临时身份的暂停状态已随身份转正继承），扩展不再提交其内容',
          );
        }
        // 先创建正式来源（沿用临时来源的授权），再把临时片段合并进来
        const now = new Date().toISOString();
        const formalId = randomUUID();
        const initialText = batch.turns
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((x) => `${x.role === 'user' ? '用户' : 'AI'}：${x.text}`)
          .join('\n\n');
        const { hash } = vault.store(initialText);
        db.prepare(
          `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
              captured_at, imported_at, permission_id, project_id, metadata_json)
             VALUES (?, 'conversation', 'chatgpt_web', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(
          formalId,
          externalId,
          batch.conversation.title || t.title,
          hash,
          Vault.relativePathFor(hash),
          batch.clientTimestamp,
          now,
          t.permission_id,
          JSON.stringify(mergeMetadata(batch.conversation.sessionId, t.metadata_json)),
        );
        const result = sources.mergeConversationSources(t.id, formalId);
        recordAudit(db, 'capture.merge_identity', {
          fromSourceId: t.id,
          intoSourceId: formalId,
          moved: result.moved,
          deduplicated: result.deduplicated,
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
      const result = sources.appendCapturedTurns(
        sourceId,
        batch.turns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
        { title: batch.conversation.title },
      );
      this.persistWebRaw(sourceId, vault);
      this.maybeAutoAnalyze(externalId, sourceId, result.accepted, permissionId);
      return { accepted: result.accepted, deduplicated: result.deduplicated, sourceId };
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
    // 修复 N1/T1：创建来源时持久化可靠的会话标识（后续身份判定与隔离的依据）
    const newMetadata: Record<string, unknown> = { via: 'extension', first_seen: now };
    if (batchSession !== null) newMetadata.sessionId = batchSession;
    db.prepare(
      `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
        captured_at, imported_at, permission_id, project_id, metadata_json)
       VALUES (?, 'conversation', 'chatgpt_web', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
    const result = sources.appendCapturedTurns(
      sourceId,
      batch.turns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
    );
    recordAudit(db, 'capture.web', {
      sourceId,
      externalIdHash: hashLabel(externalId),
      accepted: result.accepted,
      deduplicated: result.deduplicated,
    });
    this.maybeAutoAnalyze(externalId, sourceId, result.accepted, domainPermission.id);
    return { accepted: result.accepted, deduplicated: result.deduplicated, sourceId };
  }

  /**
   * 自动分析排队（修复 P1-6 + R7）：
   * - 窗口外新内容：立即排队提取；
   * - 窗口内（60 秒防抖）又到新内容：标记 pending，窗口结束后补一次最新版本分析；
   * - 重复内容（accepted=0）：不触发，也不清除 pending —— 保证窗口内到达的
   *   新内容最终都会进入最新一次分析；
   * - 补分析前复查：采集开关、自动分析开关、域授权。
   */
  private maybeAutoAnalyze(
    externalId: string,
    sourceId: string,
    acceptedCount: number,
    permissionId: string,
  ): void {
    if (acceptedCount === 0) return;
    const config = this.deps.getConfig();
    if (!config.capture.enabled || !config.capture.autoAnalyze) return;
    // 域授权仍有效（持续采集下的自动分析必须可追溯授权）
    const domainPermission = this.deps.permissions.activePermissionForDomain(CAPTURE_DOMAIN);
    if (!domainPermission) return;
    const now = Date.now();
    const last = this.lastAutoEnqueue.get(externalId) ?? 0;
    if (now - last < AUTO_ANALYZE_DEDUPE_MS) {
      // 窗口内：合并变更，窗口结束后补一次分析（修复 R7）
      this.pendingAnalysis.set(externalId, true);
      this.scheduleTrailingAnalysis(externalId, sourceId, permissionId, now - last);
      return;
    }
    this.lastAutoEnqueue.set(externalId, now);
    this.pendingAnalysis.set(externalId, false);
    recordAudit(this.deps.db, 'capture.auto_analyze_enqueued', { sourceId, permissionId });
    this.deps.onCaptured?.(sourceId, acceptedCount);
  }

  /**
   * 窗口结束后的补分析（每来源只安排一个计时器；窗口内多次变更合并为一次）。
   * 计时器携带对话身份（修复 N3）：触发前复查该会话的暂停状态 —— 用户暂停后
   * 不再触发待补分析；应用恢复/退出前由 stopBackgroundTasks 统一清理。
   */
  private scheduleTrailingAnalysis(
    externalId: string,
    sourceId: string,
    permissionId: string,
    elapsedMs: number,
  ): void {
    if (this.trailingTimers.has(externalId)) return;
    const sessionId = this.deps.getConfig().capture.sessionAliases[externalId] ?? null;
    const remaining = Math.max(AUTO_ANALYZE_DEDUPE_MS - elapsedMs, 0) + 250;
    const timer = setTimeout(() => {
      this.trailingTimers.delete(externalId);
      if (!this.pendingAnalysis.get(externalId)) return; // 窗口内无新增变更
      this.pendingAnalysis.set(externalId, false);
      // 补分析前复查（R7 + N3）：开关、授权与该会话的暂停状态
      const config = this.deps.getConfig();
      if (!config.capture.enabled || !config.capture.autoAnalyze) return;
      if (!this.deps.permissions.activePermissionForDomain(CAPTURE_DOMAIN)) return;
      if (this.isConversationPaused(externalId, sessionId)) return;
      this.lastAutoEnqueue.set(externalId, Date.now());
      recordAudit(this.deps.db, 'capture.auto_analyze_trailing', { sourceId, permissionId });
      this.deps.onCaptured?.(sourceId, 0);
    }, remaining);
    (timer as { unref?: () => void }).unref?.();
    this.trailingTimers.set(externalId, { timer, sourceId, sessionId });
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
