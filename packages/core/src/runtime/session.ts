import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ErrorCodes, HERMES_BRIDGE_SERVER, IxaError, type MemoryUsedItem } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import type { AskResult } from '../storage/askStore.js';
import { ContextSelector, memoryOriginTag } from '../memory/contextSelector.js';
import type { SemanticIndex } from '../memory/semanticIndex.js';
import { getDisclosureEpoch } from '../access.js';
import { type HermesRuntimeAdapter } from './adapter.js';
import { CORE_TOOL_NAMES, type CoreToolBroker, type CoreToolName } from './broker.js';
import { explainModelFailure } from './modelErrors.js';
import { buildProjectBrief, type ProjectBriefCounts } from './projectBrief.js';
import { SUGGESTED_TODOS_INSTRUCTION } from './suggestedTodos.js';

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

/** D3：喂给本轮的历史消息（由调用方从 ConversationStore 取）。 */
export interface PriorTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 历史轮次注入的总字符上限：超出时丢弃最早的轮次，保留最近的。 */
const MAX_PRIOR_CHARS = 6_000;

/**
 * D3：把历史轮次拼成可注入的文本块。从最近往前取，超过上限就停，
 * 保证注入的是「最近若干轮」而不是被截断的半句话。
 */
function formatPriorTurns(turns: PriorTurn[]): string {
  if (turns.length === 0) return '';
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const line = `${turn.role === 'user' ? '用户' : '你'}：${turn.content}`;
    if (used + line.length > MAX_PRIOR_CHARS) break;
    used += line.length;
    kept.unshift(line);
  }
  if (kept.length === 0) return '';
  return `\n\n（本对话此前的内容，按时间正序，供你接上下文。这是已经发生过的对话，不要重复回答其中已答过的部分。）\n${kept.join('\n')}`;
}

export interface AgentSessionResult extends AskResult {
  engine: 'hermes' | 'core-bounded' | 'missing';
  runId: string;
  steps: AgentStep[];
  /** E5：Hermes 这一轮回答前注入的记忆（Core 兜底路径不填，它的依据在 citations 里）。 */
  memoryUsed?: MemoryUsedItem[];
  /** P3：这一轮带上的项目近况计数（block 为空不写）。 */
  projectBrief?: ProjectBriefCounts;
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
 *
 * A06（审核 2026-09-13）：
 * - 运行账本先插 running 行、事件实时落库（断电前的实际动作留在库里，
 *   不再「结束后才插」）；启动时孤儿 running 行按上一进程崩解标 failed。
 * - 同一 AgentSession 实例的 Hermes 回合复用引擎会话（session.create 只做
 *   一次，后续 prompt.submit 进同一 session_id）——「那我刚才说的呢」
 *   依靠同会话背景获得保证，不再每次 Ask 都是无记忆的新会话。
 * - 派发前先取项目上下文（get_project_context），把 Core 记忆随目标一起
 *   交给引擎——contextRef 不再是只传不用的一句配置。
 */
export class AgentSession {
  private cancelled = new Set<string>();
  /** Hermes 会话复用（A06）：同实例二次 run 复用引擎侧会话。 */
  private hermesSessionId: string | null = null;
  /**
   * A06：已由 MCP 桥接执行的工具（结果经 MCP 协议回交引擎）。
   * 桌面把 ixaeon MCP 服务注册给 Hermes 后，这些工具的 tool.start
   * 通知不再本地执行，防同一动作双执行。
   */
  private mcpBridgedTools: string[] = [];
  /** R1：本机语义索引；为 null 时预注入记忆按关键词选取（并如实说明）。 */
  private readonly semantic: SemanticIndex | null;
  /**
   * 记忆桥（三周任务单 F1）是否已接上：Hermes 配置里真的注册并启用了 ixaeon MCP 服务。
   * 没接上时 Hermes 手里没有 record_observation，不能让模型去调一个不存在的工具。
   */
  private readonly memoryBridge: boolean;

