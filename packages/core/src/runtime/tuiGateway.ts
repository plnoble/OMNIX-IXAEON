import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type PassThrough } from 'node:stream';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { JsonRpcStdio } from './jsonrpcStdio.js';
import type { RuntimeEvent, RuntimeRunInput } from './adapter.js';
import type { CoreToolBroker, CoreToolName } from './broker.js';
import { CORE_TOOL_NAMES } from './broker.js';

export interface TuiTransport {
  rpc: JsonRpcStdio;
  kill(): void;
  /** 当子进程非正常提前退出时触发（借鉴 vermes 网关守护模式） */
  onUnexpectedExit?(
    callback: (code: number | null, signal: string | null, stderrTail: string) => void,
  ): void;
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
  /** session.info 上报的真实模型/提供商（用户 2026-09-13 实测轨迹里带出）。 */
  private modelName: string | null = null;
  private providerName: string | null = null;
  /** A01：已执行的 tool 调用幂等集（callId 去重，重复通知不重复产生副作用）。 */
  private executedCalls = new Set<string>();
  /** A01：实际产生 Core 副作用的工具调用次数（受 budget.maxToolCalls 约束）。 */
  private toolSideEffects = 0;
  private currentInput: RuntimeRunInput;
  private currentEventSink: ((event: RuntimeEvent) => void) | null = null;
  private currentMcpBridged: string[] = [];
  private dead = false;

  constructor(
    private readonly transport: TuiTransport,
    input: RuntimeRunInput,
    private readonly broker?: CoreToolBroker,
    opts: {
      /** A06：复用既有引擎会话（同 AgentSession 实例的后续回合）。 */
      resumeSessionId?: string | null;
      /** A06：每个事件实时回调（账本持续化由调用方注入）。 */
      onEvent?: (event: RuntimeEvent) => void;
      /**
       * A06：已由 MCP 桥接执行的工具名（结果经 MCP 协议回交引擎）。
       * 这些工具的 tool.start 通知不再本地执行，防同一动作双执行。
       */
      mcpBridgedTools?: string[];
    } = {},
  ) {
    this.currentInput = input;
    if (opts.onEvent) this.currentEventSink = opts.onEvent;
    if (opts.mcpBridgedTools) this.currentMcpBridged = opts.mcpBridgedTools;
    if (opts.resumeSessionId) this.sessionId = opts.resumeSessionId;
    transport.rpc.on('notification', (method: string, params: unknown) => {
      this.lastActivityAt = Date.now();
      void this.onNotification(method, params);
    });
    transport.rpc.on('close', () => {
      this.dead = true;
      if (this.status === 'running') this.end('failed');
    });
    transport.onUnexpectedExit?.((code, signal, stderrTail) => {
      this.dead = true;
      const detail = stderrTail ? `：${stderrTail}` : '';
      const exitMsg = `Hermes 进程异常退出 (code ${code ?? 'null'}, signal ${signal ?? 'none'})${detail}`;
      this.push('failed', { error: exitMsg });
      if (this.status === 'running') this.end('failed');
      transport.rpc.rejectPending(new IxaError(ErrorCodes.SERVER_UNAVAILABLE, exitMsg));
    });
  }

  private lastActivityAt = Date.now();

  /** A06：长驻会话在复用前更新当前回合的输入参数（runId/goal/budget 等）。 */
  setInput(input: RuntimeRunInput): void {
    this.currentInput = input;
    // 重置回合级状态（保留长驻进程与 sessionId，重置单回合回答与幂等集）
    this.answerParts = [];
    this.events = [];
    this.seq = 0;
    this.status = 'running';
    this.executedCalls.clear();
    this.toolSideEffects = 0;
  }

  configureEventSink(sink: ((event: RuntimeEvent) => void) | null): void {
    this.currentEventSink = sink;
  }

  setMcpBridgedTools(tools: string[]): void {
    this.currentMcpBridged = tools;
  }

