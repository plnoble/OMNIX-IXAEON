import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { normalize } from 'node:path';
import type { CoreDatabase } from '../db/database.js';
import type { Source } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { type PermissionService } from '../permissions.js';
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
import { readProjectSnapshot } from './projectSnapshot.js';
import { recordAudit } from '../audit.js';

/** 单文件读取上限（与项目目录规则一致）。 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/**
 * ChatGPT 官方导出（conversations.json）上限 512MB：
 * 单文件包含全部历史对话，10MB 不足以覆盖长期使用（性能底线要求 50k 消息可导入）。
 */
export const MAX_CHATGPT_EXPORT_BYTES = 512 * 1024 * 1024;

/** conversations.json（ChatGPT 官方导出文件名）走大文件上限。 */
const isChatgptExportFile = (absPath: string): boolean =>
  basename(absPath).toLowerCase() === 'conversations.json';

export interface ImportFileResult {
  /** 新导入的来源 */
  created: Source[];
  /** 内容未变化而跳过（幂等重导入） */
  deduplicated: Source[];
  /** 导入成功后排队等待 AI 提取的来源 */
  pendingExtraction: Source[];
}

/** Windows 下路径比较统一小写。 */
const norm = (p: string): string => normalize(p).toLowerCase();

/**
 * 导入服务：授权校验 → SHA-256 → vault → 解析 → 去重 → 入库。
 * 原则：
 * - 未授权路径一律拒绝；
 * - 原件先入 vault（解析失败也不回收原件）；
 * - 结构化数据要么全部入库要么回滚，不留半套；
 * - 同一内容重复导入幂等。
 */
export class ImportService {
  constructor(
    private readonly db: CoreDatabase,
    private readonly vault: Vault,
    private readonly permissions: PermissionService,
    private readonly sources: SourceStore,
  ) {}

  private readAuthorized(
    absPath: string,
    opts: { maxBytes?: number } = {},
  ): { content: string; hash: string } {
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
   * 导入用户明确选择的文件（Markdown / TXT / JSON / conversations.json）。
   * 授权来源：调用方传入用户已授权的路径集合（来自原生对话框选择）。
   * 不在授权集合内的路径一律拒绝，防止内部代码自行授权读任意文件。
   */
  importFile(
    absPath: string,
    opts: { projectId: string | null; allowedPaths: string[]; maxBytes?: number },
  ): ImportFileResult {
    const allowed = new Set(opts.allowedPaths.map((p) => norm(p)));
    if (!allowed.has(norm(absPath))) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        `路径不在用户选择范围内，拒绝读取: ${absPath}`,
      );
    }
    const permission = this.permissions.grantFile(absPath);
    const { content, hash: fileHash } = this.readAuthorized(absPath, { maxBytes: opts.maxBytes });
    const name = basename(absPath);
    const created: Source[] = [];
    const deduplicated: Source[] = [];

    // conversations.json：一个文件包含多场对话
    const convs = tryParseChatgptConversations(content);
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
        `不支持的文件类型（仅支持 .md / .txt / .json / conversations.json）: ${name}`,
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

  /** 显式按 ChatGPT 导出解析（导入界面单独入口；同样要求路径在用户选择集合内）。 */
  importChatgptExport(
    absPath: string,
    opts: { projectId: string | null; allowedPaths: string[] },
  ): ImportFileResult {
    const allowed = new Set(opts.allowedPaths.map((p) => norm(p)));
    if (!allowed.has(norm(absPath))) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        `路径不在用户选择范围内，拒绝读取: ${absPath}`,
      );
    }
    const permission = this.permissions.grantFile(absPath);
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
    const convs = parseChatgptConversations(parsedJson, { externalId: '' });
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

  /** 登记项目目录：读取项目说明/配置快照（不扫描全部源码）。 */
  importProjectSnapshot(rootPath: string, opts: { projectId: string }): ImportFileResult {
    const permission = this.permissions.grantFolder(rootPath);
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
    );
    if (existing) return { created: false, source: existing };
    const source = this.sources.insertParsed(parsed, {
      permissionId: opts.permissionId,
      projectId: opts.projectId,
      rawPath: opts.rawPath,
    });
    return { created: true, source };
  }
}
