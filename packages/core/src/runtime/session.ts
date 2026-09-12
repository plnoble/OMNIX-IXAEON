import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import type { AskResult } from '../storage/askStore.js';
import { HermesRuntimeAdapter } from './adapter.js';
import { CORE_TOOL_NAMES, CoreToolBroker, type CoreToolName } from './broker.js';

const MAX_ROUNDS = 4;

const actionSchema = z.object({
  tool: z.enum([...CORE_TOOL_NAMES, 'answer']),
  args: z.record(z.string(), z.unknown()).default({}),
});

export interface AgentStep {
  round: number;
  tool: string;
  ok: boolean;
  detail: string;
}

export interface AgentSessionResult extends AskResult {
  engine: 'hermes' | 'core-bounded' | 'missing';
  runId: string;
  steps: AgentStep[];
}

const SYSTEM = [
  '你是 IXAEON Core 有界会话。这不是 Hermes。缺 Hermes 时走本循环，禁止假装引擎已接通。',
  '只输出一个 JSON 对象：{"tool":"...","args":{...}}。',
  `允许的 tool：${CORE_TOOL_NAMES.join('、')}、answer。`,
  '规则：',
  '1. 先 search_memory / get_project_context / get_evidence，再决定是否需要网络或任务。',
  '2. search_web 未配置会失败，必须如实告诉用户，不得编造搜索结果。',
  '3. dispatch_coding_task 必须失败：编码只能由桌面用户批准。',
  '4. 资料不足就 answer 说明缺口。禁止编造引用。',
  '5. answer 的 args.text 是给用户的中文回答。',
].join('\n');

/**
 * 桌面问答的产品路径：先探 Hermes；未装则用已配置模型 + Core 工具。
 * 不把单轮 AskService 冒充 Agent 循环，也不把缺引擎写成成功。
 */
export class AgentSession {
  private cancelled = new Set<string>();

  constructor(
    private readonly db: CoreDatabase,
    private readonly adapter: HermesRuntimeAdapter,
    private readonly broker: CoreToolBroker,
    private readonly provider: ModelProvider | null,
  ) {}