  /** 长驻进程是否已死亡（报错/关闭）。 */
  get isDead(): boolean {
    return this.dead;
  }

  get permissionVersion(): string {
    return this.currentInput.permissionVersion;
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

    // vermes 守护模式：stderr 缓冲区与异常退出捕获
    let intentionalKill = false;
    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 50) stderrChunks.shift();
    });

    let exitHandler:
      ((code: number | null, signal: string | null, stderrTail: string) => void) | null = null;

    child.on('exit', (code, signal) => {
      if (!intentionalKill) {
        const stderrTail = stderrChunks.join('').slice(-2000).trim();
        exitHandler?.(code, signal, stderrTail);
      }
    });

    child.on('error', (err) => {
      if (!intentionalKill) {
        exitHandler?.(1, null, `进程启动或执行错误: ${err.message}`);
      }
    });

    return {
      rpc,
      onUnexpectedExit(cb) {
        exitHandler = cb;
      },
      kill() {
        intentionalKill = true;
        // A01：取消要停止子进程树（Hermes 可能再起子工具进程），
        // 不能只关 stdio 留孤儿进程。Windows 用 taskkill /T；失败回退 kill。
        if (child.pid) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
              shell: false,
            });
          } else {
            try {
              process.kill(-child.pid, 'SIGTERM');
            } catch {
              child.kill('SIGTERM');
            }
          }
        }
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
    modelName: string | null;
    providerName: string | null;
    sessionId: string | null;
  }> {
    try {
      // A06：复用会话时不重复 session.create——直接向既有会话提交回合。
      if (this.sessionId) {
        this.push('text', { phase: 'session.resume', sessionId: this.sessionId });
      } else {
        const created = (await this.transport.rpc.request('session.create', {
          cols: 80,
        })) as { session_id?: string } | null;
        this.sessionId = created?.session_id ?? this.currentInput.runId;
        this.push('text', { phase: 'session.create', sessionId: this.sessionId });
      }
      if (this.status !== 'running') {
        return this.snapshot();
      }
      await this.transport.rpc.request('prompt.submit', {
        session_id: this.sessionId,
        text: this.currentInput.goal,
      });
      if (this.status !== 'running') {
        return this.snapshot();
      }
      await this.waitTerminal(this.currentInput.budget.timeoutMs);
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
    modelName: string | null;
    providerName: string | null;
    sessionId: string | null;
  } {
    const status = this.status === 'running' ? 'failed' : this.status;
    return {
      events: this.events,
      answer: this.answerParts.join(''),
      status,
      modelName: this.modelName,
      providerName: this.providerName,
      sessionId: this.sessionId,
    };
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
      this.lastActivityAt = Date.now();
      const timer = setTimeout(() => {
        clearInterval(watchdog);
        this.end('failed');
        reject(new IxaError(ErrorCodes.SERVER_UNAVAILABLE, 'TUI gateway 会话超时'));
      }, timeoutMs);

      // vermes 模式：静默无响应心跳守卫（连续 60 秒无任何 stdio/事件输出判定假死）
      const inactivityLimitMs = Math.min(timeoutMs, 60_000);
      const watchdog = setInterval(() => {
        if (this.status !== 'running') {
          clearInterval(watchdog);
          return;
        }
        if (Date.now() - this.lastActivityAt > inactivityLimitMs) {
          clearInterval(watchdog);
          clearTimeout(timer);
          this.end('failed');
          reject(
            new IxaError(
              ErrorCodes.SERVER_UNAVAILABLE,
              `TUI gateway 进程无响应（超过 ${Math.round(inactivityLimitMs / 1000)}s 静默无输出），已安全中止`,
            ),
          );
        }
      }, 5_000);

      this.finished = (status) => {
        clearTimeout(timer);
        clearInterval(watchdog);
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
      case 'session.info':
        // 真实模型/提供商在此上报（如 gemini-3.7-flash-tiered / custom:newapi）。
        this.modelName = typeof p.model === 'string' && p.model ? p.model : this.modelName;
        this.providerName =
          typeof p.provider === 'string' && p.provider ? p.provider : this.providerName;
        this.push('text', {
          phase: 'session.info',
          model: this.modelName,
          provider: this.providerName,
        });
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
        // A01：本地桥接执行的四道边界，全部满足才产生 Core 副作用——
        // 1. 会话仍在运行（终态/取消后的晚到通知不写入）；
        // 2. 工具名精确命中本轮 allowedTools 白名单（协议字段精确匹配，
        //    不做子串/文本匹配——description/command 文本不提供批准权）；
        // 3. callId 幂等（同一调用重复通知不重复执行）；
        // 4. 次数预算（实际副作用次数 ≤ budget.maxToolCalls）。
        let skipReason: string | null = null;
        if (this.status !== 'running') skipReason = 'session_not_running';
        else if (!this.currentInput.allowedTools.includes(name))
          skipReason = 'tool_not_in_allowed_tools';
        else if (this.executedCalls.has(callId)) skipReason = 'duplicate_call';
        else if (this.toolSideEffects >= this.currentInput.budget.maxToolCalls)
          skipReason = 'over_tool_call_budget';
        // A06：已由 MCP 桥接执行的工具（结果经协议回交引擎）不再在
        // tool.start 本地重复执行——同一动作不允许 Hermes 与 Core 各做一次。
        else if (this.currentMcpBridged.includes(name)) skipReason = 'mcp_bridged_not_local';
        if (this.broker && skipReason === null) {
          // 只把 Core 白名单工具接到本地 broker；其余由 Hermes 自行执行。
          if (CORE_TOOL_SET.has(name)) {
            this.executedCalls.add(callId);
            this.toolSideEffects += 1;
            try {
              const result = await this.broker.invoke(name as CoreToolName, args, {
                audience: 'model',
                runId: this.currentInput.runId,
              });
              this.push('tool_result', { name, callId, ok: true, result });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.push('tool_result', { name, callId, ok: false, error: message });
            }
          }
        } else if (skipReason !== null) {
          // 如实记录拒绝原因（不吞掉事件，方便审计回看）。
          this.push('tool_result', { name, callId, ok: false, skipped: true, reason: skipReason });
        }
        break;
      }
      case 'tool.complete':
        this.push('tool_result', { complete: true, ...p });
        break;
      case 'approval.request': {
        // 危险命令/执行类审批（负载含 request_id/command/description/choices）。
        // A01：审批只认可信协议字段 tool_name 与本轮 allowedTools 的**精确匹配**。
        // 命令文本/描述里出现白名单工具名（如 "echo search_memory"）不提供批准权。
        // 未命中白名单 → 明确拒绝（choice=deny），不放行未授权操作，
        // 也不让回合挂死等超时。
        this.push('needs_approval', p);
        const requestId = String(p.request_id ?? '');
        if (!requestId || !this.sessionId) break;
        const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
        const allowed =
          toolName.length > 0 &&
          this.currentInput.allowedTools.includes(toolName) &&
          this.status === 'running';
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
    const event: RuntimeEvent = {
      runId: this.currentInput.runId,
      eventId: randomUUID(),
      seq: this.seq,
      timestamp: new Date().toISOString(),
      kind,
      payload,
    };
    this.events.push(event);
    // A06：事件实时外送（账本持续化等）；观察器异常不中断回合，
    // 但如实记录到本地事件流，不静默吞掉。
    try {
      this.currentEventSink?.(event);
    } catch (err) {
      this.events.push({
        runId: this.currentInput.runId,
        eventId: randomUUID(),
        seq: this.seq + 1,
        timestamp: new Date().toISOString(),
        kind: 'text',
        payload: { ledgerWriteError: err instanceof Error ? err.message : String(err) },
      });
      this.seq += 1;
    }
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
