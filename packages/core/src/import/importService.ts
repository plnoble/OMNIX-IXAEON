import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { normalize } from 'node:path';
import type { CoreDatabase } from '../db/database.js';
import type { Permission, Source } from '@ixaeon/contracts';
import { ErrorCodes, IxaError, toApiError } from '@ixaeon/contracts';
import { type PermissionService } from '../permissions.js';
import { isPathInside } from '../paths.js';
import { Vault } from '../vault.js';
import { type SourceStore } from '../storage/sourceStore.js';
import {
  parseChatgptConversations,
  parseJsonDocument,
  parseMarkdownDocument,
  parseTextDocument,
  tryParseChatgptConversations,
  type ParsedSource,
} from './parsers.js';
import {
  looksLikeClaudeExport,
  looksLikeGeminiExport,
  looksLikeGrokExport,
  parseClaudeConversations,
  parseGeminiActivity,
  parseGrokConversations,
} from './platformParsers.js';
import { detectAgentSession, parseClaudeCodeSession } from './agentSessions.js';
import { readProjectSnapshot } from './projectSnapshot.js';
import { recordAudit } from '../audit.js';
import type { ConnectorRegistry, ConnectorPlatform } from '../connectors/connectorRegistry.js';

/** 单文件读取上限（与项目目录规则一致）。 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/**
 * ChatGPT 官方导出（conversations.json）上限 512MB：
 * 单文件包含全部历史对话，10MB 不足以覆盖长期使用（性能底线要求 50k 消息可导入）。
 */
export const MAX_CHATGPT_EXPORT_BYTES = 512 * 1024 * 1024;

/** Claude conversations.json 同为全量历史导出，走大文件上限。 */
export const MAX_CLAUDE_EXPORT_BYTES = 512 * 1024 * 1024;

/** Grok prod-grok-backend.json 含全部对话与任务/媒体元数据，走大文件上限。 */
export const MAX_GROK_EXPORT_BYTES = 512 * 1024 * 1024;

/** Gemini Takeout MyActivity.json 单文件全量活动日志。 */
export const MAX_GEMINI_EXPORT_BYTES = 512 * 1024 * 1024;

/** 编码代理会话 .jsonl（本机有超过 512MB 的）；逐行读，上限 2GB。 */
export const MAX_AGENT_SESSION_BYTES = 2 * 1024 * 1024 * 1024;

/** 全量历史导出文件名（B5 三平台 + ChatGPT）走大文件上限。 */
const LARGE_EXPORT_FILENAMES = new Set([
  'conversations.json', // ChatGPT / Claude 同名，内容嗅探区分
  'prod-grok-backend.json', // Grok
  'myactivity.json', // Gemini Takeout（路径任意，按文件名匹配）
]);

const isChatgptExportFile = (absPath: string): boolean =>
  LARGE_EXPORT_FILENAMES.has(basename(absPath).toLowerCase());

export interface ImportFileResult {
  /** 新导入的来源 */
  created: Source[];
  /** 内容未变化而跳过（幂等重导入） */
  deduplicated: Source[];
  /** 导入成功后排队等待 AI 提取的来源 */
  pendingExtraction: Source[];
}

/**
 * 导入服务：授权校验 → SHA-256 → vault → 解析 → 去重 → 入库。
 *
 * 信任边界（修复 P1-5）：核心层不创建授权。调用方（桌面主进程）必须先通过
 * 原生对话框流程获得授权记录（grantFile / grantFolder），把 permissionId
 * 传进来；本服务验证该授权真实存在、仍 active、且覆盖请求路径。
 * 任何调用方都无法通过「自带 allowedPaths」给自己授权——该参数已删除。
 */
export class ImportService {
  constructor(
    private readonly db: CoreDatabase,
    private readonly vault: Vault,
    private readonly permissions: PermissionService,
    private readonly sources: SourceStore,
    private readonly connectors?: ConnectorRegistry,
  ) {}

