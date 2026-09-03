import { randomBytes, randomInt, randomUUID } from 'node:crypto';
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

/** 一次性配对码（内存保存，10 分钟有效，单次使用）。 */
interface PairingCode {
  code: string;
  expiresAt: number;
}

/**
 * 本地 HTTP 接口（仅 127.0.0.1:43191）：
 * - /api/health：无鉴权健康检查（只暴露 ok / 版本 / 设置状态）
 * - /api/extension/*：浏览器扩展配对与增量提交（Bearer 扩展令牌）
 *
 * 安全规则：
 * - 所有非 health 请求要求 Authorization: Bearer <token>
 * - 扩展端点校验 Origin（chrome-extension://）
 * - 请求体大小限制 1MB
 * - 撤销 chatgpt.com 授权后立即拒绝采集
 */
export class LocalServer {
  private pairingCode: PairingCode | null = null;

  constructor(
    private readonly deps: {
      db: CoreDatabase;
      permissions: PermissionService;
      sources: SourceStore;
      vault: Vault;
      getConfig: () => AppConfig;
      updateConfig: (mutate: (config: AppConfig) => AppConfig) => void;
      onCaptured?: (sourceId: string) => void;
    },
  ) {}

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
   * 幂等处理扩展批次：找到或创建 chatgpt_web 来源，追加去重，
   * 并把完整对话原文（按当前全部片段组装）存入 vault。
   */
  private handleCaptureBatch(batch: CaptureBatch): CaptureBatchResponse {
    const { sources, db, permissions, vault } = this.deps;
    const externalId = batch.conversation.externalId;
    const existing = db
      .prepare(
        "SELECT * FROM sources WHERE provider = 'chatgpt_web' AND external_id = ? ORDER BY imported_at DESC LIMIT 1",
      )
      .get(externalId) as { id: string } | undefined;
    let sourceId: string;
    if (existing) {
      sourceId = existing.id;
      const result = sources.appendCapturedTurns(
        sourceId,
        batch.turns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
        { title: batch.conversation.title },
      );
      this.persistWebRaw(sourceId, vault);
      this.deps.onCaptured?.(sourceId);
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
      JSON.stringify({ via: 'extension', first_seen: now }),
    );
    const result = sources.appendCapturedTurns(
      sourceId,
      batch.turns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
    );
    recordAudit(db, 'capture.web', {
      sourceId,
      externalId,
      accepted: result.accepted,
      deduplicated: result.deduplicated,
    });
    this.deps.onCaptured?.(sourceId);
    return { accepted: result.accepted, deduplicated: result.deduplicated, sourceId };
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