  constructor(
    private readonly db: CoreDatabase,
    private readonly adapter: HermesRuntimeAdapter,
    private readonly broker: CoreToolBroker,
    private readonly provider: ModelProvider | null,
    opts: {
      mcpBridgedTools?: string[];
      semantic?: SemanticIndex | null;
      memoryBridge?: boolean;
    } = {},
  ) {
    if (opts.mcpBridgedTools) this.mcpBridgedTools = opts.mcpBridgedTools;
    this.semantic = opts.semantic ?? null;
    this.memoryBridge = opts.memoryBridge ?? false;
  }

  /** A06：声明哪些工具已由 MCP 桥接执行（桌面启动时按实际注册情况设置）。 */
  setMcpBridgedTools(tools: string[]): void {
    this.mcpBridgedTools = tools;
  }

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

  /** D02（审核 2026-09-14）：权限或披露变更时使长驻引擎上下文失效。 */
  invalidateContext(contextRef?: string): void {
    this.adapter.invalidateContext(contextRef);
  }

  /** 本实例当前持有的引擎会话 id（进程内有效；供 D4 落库显示）。 */
  getEngineSessionId(): string | null {
    return this.hermesSessionId;
  }

  async run(input: {
    goal: string;
    projectId: string | null;
    runId?: string;
    /**
     * D3：本对话此前已完成的轮次（时间正序）。由调用方从 ConversationStore
     * 取，AgentSession 不自己查库——它不该知道对话表的存在。
     */
    priorTurns?: PriorTurn[];
    /** S1：Hermes 回答正文分段（payload.delta）；思考过程不转。 */
    onDelta?: (text: string) => void;
    /** P2：思考/开始吐字；每阶段每轮最多一次，只进不退。 */
    onProgress?: (phase: 'thinking' | 'answering') => void;
  }): Promise<AgentSessionResult> {
    const goal = input.goal.trim();
    if (!goal) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '问题不能为空');
    const runId = input.runId ?? randomUUID();
    const now = new Date().toISOString();
    const caps = this.adapter.probe();
    const priorTurns = input.priorTurns ?? [];
    let progressPhase: 'thinking' | 'answering' | null = null;
    const reportProgress = (phase: 'thinking' | 'answering'): void => {
      if (progressPhase === 'answering') return;
      if (phase === 'thinking' && progressPhase === 'thinking') return;
      progressPhase = phase;
      try {
        input.onProgress?.(phase);
      } catch {
        /* 进度回调出错不能打断回合 */
      }
    };