  /** 取出并验证授权（存在 / active / 覆盖路径，realpath 防符号链接与 junction 逃逸）。 */
  private requirePermission(permissionId: string, absPath: string): Permission {
    const perm = this.permissions.get(permissionId);
    if (!perm) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, `授权记录不存在: ${permissionId}`);
    }
    if (perm.status !== 'active') {
      throw new IxaError(
        ErrorCodes.PERMISSION_REVOKED,
        '授权已被撤销，拒绝读取（可在来源页重新授权）',
      );
    }
    const covers =
      perm.scope_type === 'folder'
        ? isPathInside(perm.locator, absPath)
        : isPathInside(perm.locator, absPath) && isPathInside(absPath, perm.locator);
    if (!covers) {
      throw new IxaError(
        ErrorCodes.PATH_ESCAPE,
        `路径不在授权范围内（授权 ${perm.locator}，请求 ${absPath}）`,
      );
    }
    return perm;
  }

  private readAuthorized(
    absPath: string,
    opts: { maxBytes?: number } = {},
  ): { content: string; hash: string } {
    // 双重校验：即使调用方传入了合法票据，也要求某条 active 授权覆盖该路径
    this.permissions.assertPathAllowed(absPath);
    const maxBytes =
      opts.maxBytes ?? (isChatgptExportFile(absPath) ? MAX_CHATGPT_EXPORT_BYTES : MAX_IMPORT_BYTES);
    let raw: Buffer;
    try {
      const st = statSync(absPath);
      if (st.size > maxBytes) {
        throw new IxaError(
          ErrorCodes.FILE_TOO_LARGE,
          `文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限（${st.size} 字节）：${absPath}`,
        );
      }
      raw = readFileSync(absPath);
    } catch (err) {
      if (err instanceof IxaError) throw err;
      throw new IxaError(ErrorCodes.NOT_FOUND, `无法读取文件: ${absPath}（${String(err)}）`);
    }
    if (raw.length === 0) {
      throw new IxaError(ErrorCodes.PARSE_FAILED, `文件为空: ${absPath}`);
    }
    const hash = this.vault.store(raw).hash;
    const content = raw.toString('utf8');
    // 明显的双重替换字符说明不是 UTF-8 文本
    if (content.includes('\uFFFD\uFFFD')) {
      throw new IxaError(ErrorCodes.PARSE_FAILED, `文件不是有效的 UTF-8 文本: ${absPath}`);
    }
    return { content, hash };
  }

  /**
   * 带连接器记录的导入入口（P3-A，迁移 25）。
   * 成功 → recordSuccess（游标=导入时刻，覆盖区间=导入来源时间范围）；
   * 失败 → recordFailure（保留最后成功历史）并原样抛出。
   */
  importFile(
    absPath: string,
    opts: {
      projectId: string | null;
      permissionId: string;
      maxBytes?: number;
      accountNamespace?: string;
    },
  ): ImportFileResult {
    if (!this.connectors) return this.importFileInner(absPath, opts);
    try {
      const result = this.importFileInner(absPath, opts);
      const connector = this.detectConnector(absPath, opts.accountNamespace ?? 'local');
      if (connector) {
        const times = [...result.created, ...result.deduplicated]
          .map((s) => s.captured_at)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
          .sort();
        const now = new Date().toISOString();
        this.connectors.recordSuccess(connector.id, {
          cursor: now, // 本地文件导入无平台增量游标，用导入时刻；平台连接器由各自同步器推进
          coverageStart: times[0] ?? now,
          coverageEnd: times.at(-1) ?? now,
        });
      }
      return result;
    } catch (err) {
      const connector = this.detectConnector(absPath, opts.accountNamespace ?? 'local');
      if (connector) this.connectors.recordFailure(connector.id, String(err));
      throw err;
    }
  }

  /** 根据文件名判定连接器身份（platform × namespace × method 唯一）。 */
  private detectConnector(absPath: string, accountNamespace: string): { id: string } | null {
    if (!this.connectors) return null;
    const name = basename(absPath).toLowerCase();
    let platform: ConnectorPlatform;
    if (name === 'conversations.json') {
      platform = 'chatgpt_export'; // ChatGPT/Claude 同名导出，保守归入 chatgpt_export
    } else if (name === 'prod-grok-backend.json') {
      platform = 'grok_export';
    } else if (name === 'myactivity.json') {
      platform = 'gemini_export';
    } else if (/\.md$|\.txt$|\.json$/.test(name)) {
      platform = 'local_file';
    } else {
      return null;
    }
    return this.connectors.upsert({
      platform,
      accountNamespace,
      captureMethod: 'history_export',
    });
  }

  /**
   * 原导入逻辑：导入用户明确选择的文件（Markdown / TXT / JSON / conversations.json）。
   * permissionId 必须来自可信主进程的原生对话框流程。
   */
  private importFileInner(
    absPath: string,
    opts: {
      projectId: string | null;
      permissionId: string;
      maxBytes?: number;
      accountNamespace?: string;
    },
  ): ImportFileResult {
    const permission = this.requirePermission(opts.permissionId, absPath);
    if (/\.jsonl$/i.test(basename(absPath))) {
      return this.importAgentSession(absPath, permission, opts);
    }
    const { content, hash: fileHash } = this.readAuthorized(absPath, { maxBytes: opts.maxBytes });
    const name = basename(absPath);
    const created: Source[] = [];
    const deduplicated: Source[] = [];

    // conversations.json：一个文件包含多场对话（ChatGPT；Claude 官方导出同名）
    const convs = tryParseChatgptConversations(content, {
      accountNamespace: opts.accountNamespace,
    });
    if (convs) {
      for (const parsed of convs) {
        const result = this.insertParsed(parsed, {
          permissionId: permission.id,
          projectId: opts.projectId,
          rawPath: Vault.relativePathFor(fileHash),
        });
        if (result.created) created.push(result.source);
        else deduplicated.push(result.source);
      }
      recordAudit(this.db, 'import.chatgpt_export', {
        file: name,
        conversations: convs.length,
        created: created.length,
        deduplicated: deduplicated.length,
      });
      return { created, deduplicated, pendingExtraction: created };
    }

    // B5 三平台：先 JSON.parse 做内容嗅探（Claude 同名 conversations.json 靠内容区分）
    const platformParsed = this.tryParsePlatformExport(
      content,
      name,
      opts.accountNamespace ?? undefined,
    );
    if (platformParsed) {
      for (const parsed of platformParsed.parsed) {
        const result = this.insertParsed(parsed, {
          permissionId: permission.id,
          projectId: opts.projectId,
          rawPath: Vault.relativePathFor(fileHash),
        });
        if (result.created) created.push(result.source);
        else deduplicated.push(result.source);
      }
      recordAudit(this.db, `import.${platformParsed.platform}_export`, {
        file: name,
        conversations: platformParsed.parsed.length,
        created: created.length,
        deduplicated: deduplicated.length,
      });
      return { created, deduplicated, pendingExtraction: created };
    }

    let parsed: ParsedSource;
    if (/\.md$/i.test(name)) {
      parsed = parseMarkdownDocument(content, { title: name, externalId: absPath });
    } else if (/\.txt$/i.test(name)) {
      parsed = parseTextDocument(content, { title: name, externalId: absPath });
    } else if (/\.json$/i.test(name)) {
      parsed = parseJsonDocument(content, { title: name, externalId: absPath });
    } else {
      throw new IxaError(
        ErrorCodes.UNSUPPORTED_FORMAT,
        `不支持的文件类型（仅支持 .md / .txt / .json / .jsonl / conversations.json）: ${name}`,
      );
    }
    const result = this.insertParsed(parsed, {
      permissionId: permission.id,
      projectId: opts.projectId,
      rawPath: Vault.relativePathFor(fileHash),
    });
    if (result.created) created.push(result.source);
    else deduplicated.push(result.source);
    recordAudit(this.db, 'import.file', {
      file: name,
      created: created.length,
      deduplicated: deduplicated.length,
    });
    return { created, deduplicated, pendingExtraction: created };
  }

  /** 编码代理会话（.jsonl）：逐块读；vault 只存保留下来的内容。 */
  private importAgentSession(
    absPath: string,
    permission: Permission,
    opts: { projectId: string | null; accountNamespace?: string; maxBytes?: number },
  ): ImportFileResult {
    this.permissions.assertPathAllowed(absPath);
    const maxBytes = opts.maxBytes ?? MAX_AGENT_SESSION_BYTES;
    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch (err) {
      throw new IxaError(ErrorCodes.NOT_FOUND, `无法读取文件: ${absPath}（${String(err)}）`);
    }
    if (size === 0) throw new IxaError(ErrorCodes.PARSE_FAILED, `文件为空: ${absPath}`);
    if (size > maxBytes) {
      throw new IxaError(
        ErrorCodes.FILE_TOO_LARGE,
        `文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限（${size} 字节）：${absPath}`,
      );
    }
    const preview: string[] = [];
    for (const line of iterateJsonlLines(absPath)) {
      if (line.trim().length === 0) continue;
      preview.push(line);
      if (preview.length >= 20) break;
    }
    if (detectAgentSession(preview) !== 'claude_code') {
      throw new IxaError(ErrorCodes.UNSUPPORTED_FORMAT, '不认识的 .jsonl 格式');
    }
    const parsed = parseClaudeCodeSession(iterateJsonlLines(absPath), {
      accountNamespace: opts.accountNamespace,
    });
    if (!parsed) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '这个会话里没有对话内容');
    const stored = this.vault.store(parsed.segments.map((s) => `${s.role}: ${s.text}`).join('\n'));
    const cwd = typeof parsed.metadata.cwd === 'string' ? parsed.metadata.cwd : null;
    const projectId = opts.projectId ?? (cwd ? this.matchProjectByCwd(cwd) : null);
    const result = this.insertParsed(parsed, {
      permissionId: permission.id,
      projectId,
      rawPath: Vault.relativePathFor(stored.hash),
    });
    recordAudit(this.db, 'import.coding_agent', {
      file: basename(absPath),
      created: result.created ? 1 : 0,
    });
    return {
      created: result.created ? [result.source] : [],
      deduplicated: result.created ? [] : [result.source],
      pendingExtraction: result.created ? [result.source] : [],
    };
  }

  private matchProjectByCwd(cwd: string): string | null {
    const want = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const rows = this.db
      .prepare(
        "SELECT id, root_path FROM projects WHERE root_path IS NOT NULL AND status != 'archived'",
      )
      .all() as Array<{ id: string; root_path: string }>;
    return (
      rows.find((r) => r.root_path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === want)
        ?.id ?? null
    );
  }

  /**
   * B5 三平台导出内容嗅探与解析（Claude/Grok/Gemini）。
   * 判定顺序：Claude（chat_messages 数组）→ Grok（conversation+responses 包装）
   * → Gemini（titleUrl+details/userInteractions）。
   * 嗅探失败返回 null，调用方回落普通文档/JSON 路径——不误伤普通 JSON。
   */
  private tryParsePlatformExport(
    content: string,
    name: string,
    accountNamespace?: string,
  ): { platform: 'claude' | 'grok' | 'gemini'; parsed: ParsedSource[] } | null {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return null;
    }
    if (looksLikeClaudeExport(parsedJson)) {
      return {
        platform: 'claude',
        parsed: parseClaudeConversations(parsedJson as unknown[], { accountNamespace }),
      };
    }
    if (looksLikeGrokExport(parsedJson)) {
      const arr = Array.isArray(parsedJson)
        ? parsedJson
        : ((parsedJson as { conversations?: unknown[] }).conversations ?? []);
      return { platform: 'grok', parsed: parseGrokConversations(arr, { accountNamespace }) };
    }
    if (looksLikeGeminiExport(parsedJson)) {
      return {
        platform: 'gemini',
        parsed: parseGeminiActivity(parsedJson as unknown[], { accountNamespace }),
      };
    }
    // 只对已知导出文件名报错（用户明确选了导出文件但格式不对），普通 JSON 静默回落
    const lower = name.toLowerCase();
    if (lower === 'prod-grok-backend.json' || lower === 'myactivity.json') {
      throw new IxaError(
        ErrorCodes.PARSE_FAILED,
        `${name} 看起来不是有效的平台导出文件（内容嗅探未命中已知结构）`,
      );
    }
    return null;
  }

  /**
   * 导入文件夹（2026-09-08 用户需求：一个项目不止一个文件）。
   * 递归收集白名单内的文本文件（.md/.txt/.json/.jsonl），逐文件走 importFile：
   * - folder 授权覆盖全部子路径（requirePermission 对每个文件校验）；
   * - 排除 node_modules/.git/dist 等构建目录、点开头目录与密钥类文件
   *  （与项目目录快照同一套规则，用户不会一次性导入敏感内容）；
   * - 单文件失败（过大/二进制/空文件）只记录，不阻塞其他文件；
   * - conversations.json 在目录里按 ChatGPT 导出处理（一个文件多对话）；
   * - ChatGPT 导出包里的附带文件（账号资料、设置、导出清单等）不导入（E4）；
   * - 文件数量上限 500，超出部分记录跳过（防误选巨大目录拖垮机器）。
   */
  importFolder(
    absPath: string,
    opts: { projectId: string | null; permissionId: string; accountNamespace?: string },
  ): {
    created: Source[];
    deduplicated: Source[];
    pendingExtraction: Source[];
    failed: Array<{ path: string; message: string }>;
    scanned: number;
    skipped: string[];
  } {
    // 先验证 folder 授权存在且覆盖根路径（子路径在 importFile 内逐个复核）
    this.requirePermission(opts.permissionId, absPath);
    const files = listFolderTextFiles(absPath);
    const created: Source[] = [];
    const deduplicated: Source[] = [];
    const pendingExtraction: Source[] = [];
    const failed: Array<{ path: string; message: string }> = files.failed.concat();
    for (const file of files.files) {
      try {
        const result = this.importFile(file, {
          projectId: opts.projectId,
          permissionId: opts.permissionId,
          accountNamespace: opts.accountNamespace,
        });
        created.push(...result.created);
        deduplicated.push(...result.deduplicated);
        pendingExtraction.push(...result.pendingExtraction);
      } catch (err) {
        const api = toApiError(err);
        failed.push({ path: file, message: `${api.code} ${api.message}` });
      }
    }
    recordAudit(this.db, 'import.folder', {
      root: basename(absPath),
      scanned: files.files.length + files.failed.length,
      created: created.length,
      deduplicated: deduplicated.length,
      failed: failed.length,
      skippedExportMetadata: files.skipped.length,
    });
    return {
      created,
      deduplicated,
      pendingExtraction,
      failed,
      scanned: files.files.length,
      skipped: files.skipped,
    };
  }

  /** 显式按 ChatGPT 导出解析（同样要求传入可信授权 ID）。 */
  importChatgptExport(
    absPath: string,
    opts: { projectId: string | null; permissionId: string; accountNamespace?: string },
  ): ImportFileResult {
    const permission = this.requirePermission(opts.permissionId, absPath);
    const { content, hash: fileHash } = this.readAuthorized(absPath);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (err) {
      throw new IxaError(ErrorCodes.PARSE_FAILED, `JSON 解析失败: ${String(err)}`);
    }
    if (!Array.isArray(parsedJson)) {
      throw new IxaError(ErrorCodes.PARSE_FAILED, 'conversations.json 顶层应为数组');
    }
    const convs = parseChatgptConversations(parsedJson, {
      externalId: '',
      accountNamespace: opts.accountNamespace,
    });
    const created: Source[] = [];
    const deduplicated: Source[] = [];
    for (const parsed of convs) {
      const result = this.insertParsed(parsed, {
        permissionId: permission.id,
        projectId: opts.projectId,
        rawPath: Vault.relativePathFor(fileHash),
      });
      if (result.created) created.push(result.source);
      else deduplicated.push(result.source);
    }
    recordAudit(this.db, 'import.chatgpt_export', {
      file: basename(absPath),
      conversations: convs.length,
      created: created.length,
      deduplicated: deduplicated.length,
    });
    return { created, deduplicated, pendingExtraction: created };
  }

  /** 登记项目目录：读取项目说明/配置快照（不扫描全部源码）。folder 授权须由可信主进程创建。 */
  importProjectSnapshot(
    rootPath: string,
    opts: { projectId: string; permissionId: string },
  ): ImportFileResult {
    const permission = this.requirePermission(opts.permissionId, rootPath);
    if (permission.scope_type !== 'folder') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        '项目目录登记需要 folder 授权（请通过目录选择对话框）',
      );
    }
    const snapshot = readProjectSnapshot(rootPath);
    if (snapshot.source.segments.length === 0) {
      throw new IxaError(
        ErrorCodes.PARSE_FAILED,
        `项目目录中没有可读取的说明或配置文件: ${rootPath}`,
      );
    }
    const rawContent = snapshot.source.segments.map((s) => s.text).join('\n\n---\n\n');
    const { hash } = this.vault.store(rawContent);
    const result = this.insertParsed(snapshot.source, {
      permissionId: permission.id,
      projectId: opts.projectId,
      rawPath: Vault.relativePathFor(hash),
    });
    recordAudit(this.db, 'import.project_snapshot', {
      root: rootPath,
      created: result.created ? 1 : 0,
      skipped: snapshot.skipped.length,
    });
    return {
      created: result.created ? [result.source] : [],
      deduplicated: result.created ? [] : [result.source],
      pendingExtraction: result.created ? [result.source] : [],
    };
  }

  private insertParsed(
    parsed: ParsedSource,
    opts: { permissionId: string; projectId: string | null; rawPath: string },
  ): { created: boolean; source: Source } {
    const existing = this.sources.findExisting(
      parsed.provider,
      parsed.externalId,
      parsed.contentHash,
      parsed.accountNamespace,
    );
    if (existing) return { created: false, source: existing };
    const source = this.sources.insertParsed(parsed, {
      permissionId: opts.permissionId,
      projectId: opts.projectId,
      rawPath: opts.rawPath,
    });
    return { created: true, source };
  }

  /**
   * 问答对落 Core（用户 2026-09-13 指示：所有问答内容都进 Core）。
   *
   * D5：一个对话一条 ask_session 来源。externalId = conversationId；
   * 首轮新建，后续轮次走 SourceStore.appendCapturedTurns（按 message seq
   * 去重/分支），不另写一套追加逻辑。runId 只进审计。
   * 授权：调用方传入问答面授权（ask.ixaeon.local）；撤销后拒绝落库。
   */
  captureAsk(input: {
    question: string;
    answer: string;
    conversationId: string;
    userSeq: number;
    assistantSeq: number;
    runId?: string;
    engine: 'hermes' | 'core-bounded';
    model: string | null;
    projectId: string | null;
    permissionId: string;
  }): {
    created: boolean;
    source: Source;
    accepted?: number;
    deduplicated?: number;
  } {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question || !answer) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '问答内容为空，不落库');
    }
    const perm = this.permissions.get(input.permissionId);
    if (!perm || perm.status !== 'active') {
      throw new IxaError(ErrorCodes.PERMISSION_REVOKED, '问答授权不可用，拒绝落库');
    }
    const now = new Date().toISOString();
    const turns = [
      { order: input.userSeq, role: 'user' as const, text: question },
      { order: input.assistantSeq, role: 'assistant' as const, text: answer },
    ];
    const existing = this.db
      .prepare(
        `SELECT * FROM sources
         WHERE provider = 'ask_session' AND account_namespace = 'local' AND external_id = ?
         ORDER BY imported_at ASC`,
      )
      .get(input.conversationId) as Source | undefined;
    if (existing) {
      const appended = this.sources.appendCapturedTurns(existing.id, turns);
      const source = this.sources.get(existing.id);
      if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, `来源不存在: ${existing.id}`);
      recordAudit(this.db, 'ask.captured_to_core', {
        sourceId: source.id,
        conversationId: input.conversationId,
        runId: input.runId ?? null,
        created: false,
        engine: input.engine,
        projectId: input.projectId,
      });
      return {
        created: false,
        source,
        accepted: appended.accepted,
        deduplicated: appended.deduplicated,
      };
    }
    const text = `用户：${question}\n\nIXAEON 助手：${answer}`;
    const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
    const stored = this.vault.store(text);
    const rawPath = Vault.relativePathFor(stored.hash);
    const parsed: ParsedSource = {
      kind: 'conversation',
      provider: 'ask_session',
      accountNamespace: 'local',
      externalId: input.conversationId,
      title: question.slice(0, 80),
      contentHash,
      capturedAt: now,
      importMethod: 'live_capture',
      segments: [
        {
          sequence: input.userSeq,
          role: 'user',
          externalNodeId: String(input.userSeq),
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: now,
          text: question,
          metadata: {},
        },
        {
          sequence: input.assistantSeq,
          role: 'assistant',
          externalNodeId: String(input.assistantSeq),
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: now,
          text: answer,
          metadata: {},
        },
      ],
      metadata: {
        via: 'ask',
        engine: input.engine,
        model: input.model,
      },
    };
    const result = this.insertParsed(parsed, {
      permissionId: input.permissionId,
      projectId: input.projectId,
      rawPath,
    });
    recordAudit(this.db, 'ask.captured_to_core', {
      sourceId: result.source.id,
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      created: result.created,
      engine: input.engine,
      projectId: input.projectId,
    });
    return result;
  }
}

