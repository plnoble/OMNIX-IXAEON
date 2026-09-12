import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import { PassThrough } from 'node:stream';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { JsonRpcStdio } from './jsonrpcStdio.js';
import type { RuntimeEvent, RuntimeRunInput } from './adapter.js';
import type { CoreToolBroker, CoreToolName } from './broker.js';
import { CORE_TOOL_NAMES } from './broker.js';

export interface TuiTransport {
  rpc: JsonRpcStdio;
  kill(): void;
}

export interface TuiSpawnOptions {
  cwd?: string | null;
  env?: Record<string, string>;
}

export type TransportFactory = (exe: string, args: string[], opts: TuiSpawnOptions) => TuiTransport;

const CORE_TOOL_SET = new Set<string>(CORE_TOOL_NAMES);

/**
 * 官方 TUI gateway 方法（已对照锁定安装 v2026.9.11 的 tui_gateway 源码核实）：
 * session.create / prompt.submit / session.interrupt / session.close / approval.respond。
 * 事件帧统一为 {"jsonrpc":"2.0","method":"event","params":{"type":…,"session_id":…,"payload":{…}}}，
 * 事件名在 params.type：gateway.ready、message.start/delta/interim/complete、
 * tool.start/tool.complete（payload.tool_id/name/args）、approval.request、error。
 * message.complete 的 payload 带 {text, status}，status=error 表示回合失败。
 *
 * tool.respond 不存在：Hermes 代理自跑其工具。Core 工具桥接的诚实路径是
 * 把 Core 暴露为 MCP 服务器再由 Hermes 配置（记入 docs/runtime-lock.json），
 * 不在 stdio 上伪造工具应答。
 */
export class TuiGatewaySession {
  private seq = 0;
  private events: RuntimeEvent[] = [];
  private sessionId: string | null = null;
  private finished: ((status: 'terminal' | 'cancelled' | 'failed') => void) | null = null;
  private status: 'running' | 'terminal' | 'cancelled' | 'failed' = 'running';
  private answerParts: string[] = [];

  constructor(
    private readonly transport: TuiTransport,
    private readonly input: RuntimeRunInput,
    private readonly broker?: CoreToolBroker,
  ) {
    transport.rpc.on('notification', (method: string, params: unknown) => {
      void this.onNotification(method, params);
    });
    transport.rpc.on('close', () => {
      if (this.status === 'running') this.end('failed');
    });
  }

