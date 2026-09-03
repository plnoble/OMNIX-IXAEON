import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACT_KEY_RE =
  /(apikey|api_key|token|secret|authorization|password|passwd|cookie|credential)/i;
const MAX_FIELD_STRING = 2000;
const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

/** 递归遮盖敏感字段；同时截断超长字符串，防止原文正文意外进入日志。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[DEEP]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const masked = value.replace(KEY_PATTERN, '[SK-REDACTED]');
    return masked.length > MAX_FIELD_STRING
      ? `${masked.slice(0, MAX_FIELD_STRING)}…[truncated ${masked.length}]`
      : masked;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.length > 50
      ? value.slice(0, 50).map((v) => redactValue(v, depth + 1))
      : value.map((v) => redactValue(v, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message) };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_RE.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LoggerOptions {
  /** JSONL 日志文件路径；缺省只输出到 stdout */
  file?: string;
  level?: LogLevel;
  baseFields?: Record<string, unknown>;
}

/** 结构化日志。日志中禁止出现原始对话正文与 API Key（见 redactValue）。 */
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
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
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