/** 兼容旧调用形态的路径规范化（Windows 大小写不敏感比较用）。 */
export const normalizeForCompare = (p: string): string => normalize(p).toLowerCase();

/** 逐块读 jsonl，自己切行；不把整个文件读成一个字符串。 */
function* iterateJsonlLines(absPath: string): Generator<string> {
  const fd = openSync(absPath, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let leftover = Buffer.alloc(64 * 1024);
    let len = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      if (len + n > leftover.length) {
        const next = Buffer.alloc(Math.max(leftover.length * 2, len + n));
        leftover.copy(next, 0, 0, len);
        leftover = next;
      }
      chunk.copy(leftover, len, 0, n);
      len += n;
      let start = 0;
      for (let i = 0; i < len; i++) {
        if (leftover[i] !== 0x0a) continue;
        yield leftover.subarray(start, leftover[i - 1] === 0x0d ? i - 1 : i).toString('utf8');
        start = i + 1;
      }
      if (start > 0) {
        leftover.copyWithin(0, start, len);
        len -= start;
      }
    }
    if (len > 0) yield leftover.subarray(0, len).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** 文件夹导入的文本文件白名单。 */
const FOLDER_TEXT_RE = /\.(md|txt|json|jsonl)$/i;

/** 文件夹导入单目录文件数上限（防误选巨大目录）。 */
const FOLDER_MAX_FILES = 500;

/** 目录遍历深度上限。 */
const FOLDER_MAX_DEPTH = 8;

/** 与项目目录快照同一套排除规则：永不遍历的目录名。 */
const FOLDER_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.idea',
  '.vs',
  'bin',
  'obj',
]);