  static spawnProcess(exe: string, args: string[], opts: TuiSpawnOptions = {}): TuiTransport {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.env) Object.assign(env, opts.env);
    const child: ChildProcessWithoutNullStreams = spawn(exe, args, {
      cwd: opts.cwd ?? undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    const rpc = new JsonRpcStdio(child.stdout, child.stdin);
    return {
      rpc,
      kill() {
        child.kill();
        rpc.close();
      },
    };
  }

  static fromStreams(readable: PassThrough, writable: PassThrough): TuiTransport {
    const rpc = new JsonRpcStdio(readable, writable);
    return {
      rpc,
      kill() {
        rpc.close();
        readable.end();
        writable.end();
      },
    };
  }

  async run(): Promise<{
    events: RuntimeEvent[];
    answer: string;
    status: 'terminal' | 'cancelled' | 'failed';
  }> {
    try {
      const created = (await this.transport.rpc.request('session.create', { cols: 80 })) as {
        session_id?: string;
      } | null;
      this.sessionId = created?.session_id ?? this.input.runId;
      this.push('text', { phase: 'session.create', sessionId: this.sessionId });
      if (this.status !== 'running') {
        return this.snapshot();
      }
      await this.transport.rpc.request('prompt.submit', {
        session_id: this.sessionId,
        text: this.input.goal,
      });
      if (this.status !== 'running') {
        return this.snapshot();
      }
      await this.waitTerminal(this.input.budget.timeoutMs);
      return this.snapshot();
    } catch (err) {
      if (this.status === 'cancelled') {
        return this.snapshot();
      }
      this.push('failed', { error: err instanceof Error ? err.message : String(err) });
      this.status = 'failed';
      throw err;
    }
  }

  snapshot(): {
    events: RuntimeEvent[];
    answer: string;
    status: 'terminal' | 'cancelled' | 'failed';
  } {
    const status = this.status === 'running' ? 'failed' : this.status;
    return { events: this.events, answer: this.answerParts.join(''), status };
  }

  interrupt(): void {
    if (this.sessionId) {
      this.transport.rpc.notify('session.interrupt', { session_id: this.sessionId });
    }
    this.end('cancelled');
    this.transport.rpc.rejectPending(new Error('session.interrupt'));
  }

  dispose(): void {
    if (this.sessionId) {
      this.transport.rpc.notify('session.close', { session_id: this.sessionId });
    }
    this.transport.kill();
  }

  private waitTerminal(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.status !== 'running') {
        if (this.status === 'failed') {
          reject(new IxaError(ErrorCodes.SERVER_UNAVAILABLE, 'TUI gateway 会话失败'));
        } else resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.end('failed');
        reject(new IxaError(ErrorCodes.SERVER_UNAVAILABLE, 'TUI gateway 会话超时'));
      }, timeoutMs);
      this.finished = (status) => {
        clearTimeout(timer);
        if (status === 'failed') {
          reject(new IxaError(ErrorCodes.SERVER_UNAVAILABLE, 'TUI gateway 会话失败'));
        } else resolve();
      };
    });
  }

  private async onNotification(method: string, params: unknown): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;
    // 真实事件帧：method='event'，事件名在 params.type，负载在 params.payload。
    if (method === 'event' && typeof p.type === 'string') {
      const sid = typeof p.session_id === 'string' ? p.session_id : '';
      if (sid && this.sessionId && sid !== this.sessionId) return; // 只看本会话
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      await this.onEvent(String(p.type), payload);
      return;
    }
    // 非 event 帧不是本网关契约，记录为未处理，不臆测语义。
    this.push('text', { unhandled: method, params: p });
  }

  private async onEvent(event: string, p: Record<string, unknown>): Promise<void> {
    switch (event) {
      case 'gateway.ready':
        this.push('text', { phase: 'gateway.ready' });
        break;
      case 'message.start':
        this.push('text', { phase: 'message.start' });
        break;
      case 'message.delta':
        this.answerParts.push(String(p.text ?? p.delta ?? ''));
        this.push('text', { delta: p.text ?? p.delta });
        break;
      case 'message.complete': {
        // 真实语义：payload.text 是整段最终回复（非增量），status=error 表示回合失败。
        const text = typeof p.text === 'string' ? p.text : '';
        const status = String(p.status ?? '');
        if (text.length > 0) this.answerParts = [text];
        this.push('text', { complete: true, text, status });
        if (status === 'error') {
          this.push('failed', {
            error: String(p.error ?? p.message ?? 'Hermes 回合失败'),
            status,
          });
          this.end('failed');
        } else {
          this.end('terminal');
        }
        break;
      }
      case 'tool.start': {
        const name = String(p.name ?? '');
        const callId = String(p.tool_id ?? p.call_id ?? randomUUID());
        const args = (p.args ?? {}) as Record<string, unknown>;
        this.push('tool_request', { name, callId, args });
        // 只把 Core 白名单工具接到本地 broker；其余由 Hermes 自行执行。
        if (this.broker && CORE_TOOL_SET.has(name)) {
          try {
            const result = await this.broker.invoke(name as CoreToolName, args, {
              audience: 'model',
              runId: this.input.runId,
            });
            this.push('tool_result', { name, callId, ok: true, result });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.push('tool_result', { name, callId, ok: false, error: message });
          }
        }
        break;
      }
      case 'tool.complete':
        this.push('tool_result', { complete: true, ...p });
        break;
      case 'approval.request': {
        // 危险命令/执行类审批（负载含 request_id/command/description/choices）。
        // 策略：负载文本命中会话 allowedTools 白名单的自动放行一次（choice=once），
        // 否则明确拒绝——不放行未授权操作，也不让回合挂死等超时。
        this.push('needs_approval', p);
        const requestId = String(p.request_id ?? '');
        if (!requestId || !this.sessionId) break;
        const hay = [p.description, p.command, p.tool_name, p.name, p.tool]
          .map((v) => (typeof v === 'string' ? v : ''))
          .join(' ');
        const allowed = this.input.allowedTools.some((t) => t.length > 0 && hay.includes(t));
        const choice = allowed ? 'once' : 'deny';
        try {
          await this.transport.rpc.request('approval.respond', {
            session_id: this.sessionId,
            request_id: requestId,
            choice,
            all: false,
          });
          this.push('text', { approval: choice, request_id: requestId });
        } catch (err) {
          this.push('text', {
            approval: 'respond_failed',
            request_id: requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'error':
        this.push('failed', { error: String(p.message ?? p.error ?? '网关错误') });
        this.end('failed');
        break;
      default:
        this.push('text', { unhandled: event, params: p });
    }
  }

  private end(status: 'terminal' | 'cancelled' | 'failed'): void {
    if (this.status !== 'running') return;
    this.status = status;
    this.push(status === 'terminal' ? 'terminal' : status, {});
    this.finished?.(status);
    this.finished = null;
  }

  private push(kind: RuntimeEvent['kind'], payload: Record<string, unknown>): void {
    this.seq += 1;
    this.events.push({
      runId: this.input.runId,
      eventId: randomUUID(),
      seq: this.seq,
      timestamp: new Date().toISOString(),
      kind,
      payload,
    });
  }
}

export function hermesGatewayArgs(): string[] {
  const raw = process.env.IXAEON_HERMES_GATEWAY_ARGS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        return parsed as string[];
      }
    } catch {
      return raw.split(/\s+/).filter(Boolean);
    }
  }
  // 已对照锁定安装（v2026.9.11）核实：官方 TUI 客户端与仓库自带探针都用
  // venv python 启动 stdio 网关。exe 必须是 venv python，cwd/PYTHONPATH 见定位器。
  return ['-u', '-m', 'tui_gateway.entry'];
}
