import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = Record<string, unknown>;

/**
 * 换行分隔的 JSON-RPC 2.0（TUI gateway 常用）。也接受 LSP 式 Content-Length。
 * 不是 Hermes 本体；只负责把字节变成消息。
 */
export class JsonRpcStdio extends EventEmitter {
  private nextId = 1;
  private buf = '';
  private headerMode: 'unknown' | 'ndjson' | 'lsp' = 'unknown';
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    super();
    this.input.setEncoding?.('utf8');
    this.input.on('data', (chunk: string | Buffer) => this.onData(String(chunk)));
    this.input.on('end', () => this.failAll(new Error('stdio 已结束')));
    this.input.on('error', (err: Error) => this.failAll(err));
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('JSON-RPC 已关闭'));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`JSON-RPC 超时：${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params } satisfies JsonRpcNotification);
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('JSON-RPC 已关闭'));
  }

  rejectPending(err: Error): void {
    this.failAll(err);
  }

  private write(msg: object): void {
    this.output.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.headerMode === 'unknown') {
      this.headerMode = /Content-Length:/i.test(this.buf) ? 'lsp' : 'ndjson';
    }
    if (this.headerMode === 'lsp') this.drainLsp();
    else this.drainNdjson();
  }

  private drainNdjson(): void {
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) this.dispatch(line);
      idx = this.buf.indexOf('\n');
    }
  }

  private drainLsp(): void {
    while (true) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buf.slice(0, sep);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.slice(sep + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.slice(start, start + len);
      this.buf = this.buf.slice(start + len);
      this.dispatch(body);
    }
  }

  private dispatch(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      this.emit('error', new Error(`无法解析 JSON-RPC：${raw.slice(0, 120)}`));
      return;
    }
    const hasMethod = typeof msg.method === 'string';
    const hasId = msg.id !== undefined;
    const isResult = Object.prototype.hasOwnProperty.call(msg, 'result');
    const isError = Object.prototype.hasOwnProperty.call(msg, 'error');
    if (hasMethod && !isResult && !isError) {
      if (hasId) this.emit('request', msg);
      else this.emit('notification', msg.method, msg.params ?? {});
      return;
    }
    if (hasId && msg.id !== null) {
      const pending = this.pending.get(String(msg.id));
      if (!pending) return;
      this.pending.delete(String(msg.id));
      if (isError) {
        const err = msg.error as { message?: string } | undefined;
        pending.reject(new Error(err?.message ?? 'JSON-RPC error'));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.emit('close', err);
  }
}
