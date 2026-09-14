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
      resume: false,
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
    const transport = this.transportFactory
      ? this.transportFactory(caps.locator.exe, args, opts)
      : TuiGatewaySession.spawnProcess(caps.locator.exe, args, opts);
    const session = new TuiGatewaySession(transport, input, this.broker, {
      resumeSessionId: resumeSessionId ?? null,
      // A06：每个事件实时回调（账本持续化由调用方注入）
      onEvent: (event) => this.eventSink?.(event),
      mcpBridgedTools: mcpBridgedTools ?? [],
    });
    this.live.set(input.runId, session);
    try {
      const result = await session.run();
      return result;
    } finally {
      session.dispose();
      this.live.delete(input.runId);
    }
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
