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
    return {
      session: ok,
      stop: ok,
      toolAllowlist: ok,
      usage: false,
      resume: false,
      streaming: ok,
      probedAt: new Date().toISOString(),
      engine: ok ? 'hermes' : 'missing',
      locator,
    };
  }

  async start(input: RuntimeRunInput): Promise<HermesRunResult> {
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
    const session = new TuiGatewaySession(transport, input, this.broker);
    this.live.set(input.runId, session);
    try {
      const result = await session.run();
      return result;
    } finally {
      session.dispose();
      this.live.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.live.get(runId)?.interrupt();
  }
}