  cancel(runId: string): void {
    this.cancelled.add(runId);
    void this.adapter.cancel(runId);
    const existing = this.db.prepare('SELECT id FROM runtime_runs WHERE id = ?').get(runId) as
      { id: string } | undefined;
    if (!existing) return;
    this.db
      .prepare(
        `UPDATE runtime_runs SET status = 'cancelled', notice = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run('用户取消', new Date().toISOString(), runId);
  }

  async run(input: {
    goal: string;
    projectId: string | null;
    runId?: string;
  }): Promise<AgentSessionResult> {
    const goal = input.goal.trim();
    if (!goal) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '问题不能为空');
    const runId = input.runId ?? randomUUID();
    const now = new Date().toISOString();
    const caps = this.adapter.probe();

    if (caps.locator.found) {
      try {
        const hermes = await this.adapter.start({
          runId,
          goal,
          contextRef: input.projectId ?? 'personal',
          allowedTools: [...CORE_TOOL_NAMES],
          permissionVersion: '1',
          budget: { maxToolCalls: MAX_ROUNDS, timeoutMs: 120_000 },
          idempotencyKey: runId,
        });
        const steps: AgentStep[] = hermes.events.map((ev, i) => ({
          round: i + 1,
          tool: ev.kind,
          ok: ev.kind !== 'failed',
          detail: JSON.stringify(ev.payload).slice(0, 400),
        }));
        const status =
          hermes.status === 'cancelled'
            ? 'cancelled'
            : hermes.status === 'failed'
              ? 'failed'
              : 'succeeded';
        const notice =
          hermes.status === 'terminal'
            ? '本轮经 Hermes TUI gateway（stdio JSON-RPC）。不是单轮检索。'
            : hermes.status === 'cancelled'
              ? '用户取消 Hermes 会话'
              : 'Hermes 会话失败，未假装完成。';
        this.insertRun(runId, goal, input.projectId, 'hermes', status, steps, notice, now);
        return {
          ...this.asAsk(hermes.answer || notice, notice, 'hermes'),
          engine: 'hermes',
          runId,
          steps,
        };
      } catch {
        /* 可执行文件在、会话未通：落到 Core 循环，不假装 Hermes 已完成。 */
      }
    }

    if (!this.provider) {
      const notice = caps.locator.found
        ? 'Hermes 会话探针未通过，且模型未配置，不能假装 Agent 已接通。'
        : `Hermes 未安装：${caps.locator.reason} 模型也未配置，问答无法进入工具循环。`;
      this.insertRun(runId, goal, input.projectId, 'missing', 'blocked', [], notice, now);
      throw new IxaError(ErrorCodes.MODEL_NOT_CONFIGURED, notice);
    }

    const engine: AgentSessionResult['engine'] = 'core-bounded';
    const notice = caps.locator.found
      ? 'Hermes 可执行文件存在，但 stdio 会话未探针通过，本轮走 Core 有界循环，不是完整 Hermes。'
      : `Hermes 未安装，本轮走 Core 有界工具循环（不是 Hermes）。${caps.locator.reason}`;
    const steps: AgentStep[] = [];
    let transcript = `用户问题：${goal}\n项目：${input.projectId ?? '个人视角'}\n${notice}`;
    this.insertRun(runId, goal, input.projectId, engine, 'running', steps, notice, now);

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (this.cancelled.has(runId)) {
        this.finish(runId, goal, input.projectId, engine, 'cancelled', steps, '用户取消', now);
        return {
          ...this.asAsk(
            '已取消。取消后的晚到工具结果不会当作完成。',
            '用户取消',
            this.provider.modelName,
          ),
          engine,
          runId,
          steps,
        };
      }
      let action: z.infer<typeof actionSchema>;
      try {
        action = await this.provider.chatStructured({
          system: SYSTEM,
          user: transcript,
          schema: actionSchema,
        });
        if (this.cancelled.has(runId)) {
          this.finish(runId, goal, input.projectId, engine, 'cancelled', steps, '用户取消', now);
          return {
            ...this.asAsk(
              '已取消。取消后的晚到工具结果不会当作完成。',
              '用户取消',
              this.provider.modelName,
            ),
            engine,
            runId,
            steps,
          };
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        steps.push({ round, tool: 'model', ok: false, detail });
        this.finish(
          runId,
          goal,
          input.projectId,
          engine,
          'failed',
          steps,
          `${notice}\n${detail}`,
          now,
        );
        return {
          ...this.asAsk(`模型动作失败：${detail}`, notice, this.provider.modelName),
          engine,
          runId,
          steps,
        };
      }

      if (action.tool === 'answer') {
        const text = String(action.args.text ?? action.args.answer ?? '').trim();
        steps.push({ round, tool: 'answer', ok: true, detail: text.slice(0, 200) });
        this.finish(runId, goal, input.projectId, engine, 'succeeded', steps, notice, now);
        return {
          ...this.asAsk(text || '（空回答）', notice, this.provider.modelName),
          engine,
          runId,
          steps,
        };
      }

      try {
        const result = await this.broker.invoke(action.tool as CoreToolName, action.args, {
          audience: 'model',
          runId,
          projectId: input.projectId,
        });
        const detail = JSON.stringify(result).slice(0, 1500);
        steps.push({ round, tool: action.tool, ok: true, detail });
        transcript += `\n\n工具 ${action.tool} 成功：${detail}`;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        steps.push({ round, tool: action.tool, ok: false, detail });
        transcript += `\n\n工具 ${action.tool} 失败：${detail}。不要编造成功，必要时 answer 说明缺口。`;
      }
    }

    const stopped = '已达轮次上限，未形成最终回答。以上工具结果不是完成证明。';
    this.finish(
      runId,
      goal,
      input.projectId,
      engine,
      'failed',
      steps,
      `${notice}\n${stopped}`,
      now,
    );
    return {
      ...this.asAsk(stopped, notice, this.provider.modelName),
      engine,
      runId,
      steps,
    };
  }

  private asAsk(answer: string, notice: string, modelName: string): AskResult {
    return {
      answer,
      citations: [],
      notice,
      usedChars: answer.length,
      modelName,
    };
  }

  private insertRun(
    id: string,
    goal: string,
    projectId: string | null,
    engine: AgentSessionResult['engine'],
    status: string,
    steps: AgentStep[],
    notice: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO runtime_runs (id, goal, project_id, engine, status, events_json, notice, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, goal, projectId, engine, status, JSON.stringify(steps), notice, now, now);
  }

  private finish(
    id: string,
    goal: string,
    projectId: string | null,
    engine: AgentSessionResult['engine'],
    status: string,
    steps: AgentStep[],
    notice: string,
    createdAt: string,
  ): void {
    const existing = this.db.prepare('SELECT id FROM runtime_runs WHERE id = ?').get(id) as
      { id: string } | undefined;
    if (!existing) {
      this.insertRun(id, goal, projectId, engine, status, steps, notice, createdAt);
      return;
    }
    this.db
      .prepare(
        `UPDATE runtime_runs SET status = ?, events_json = ?, notice = ?, finished_at = ? WHERE id = ?`,
      )
      .run(status, JSON.stringify(steps), notice, new Date().toISOString(), id);
  }
}