    /** Hermes 进程/会话没起来时的原因（带进 Core 兜底的说明里，不再被覆盖掉）。 */
    let hermesStartupFailure: string | null = null;
    if (caps.locator.found) {
      // A06：账本先插 running 行——引擎回合期间的每个事件实时落库，
      // 断电/崩溃前的实际动作留在 runtime_runs 里，不再「结束后才插」。
      this.insertRun(
        runId,
        goal,
        input.projectId,
        'hermes',
        'running',
        [],
        'Hermes 回合进行中',
        now,
      );
      this.wireEventLedger(runId, input.onDelta, reportProgress);
      try {
        // A07（审核 2026-09-13）：生产与评测共用 ContextSelector 服务——
        // 针对问句在模型获准边界内精选最相关记忆注入引擎，取代粗粒度字段拼装。
        let contextBlock = '';
        let retrievalNotice: string | null = null;
        let memoryUsed: MemoryUsedItem[] = [];
        try {
          // R1：本机语义 + 关键词混合选材；语义不可用时内部退回关键词并给出说明。
          const selector = new ContextSelector(this.db);
          const selection = await selector.selectForQuestionHybrid(goal, input.projectId, {
            audience: 'model',
            maxItems: 8,
            semantic: this.semantic,
          });
          contextBlock = selection.promptBlock;
          retrievalNotice = selection.retrievalNotice;
          memoryUsed = selection.items.map((i) => ({
            id: i.id,
            statement: i.statement,
            tag: memoryOriginTag(i),
          }));
        } catch {
          /* 选材降级，不编造 */
        }
        if (input.projectId && !contextBlock) {
          try {
            const ctx = await this.broker.invoke(
              'get_project_context',
              { projectId: input.projectId },
              {
                audience: 'model',
                runId,
                projectId: input.projectId,
              },
            );
            contextBlock = `\n\n（IXAEON 项目上下文：${JSON.stringify(ctx).slice(0, 1500)}）`;
          } catch {
            /* 上下文取不到时照常派发，不编造 */
          }
        }
        // D3 / G01：补不补历史只看底层会话是不是新的，不再以自己手里的
        // hermesSessionId 为准——披露版本一变（收回一条记忆的可见性），
        // 适配器会丢掉长驻会话新开一个，这里的 hermesSessionId 还没跟着变，
        // 按旧算法就不补了：聊着聊着会话被换掉，前几轮的话跟着丢。
        // willReuseSession 与 start() 同一套规则（同 contextRef 有活着的长驻会话、
        // 启动参数与披露版本都没变）：会复用 → 不补；会新开 → 补。
        // 整合方复审时补：还要这个对话自己已经在那个会话里聊过（hermesSessionId 有值）。
        // 预热好的会话接给一个旧对话时，适配器里有活着的长驻会话、版本也没变，但那个
        // 会话是空的，没见过这个对话的前几轮——只看复用不补，重开旧对话就丢了历史。
        const permissionVersion = getDisclosureEpoch(this.db);
        const alreadyInSession =
          this.hermesSessionId !== null &&
          this.adapter.willReuseSession(input.projectId ?? 'personal', permissionVersion);
        const priorBlock = alreadyInSession ? '' : formatPriorTurns(priorTurns);
        // 记忆路由约定（2026-09-13 用户实测发现：模型默认用 Hermes 自带 memory
        // 工具，用户日程落进 Hermes 记忆库而不是 IXAEON Core——违背「Hermes
        // 可替换、Core 资料独立保存」）。派发目标附带本约定，引导写入 Core；
        // 运行记录仍保存用户原始问题。
        // 只在记忆桥接上时附带：聊天工具集钉定为 web,ixaeon（HERMES_TUI_TOOLSETS），
        // ixaeon 未注册时被 Hermes 丢弃，自带 memory 也不在钉定范围内——此时这句话
        // 只会让模型每一轮都去找一个不存在的工具。
        // Hermes 把 MCP 工具注册为 mcp__<服务名>__<工具名>，约定里必须写模型真正看得到的名字。
        const tool = (name: string) => `mcp__${HERMES_BRIDGE_SERVER}__${name}`;
        const memoryRoute = this.memoryBridge
          ? `\n\n（IXAEON 约定：需要了解用户的情况、之前说过或做过的事时，调用 ${tool('search_memory')} 查 IXAEON 记忆；` +
            `用户告诉你需要记住的事，调用 ${tool('record_observation')} 写入 IXAEON 记忆。）`
          : '';
        // P3：对话选了项目时带上「项目近况」（提交/会话/任务，现查现拼），
        // 接在记忆那段后面；拼不出来不挡回答。
        let projectBrief: ProjectBriefCounts | undefined;
        let briefBlock = '';
        if (input.projectId) {
          try {
            const brief = buildProjectBrief(this.db, input.projectId);
            if (brief.block) {
              briefBlock = `\n\n（IXAEON 项目近况，系统现查实时拼出，回答「做到哪了/接下来做什么」时参考）\n${brief.block}`;
              projectBrief = brief.counts;
            }
          } catch {
            /* 近况拼不出来照常派发 */
          }
        }
        const dispatchedGoal = `${goal}${contextBlock}${briefBlock}${priorBlock}${memoryRoute}\n\n${SUGGESTED_TODOS_INSTRUCTION}`;
        const hermes = await this.adapter.start(
          {
            runId,
            goal: dispatchedGoal,
            contextRef: input.projectId ?? 'personal',
            allowedTools: [...CORE_TOOL_NAMES],
            permissionVersion,
            budget: { maxToolCalls: MAX_ROUNDS, timeoutMs: 120_000 },
            idempotencyKey: runId,
          },
          // A06：同实例复用引擎会话（「那我刚才说的呢」靠同会话背景）
          this.hermesSessionId,
          // A06：MCP 桥接工具防双执行
          this.mcpBridgedTools,
        );
        if (hermes.sessionId) this.hermesSessionId = hermes.sessionId;
        // Hermes 的失败事件比 prompt.submit 的应答先到时，会以「正常返回、状态失败」的
        // 形式回来。与抛错那条路一样处理：带着原因如实报错，不给一句笼统的「会话失败」。
        if (hermes.status === 'failed') {
          const reason = hermes.failureReason ?? 'Hermes 回合失败（没有给出原因）';
          const err = new Error(reason) as Error & { hermesStage: string };
          err.hermesStage = 'turn';
          throw err;
        }
        const steps: AgentStep[] = hermes.events.map((ev, i) => ({
          round: i + 1,
          tool: ev.kind,
          ok: ev.kind !== 'failed',
          detail: JSON.stringify(ev.payload).slice(0, 400),
        }));
        // failed 已在上面按报错处理，走到这里只有正常结束与用户取消两种
        const status = hermes.status === 'cancelled' ? 'cancelled' : 'succeeded';
        const engineNotice =
          hermes.status === 'cancelled'
            ? '用户取消 Hermes 会话'
            : '本轮经 Hermes TUI gateway（stdio JSON-RPC）。不是单轮检索。';
        // 记忆是怎么选出来的也要说清：语义检索没开或连不上时，用户要知道
        // 这一轮的预注入记忆只是关键词匹配。
        const notice = retrievalNotice ? `${engineNotice} ${retrievalNotice}` : engineNotice;
        this.finish(runId, goal, input.projectId, 'hermes', status, steps, notice, now);
        this.unwireEventLedger();
        return {
          ...this.asAsk(hermes.answer || notice, notice, hermes.modelName ?? 'hermes'),
          engine: 'hermes',
          runId,
          steps,
          memoryUsed,
          projectBrief,
        };
      } catch (err) {
        // A06：失败也落账本（原始 Hermes 错误如实保留，不吞成静默降级）。
        const detail = err instanceof Error ? err.message : String(err);
        this.finish(
          runId,
          goal,
          input.projectId,
          'hermes',
          'failed',
          [],
          `Hermes 回合异常：${detail.slice(0, 300)}`,
          now,
        );
        this.unwireEventLedger();
        // 回合已经交给 Hermes 之后才失败（模型限流、超时、模型报错）：如实报错，不再换
        // Core 整轮重跑。2026-09-18 真机：后台分析占满网关并发，Hermes 撞 429 重试到超时，
        // Core 兜底用同一个网关账号又撞 429，两遍加起来等了 5 分钟才报错。
        // 只有 Hermes 进程/会话根本没起来时，才值得换 Core 兜底。
        if ((err as { hermesStage?: string }).hermesStage === 'turn') {
          throw new IxaError(
            ErrorCodes.MODEL_CALL_FAILED,
            `这一轮没答完：${explainModelFailure(detail)}`,
          );
        }
        hermesStartupFailure = detail;
        /* 可执行文件在、会话未通：落到 Core 循环，不假装 Hermes 已完成。 */
      }
    }

