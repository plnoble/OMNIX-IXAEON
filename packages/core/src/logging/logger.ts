import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 敏感键（值整体遮盖，无论层级深度）。 */
const REDACT_KEY_RE =
  /(apikey|api_key|token|secret|authorization|password|passwd|cookie|credential|bearer)/i;
/** 正文键：命中即只保留长度与哈希，绝不写内容（修复 P1-9）。 */
const CONTENT_KEY_RE =
  /^(text|content|body|prompt|response|excerpt|user|input|output|message|answer|question|summary|changes|user_text|statement|detail_json|raw|html|source|target|code|diff|patch|description|error|file|path|reason|cause)$/i;
/** 字符串中独立出现的密钥形态（sk-…、长 Bearer）。 */
const KEY_PATTERN = /(\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._-]{16,}\b)/g;
/** 普通字符串保留上限（错误消息等；正文键不适用本上限而是整体丢弃）。 */
const MAX_FIELD_STRING = 300;

/**
 * 结构化字段清洗（修复 P1-9：白名单式脱敏，非截断）：
 * - 敏感键（token/apikey…）→ '[REDACTED]'；
 * - 正文键（text/content/prompt…）→ { chars, sha256 } 摘要（无法复原内容）；
 * - 其他字符串 → 去密钥形态 + 300 字符截断（开头/中间/结尾都不可能承载 2000 字正文）；
 * - Error / cause 递归清洗（message 本身按正文键处理：只留长度与哈希）。
 */
export function redactValue(value: unknown, depth = 0, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (CONTENT_KEY_RE.test(key)) return summarizeText(value);
    const masked = value.replace(KEY_PATTERN, '[REDACTED]');
    if (masked.length > MAX_FIELD_STRING) {
      return `${masked.slice(0, MAX_FIELD_STRING)}…[truncated ${masked.length}]`;
    }
    return masked;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const sampled = value.length > 20 ? value.slice(0, 20) : value;
    const cleaned = sampled.map((v) => redactValue(v, depth + 1, key));
    return value.length > 20 ? [...cleaned, `[${value.length} items]`] : cleaned;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: summarizeText(value.message),
      ...(value.cause !== undefined ? { cause: redactValue(value.cause, depth + 1, 'cause') } : {}),
    };
  }
  if (typeof value === 'object') {
    if (depth > 6) return '[DEEP]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_RE.test(k)) {
        out[k] = typeof v === 'string' ? summarizeText(v) : '[REDACTED]';
      } else {
        out[k] = redactValue(v, depth + 1, k);
      }
    }
    return out;
  }
  return String(value);
}

/** 正文摘要：字符数 + SHA-256 前 12 位。只有统计意义，不能复原内容。 */
function summarizeText(text: string): string {
  const clean = text.replace(KEY_PATTERN, '[REDACTED]');
  const hash = createHash('sha256').update(clean).digest('hex').slice(0, 12);
  return `[content ${clean.length} chars sha256:${hash}]`;
}

export interface LoggerOptions {
  /** JSONL 日志文件路径；缺省只输出到 stdout */
  file?: string;
  level?: LogLevel;
  baseFields?: Record<string, unknown>;
}

/**
 * 结构化日志。日志中禁止出现原始对话正文与 API Key（见 redactValue）。
 * debug 级别同样经过清洗——生产日志不因级别而恢复原文。
 */
export class Logger {
  private readonly file?: string;
  private readonly level: LogLevel;
  private readonly baseFields: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    this.file = opts.file;
    this.level = opts.level ?? (process.env.IXAEON_LOG_LEVEL as LogLevel) ?? 'info';
    this.baseFields = opts.baseFields ?? {};
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
    }
  }

  child(fields: Record<string, unknown>): Logger {
    const child = new Logger({
      file: this.file,
      level: this.level,
      baseFields: { ...this.baseFields, ...fields },
    });
    return child;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.level)) return;
    // 消息本体按正文处理（只保留长度与哈希，杜绝正文借 message 泄漏）
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message: summarizeMessage(message),
      ...(redactValue({ ...this.baseFields, ...fields }) as Record<string, unknown>),
    });
    if (this.file) {
      try {
        appendFileSync(this.file, line + '\n', 'utf8');
      } catch {
        // 日志写入失败时静默，不能因日志拖垮主流程
      }
    }
    // 控制台同步输出（Electron 主进程可见）
    const sink = level === 'error' ? process.stderr : process.stdout;
    try {
      sink.write(line + '\n');
    } catch {
      /* ignore */
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }
}

/**
 * 消息文本清洗：日志的 message 是自由文本（多为事件名），但可能被调用方
 * 拼入错误正文。保留短消息；超长消息按正文摘要（唯一标识 + 长度）。
 */
function summarizeMessage(message: string): string {
  const clean = message.replace(KEY_PATTERN, '[REDACTED]');
  if (clean.length <= 200) return clean;
  return summarizeText(clean);
}
