import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { locateHermes, hermesSpawnEnv, type HermesLocator } from './hermesLocator.js';
import {
  TuiGatewaySession,
  hermesGatewayArgs,
  type TuiTransport,
  type TuiSpawnOptions,
} from './tuiGateway.js';
import type { CoreToolBroker } from './broker.js';

export interface RuntimeCapabilities {
  session: boolean;
  stop: boolean;
  toolAllowlist: boolean;
  usage: boolean;
  resume: boolean;
  streaming: boolean;
  probedAt: string;
  engine: 'hermes' | 'missing';
  locator: HermesLocator;
}

export interface RuntimeRunInput {
  runId: string;
  goal: string;
  contextRef: string;
  allowedTools: string[];
  permissionVersion: string;
  budget: { maxToolCalls: number; timeoutMs: number };
  idempotencyKey: string;
}

export interface RuntimeEvent {
  runId: string;
  eventId: string;
  seq: number;
  timestamp: string;
  kind:
    | 'text'
    | 'tool_request'
    | 'tool_result'
    | 'needs_approval'
    | 'usage'
    | 'artifact'
    | 'failed'
    | 'cancelled'
    | 'terminal';
  payload: Record<string, unknown>;
}

export interface HermesRunResult {
  events: RuntimeEvent[];
  answer: string;
  status: 'terminal' | 'cancelled' | 'failed';
  /** session.info 上报的真实模型名（未上报时 null）。 */
  modelName: string | null;
  /** session.info 上报的真实提供商（未上报时 null）。 */
  providerName: string | null;
  /** 本回合使用的引擎会话 id（A06：同 AgentSession 实例复用）。 */
  sessionId: string | null;
}

/**
 * Hermes 适配器：能力以实测为准。本机未装时所有会话能力为 false。
 * 找到可执行文件后走官方 TUI gateway JSON-RPC（stdio），不假装单轮问答就是 Agent。
 */
export class HermesRuntimeAdapter {
  private live = new Map<string, TuiGatewaySession>();
  /**
   * A06：长驻 gateway 会话——同一引擎进程内复用 session_id 才有效
   *（session 是进程内的，不能每次 spawn 新进程再拿旧 session_id 去续问）。
   * 键为 contextRef（个人/项目），值为活着的 TuiGatewaySession。
   */
  private resident = new Map<string, TuiGatewaySession>();

  constructor(
    private readonly broker?: CoreToolBroker,
    private readonly transportFactory?: (
      exe: string,
      args: string[],
      opts: TuiSpawnOptions,
    ) => TuiTransport,
  ) {}

  probe(): RuntimeCapabilities {
    const locator = locateHermes();
    const ok = locator.found;
    // A01（审核 2026-09-13）：能力必须区分「协议已核实支持」与「Core 侧自行兜底」。
    // session/stop/streaming 是锁定安装 v2026.9.11 上核实过的协议方法；
    // toolAllowlist 诚实报告为 false——TUI gateway 协议本身不携带工具白名单，
    // 白名单由 Core 在 tool 边界强制执行（见 TuiGatewaySession），
    // 不能因找到 python.exe 就声称引擎侧已有该能力。
    return {
      session: ok,
      stop: ok,
      toolAllowlist: false,
      usage: false,
      resume: true,
      streaming: ok,
      probedAt: new Date().toISOString(),
      engine: ok ? 'hermes' : 'missing',
      locator,
    };
  }

  async start(
    input: RuntimeRunInput,
    /** A06：复用既有引擎会话（同 AgentSession 实例的后续回合）。 */
    resumeSessionId?: string | null,
    /** A06：已由 MCP 桥接执行的工具（防 tool.start 双执行）。 */
    mcpBridgedTools?: string[],
  ): Promise<HermesRunResult> {
    const caps = this.probe();
    if (!caps.locator.found || !caps.locator.exe) {
      throw new IxaError(
        ErrorCodes.NOT_FOUND,
        `Hermes 未安装：${caps.locator.reason} 目标=${input.goal.slice(0, 80)}`,
      );
    }
    const args = hermesGatewayArgs();
    const opts: TuiSpawnOptions = {
      cwd: caps.locator.cwd,
      env: hermesSpawnEnv(caps.locator),
    };
    // A06：同 contextRef 的长驻会话优先复用（同一进程内续 session_id）；
    // 已死亡/被取消的扔掉重建。resumeSessionId 仅在有活进程时作为跨进程提示。
    const resident = this.resident.get(input.contextRef);
    let session: TuiGatewaySession;
    if (resident && !resident.isDead) {
      session = resident;
      // 复用长驻进程内已有 session_id；调用方传来的 resumeSessionId 与之一致。
      session.setInput(input);
      session.configureEventSink((event) => this.eventSink?.(event));
      session.setMcpBridgedTools(mcpBridgedTools ?? []);
    } else {
      this.resident.delete(input.contextRef);
      const transport = this.transportFactory
        ? this.transportFactory(caps.locator.exe, args, opts)
        : TuiGatewaySession.spawnProcess(caps.locator.exe, args, opts);
      session = new TuiGatewaySession(transport, input, this.broker, {
        // 新进程：只能从 session.create 开始（旧 session_id 不属于新进程）
        resumeSessionId: null,
        onEvent: (event) => this.eventSink?.(event),
        mcpBridgedTools: mcpBridgedTools ?? [],
      });
    }
    this.live.set(input.runId, session);
    this.resident.set(input.contextRef, session);
    try {
      const result = await session.run();
      if (session.isDead) {
        // 进程死了（错误/中断）——长驻会话作废，下次重建。
        this.resident.delete(input.contextRef);
      }
      return result;
    } catch (err) {
      this.resident.delete(input.contextRef);
      throw err;
    } finally {
      this.live.delete(input.runId);
    }
  }

  /** A06：清理所有长驻会话（应用退出时）。 */
  disposeAll(): void {
    for (const s of this.resident.values()) s.dispose();
    this.resident.clear();
    this.live.clear();
  }

  /** A06：运行事件实时观察器（账本落库等）。 */
  setEventSink(sink: ((event: RuntimeEvent) => void) | null): void {
    this.eventSink = sink;
  }
  private eventSink: ((event: RuntimeEvent) => void) | null = null;

  async cancel(runId: string): Promise<void> {
    this.live.get(runId)?.interrupt();
  }
}