    if (!this.provider) {
      const notice = caps.locator.found
        ? 'Hermes 会话探针未通过，且模型未配置，不能假装 Agent 已接通。'
        : `Hermes 未安装：${caps.locator.reason} 模型也未配置，问答无法进入工具循环。`;
      // A06：同 run 可能已有 hermes 预插行（先失败、又无模型兜底）——
      // upsert 收尾为 blocked，不二次 INSERT。
      const row = this.db
        .prepare('SELECT id, events_json FROM runtime_runs WHERE id = ?')
        .get(runId) as { id: string; events_json: string } | undefined;
      if (row) {
        this.db
          .prepare(
            `UPDATE runtime_runs SET status = 'blocked', notice = ?, finished_at = ? WHERE id = ?`,
          )
          .run(notice, new Date().toISOString(), runId);
      } else {
        this.insertRun(runId, goal, input.projectId, 'missing', 'blocked', [], notice, now);
      }
      throw new IxaError(ErrorCodes.MODEL_NOT_CONFIGURED, notice);
    }

    const engine: AgentSessionResult['engine'] = 'core-bounded';
    const notice = caps.locator.found
      ? `Hermes 这一轮没能启动，本轮走 Core 有界循环，不是完整 Hermes。${hermesStartupFailure ? `（原因：${hermesStartupFailure.slice(0, 160)}）` : ''}`
      : `Hermes 未安装，本轮走 Core 有界工具循环（不是 Hermes）。${caps.locator.reason}`;
    const steps: AgentStep[] = [];
    // D3：Core 兜底循环没有任何引擎侧记忆，历史轮次每次都要注入，
    // 否则「那我刚才说的呢」在没装 Hermes 时永远答不上来。
    let transcript = `用户问题：${goal}${formatPriorTurns(priorTurns)}\n项目：${input.projectId ?? '个人视角'}\n${notice}`;
    reportProgress('thinking');
    // A06：hermes 失败落 Core 循环 = 同一 run 的第二次尝试——已预插的
    // running 行 upsert 复用（保留 hermes 失败痕迹于 notice/events），不二次 INSERT。
    const existing = this.db
      .prepare('SELECT id, events_json FROM runtime_runs WHERE id = ?')
      .get(runId) as { id: string; events_json: string } | undefined;
    if (existing) {
      const priorSteps = JSON.parse(existing.events_json) as AgentStep[];
      this.db
        .prepare(
          `UPDATE runtime_runs SET engine = ?, status = 'running', events_json = ?, notice = ? WHERE id = ?`,
        )
        .run(engine, JSON.stringify(priorSteps), notice, runId);
      steps.push(...priorSteps);
    } else {
      this.insertRun(runId, goal, input.projectId, engine, 'running', steps, notice, now);
    }

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
          ...this.asAsk(
            `模型动作失败：${explainModelFailure(detail)}`,
            notice,
            this.provider.modelName,
          ),
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