/** 永不导入的文件名（密钥、Cookie、令牌等——密钥类文件即使 .json 也不进）。 */
const FOLDER_SKIP_NAME_RE =
  /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*\.cookie|.*cookie.*\.json|.*token.*|.*secret.*|.*credential.*)$/i;

/**
 * ChatGPT 导出包的标志文件：目录里有它们之一，就当成一个导出包（三周任务单 E4）。
 * conversations.json 与 Claude 导出同名，但下面的附带文件名单只有 ChatGPT 用，不误伤 Claude。
 */
const CHATGPT_PACKAGE_MARKERS = new Set(['conversations.json', 'export_manifest.json']);

/**
 * ChatGPT 导出包里的附带文件：账号资料、设置、广告、反馈、导出清单等，不是聊天内容。
 * 2026-09-18 真机：导入整个导出目录时这 8 个被当成文档导入，分析为空，却挂在资料库里。
 * 只跳过认识的名字；新版导出包里出现的陌生 JSON 照常导入（宁可多导，不能漏掉聊天）。
 */
const CHATGPT_EXPORT_METADATA = new Set([
  'user.json',
  'user_settings.json',
  'ads.json',
  'message_feedback.json',
  'model_comparisons.json',
  'shared_conversations.json',
  'conversation_asset_file_names.json',
  'export_manifest.json',
  'library_files.json',
]);

/**
 * 递归列出文件夹内可导入的文本文件（白名单 + 排除规则 + 数量上限）。
 * 超限与无法读取的条目记录为 failed，不中断遍历。
 */
function listFolderTextFiles(root: string): {
  files: string[];
  failed: Array<{ path: string; message: string }>;
  /** 认出是 ChatGPT 导出包附带文件而跳过的（E4） */
  skipped: string[];
} {
  const files: string[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  const skipped: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > FOLDER_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无法读取的目录跳过（无权限等）
    }
    const chatgptPackage = entries.some(
      (e) => e.isFile() && CHATGPT_PACKAGE_MARKERS.has(e.name.toLowerCase()),
    );
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || FOLDER_SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        if (FOLDER_SKIP_NAME_RE.test(e.name)) continue;
        if (!FOLDER_TEXT_RE.test(e.name)) continue;
        if (chatgptPackage && CHATGPT_EXPORT_METADATA.has(e.name.toLowerCase())) {
          skipped.push(full);
          continue;
        }
        if (files.length >= FOLDER_MAX_FILES) {
          failed.push({ path: full, message: `超过单目录 ${FOLDER_MAX_FILES} 个文件上限，已跳过` });
          continue;
        }
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return { files, failed, skipped };
}