  /**
   * A06：运行事件实时落账本（事件到达即写库，断电前的动作留在
   * runtime_runs.events_json）。失败不中断回合（网关侧兜底记录）。
   */
  private wireEventLedger(
    runId: string,
    onDelta?: (text: string) => void,
    onProgress?: (phase: 'thinking' | 'answering') => void,
  ): void {
    this.adapter.setEventSink((event) => {
      if (event.kind === 'text' && typeof event.payload.delta === 'string') {
        try {
          onDelta?.(event.payload.delta);
        } catch {
          /* 调用方处理分段出错不能打断 Hermes 的事件流与账本 */
        }
        try {
          onProgress?.('answering');
        } catch {
          /* 进度回调出错不能打断回合 */
        }
      }
      const thinking =
        event.payload.phase === 'message.start' ||
        event.payload.unhandled === 'thinking.delta' ||
        event.payload.unhandled === 'reasoning.delta' ||
        event.payload.unhandled === 'reasoning.available';
      if (thinking) {
        try {
          onProgress?.('thinking');
        } catch {
          /* 进度回调出错不能打断回合 */
        }
      }
      try {
        const row = this.db
          .prepare('SELECT events_json FROM runtime_runs WHERE id = ?')
          .get(runId) as { events_json: string } | undefined;
        if (!row) return;
        const steps = JSON.parse(row.events_json) as AgentStep[];
        steps.push({
          round: event.seq,
          tool: event.kind,
          ok: event.kind !== 'failed',
          detail: JSON.stringify(event.payload).slice(0, 400),
        });
        this.db
          .prepare('UPDATE runtime_runs SET events_json = ? WHERE id = ?')
          .run(JSON.stringify(steps), runId);
      } catch {
        /* 账本写失败不中断引擎回合；网关侧已记录 ledgerWriteError */
      }
    });
  }

  /** A06：回合结束后解除观察器（下次 run 重新接）。 */
  private unwireEventLedger(): void {
    this.adapter.setEventSink(null);
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

  /**
   * A06：启动孤儿回收——上一进程遗留的 running 行没有执行者，
   * 按崩解标 failed（不冒充仍在运行）。由桌面启动阶段调用一次。
   */
  static recoverOrphanedRuns(db: CoreDatabase): number {
    const rows = db
      .prepare("SELECT id, notice FROM runtime_runs WHERE status = 'running'")
      .all() as Array<{ id: string; notice: string | null }>;
    let recovered = 0;
    for (const row of rows) {
      db.prepare(
        `UPDATE runtime_runs SET status = 'failed', notice = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).run(
        `上一进程中断（${(row.notice ?? '').slice(0, 120)}）；孤儿运行按崩解收尾，不冒充完成`,
        new Date().toISOString(),
        row.id,
      );
      recovered += 1;
    }
    return recovered;
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
