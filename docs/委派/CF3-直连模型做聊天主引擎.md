# 规格 CF3：聊天改用直连模型做主引擎（CF3 / CF3b）

档位：**B**。要改发给模型的提示词，要把联网搜索和查记忆作为工具交给模型，还要改变「什么进记忆、给模型看什么」的口径。大小：拆两支。
- **CF3**：`packages/core` 里的流式客户端和引擎循环，不接线，约 250 行源码；
- **CF3b**：接进聊天，约 200 行。

依赖：无。迁移 42（`runtime_runs.engine` 允许 `direct`）已经由整合方写好，在 main 上。

来源：用户 2026-11-03 定的（[三周任务单](../三周任务单.md)「产品分工与聊天方向」一节）。原话：「聊天最重要的还是模型要够聪明」；「如果我的问题，它回答的不够精准，那就会失去我的信任」。

结论：聊天改走**直连模型**（OpenAI 兼容，经 magpie），Hermes 只用来干活，去掉 Core 有界循环保底。这一单替掉队列第 151 行原来写的「第二个引擎、能切换」。去掉保底是后面的 **CF3c**（队列第 162 行），不在这一单里。

B 档的流程：**先只推测试**，状态改「测试待审（整合方）」，等整合方在 main 上锁定之后再写实现。

## 为什么

- 现在聊天经 Hermes 转一手：新会话要组装 5–9 秒；模型能用哪些工具由 Hermes 决定；「查记忆」要另开记忆桥（本机关着）。
- Hermes 起不来时会悄悄换成 Core 有界循环。本机两次用到都失败了，界面上也不显眼。
- 直连模型：你选哪个模型就是哪个，流式回答，工具由 IXAEON 自己给。模型觉得需要，就自己去查记忆、上网搜。

## 要什么

### CF3（core，不接线）

1. **流式客户端** `packages/core/src/runtime/chatStream.ts`：
   - 走 OpenAI 兼容的 `POST {baseUrl}/chat/completions`，带 `stream: true`、`messages`、`tools`（function calling），解析 SSE。
   - 正文分段立刻回调出去；工具调用的参数按 index 拼完整之后再交出来。
   - 能取消（`AbortSignal`），有总超时。
   - 网关明确拒绝 `tools` 字段时（400，错误里提到 tools / function / tool_choice）：**同一轮去掉 tools 重发一次**，并在结果上标 `toolsUnsupported: true`。别的 400 照常报错。
2. **引擎循环** `packages/core/src/runtime/directChat.ts`：
   - 拼 `messages`：系统提示词 → 预先挑好的记忆块和项目近况（调用方给，文本）→ 此前的轮次（user / assistant 交替）→ 这一问。
   - 模型要调工具，就执行工具，把结果作为 `role: tool` 消息塞回去，再请求一次。**最多 6 轮工具**；第 7 次请求不带 tools，要求它直接回答。
   - 每次工具调用记成一个 `AgentStep`（`tool` = 工具名，`ok`，`detail` = 截到 120 字的参数摘要，比如搜索词）。
   - 工具返回的记忆并进 `memoryUsed`，按 id 去重，和预先注入的放在一起。
3. **系统提示词** `DIRECT_CHAT_SYSTEM_PROMPT`，加版本号 `DIRECT_CHAT_PROMPT_VERSION = 'd1'`。必须包含这几条意思，写法由实现定，测试按关键短语查：
   - 你是 IXAEON（析衍），用户的个人助手；开头一句直接给答案，用简洁的中文回答；
   - 问到用户本人、过去说过做过的事、用户的项目时，**先调 `search_memory`**；预先给的记忆不够就再查；
   - 问到最新的、实时的、公开的事实，或者你没把握的事，**调 `search_web`**，需要原文时调 `read_web`；回答里写出网页来源；
   - 资料不够就直说不够，不编；搜索没配置或失败时如实说，不假装搜过；
   - 标成「AI 建议」的记忆是 AI 以前的说法，不是用户的决定；一次性的事不是长期原则；已经过去的事别当成眼下的事；
   - **不要在回答末尾附「建议待办」，也不要主动提议建任务**（用户 11-03 定；跟 CF2 一致）。
   - **不许**把 Hermes 用的那套 `SUGGESTED_TODOS_INSTRUCTION` 带进来。
4. **测试用的假客户端** `FakeStreamChatClient`：按预先写好的脚本，一轮一轮地吐正文分段或工具调用，并记下每次收到的 `messages` 和 `tools`。

### CF3b（接进聊天）

5. **什么时候走直连**：`AppRuntime.ask()` 里，`chatLaunchOptions()` 的模型、地址、Key 三样都有（也就是用户在「模型接入」里配好了聊天模型，SUB1 的 magpie 预设就是这样）→ 这一问走直连，**不启动 Hermes、不走 Core 有界循环**。
   - 三样缺一样 → 照现在的路径不变（留给 CF3c 收掉）。这样没配模型的测试和旧数据目录不会一下子全红。
   - 走直连的对话不做 Hermes 预热（P1）。
6. **给模型的工具**：只有这五个，没有别的：

   | 工具 | 做什么 | 实现 |
   |---|---|---|
   | `search_memory(query, limit?)` | 查用户的记忆 | 和记忆桥 `hermesTool('search_memory')` **同一套**（混合选材、受众 model、最多 12 条、带 `over`、AI 建议说明）。抽成一个共用的方法，不许抄第二份 |
   | `get_evidence(itemId)` | 看某条记忆的出处 | `CoreToolBroker` 受众 model |
   | `get_project_context(projectId?)` | 看项目近况 | `CoreToolBroker`；不传就用对话自己的项目 |
   | `search_web(query)` | 联网搜索 | `CoreToolBroker`：先 `sanitizePublicQuery` 脱敏，再交给已配置的搜索服务。**没配置时返回 `ok: false` 和「联网搜索没有配置：设置里填搜索服务的 Key」**，不抛错打断这一轮 |
   | `read_web(url)` | 读网页原文 | `CoreToolBroker`（照现有的网址安全检查） |

   **不给** `record_observation`、`propose_task`、`dispatch_coding_task`、`get_task_result`：普通聊天不建任务、不写记忆（CF2）。
7. **记账与存档**：
   - 消息的 `engine` 记 `direct`，`modelName` 记实际的模型名；`runtime_runs` 照现在的样子先插 running 行、结束时更新，engine 记 `direct`（迁移 42）；
   - `memoryUsed` 照现在的格式存进消息的 meta，包括工具查到的那些；
   - 问答存档（`captureAsk`）照现在的做法存、排队提炼；
   - **凡是按 `engine === 'hermes'` 判断「这条回答有注入记录、可以认回声、可以提炼 AI 建议」的地方，`direct` 同样算**（`extractor.ts` 的 `injectedMemoryByTurn`）；
   - engine 的类型并集都加上 `direct`：`AgentSessionResult`、`askStore`、`importService.captureAsk`、contracts `ipc.ts`。
8. **失败和取消**：
   - 模型出错时，说明照现在的 `explainModelFailure` 来（CF0 的「换个模型重问」照样出），已经答出的半截照现在的样子保留，状态 `failed`；
   - 用户点停止 → 中断请求，状态 `cancelled`；
   - **不退回** Hermes 或 Core 有界循环。
9. **界面**：回答下面的引擎信息显示「直连 · <模型名>」。工具步骤照现在「步骤」的展示方式列出来，至少能看出这一轮查过记忆、搜过网。

## 契约（写死，不改名、不加字段）

```ts
// packages/core/src/runtime/chatStream.ts
export interface ChatToolCall { id: string; name: string; arguments: string }
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export interface ChatToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatStreamResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  toolsUnsupported: boolean;
}
export interface StreamChatClient {
  readonly modelName: string;
  stream(input: {
    messages: ChatMessage[];
    tools?: ChatToolDef[];
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatStreamResult>;
}
export class OpenAIChatStreamClient implements StreamChatClient {
  constructor(opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number });
}
export class FakeStreamChatClient implements StreamChatClient {
  constructor(script: Array<{ deltas?: string[]; toolCalls?: ChatToolCall[]; error?: string }>, modelName?: string);
  readonly calls: Array<{ messages: ChatMessage[]; tools?: ChatToolDef[] }>;
}

// packages/core/src/runtime/directChat.ts
export const DIRECT_CHAT_PROMPT_VERSION: 'd1';
export const DIRECT_CHAT_SYSTEM_PROMPT: string;
export const DIRECT_CHAT_TOOL_NAMES: readonly ['search_memory', 'get_evidence', 'get_project_context', 'search_web', 'read_web'];
export interface DirectChatTools {
  defs: ChatToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string; memoryUsed?: MemoryUsedItem[] }>;
}
export interface DirectChatResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  answer: string;
  failure: string | null;
  steps: AgentStep[];
  memoryUsed: MemoryUsedItem[];
  toolsUnsupported: boolean;
}
export function runDirectChat(input: {
  client: StreamChatClient;
  question: string;
  priorTurns: PriorTurn[];
  contextBlock: string;          // 预先挑的记忆 + 项目近况，调用方拼好
  preMemoryUsed: MemoryUsedItem[];
  tools: DirectChatTools;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onProgress?: (phase: 'thinking' | 'answering') => void;
  maxToolRounds?: number;        // 默认 6
}): Promise<DirectChatResult>;
```

几个导出都从 `packages/core/src/index.ts` 导出。预先注入的记忆照 `AgentSession` 现在的做法挑（`selectForQuestionHybrid`，最多 8 条），项目近况照 `buildProjectBrief`；**此前的轮次照 `formatPriorTurns` 的上限**（6000 字），但要作为 messages 一条一条放进去，不再拼成一段文字。

## 约束

- 不加新的外部服务：模型走用户已经配好的网关（magpie），搜索走已有的 B3 搜索服务。不自动换模型（模型路由仍然锁着）。
- 不改 `AgentSession`、Hermes 适配器和 Core 有界循环的行为（CF3c 再动）。
- 不加迁移（42 已经有了），不改消息表。
- Key 不进日志、不进审计、不进 `runtime_runs`；错误说明照现在的做法截到 120 字。
- 测试、交付说明、截图里不出现真实网关地址、Key、模型清单、用户的真实记忆，一律用合成的。

## 验收条件

CF3（假客户端 / 假 HTTP，不联网）：

1. `OpenAIChatStreamClient` 对着一个假的 SSE 服务：正文分 3 段到 → `onDelta` 按顺序收到 3 段，`content` 是三段拼起来；请求体里有 `stream: true`、`model`、`messages`、`tools`，请求头带 `Authorization: Bearer <合成 Key>`。
2. 假服务把一个工具调用的参数分 2 段发 → 结果里 `toolCalls` 只有 1 个，`arguments` 是拼完整的 JSON。
3. 假服务对带 tools 的请求回 400（错误里有 `tools`）→ 同一次 `stream()` 里不带 tools 再发一次、拿到正文，`toolsUnsupported: true`；回 400 但错误里说的是别的（比如模型不存在）→ 不重发，照常报错。
4. 取消：`signal` 中途 abort → `stream()` 很快结束（≤1 秒），抛出的错误能被认成取消。
5. `runDirectChat` 用假客户端：第 1 轮调 `search_memory`、第 2 轮回正文 →
   - `tools.call` 收到 `search_memory` 和参数；
   - 第 2 次请求的 messages 里有那条 `role: tool` 的结果；
   - `steps` 有一条 `search_memory`；
   - `memoryUsed` 是预先注入的加上工具查到的，按 id 去重。
6. 假客户端每一轮都要调工具 → 最多执行 6 轮工具；第 7 次请求不带 `tools`；最后 `status: 'succeeded'`、有正文。
7. 第一次请求的 messages 顺序是：system（就是 `DIRECT_CHAT_SYSTEM_PROMPT`）→ 含 `contextBlock` 的那条 → 此前的轮次按原顺序、原角色 → 这一问。此前的轮次超过 6000 字时，丢的是最早的。
8. 系统提示词：含 `search_memory`、`search_web`、「资料」和「不」连用（资料不够不编）、「AI 建议」；**不含** `SUGGESTED_TODOS_INSTRUCTION` 的任何一行，不含「建议待办」四个字作为要求附加的内容。`DIRECT_CHAT_TOOL_NAMES` 正好是那五个。
9. 工具返回 `ok: false`（比如搜索没配置）→ 这一轮不中断，结果作为 tool 消息交给模型，最后 `status: 'succeeded'`。

CF3b（桌面运行时；网关用假的 OpenAI 兼容服务，`IXAEON_DATA_DIR` 指向临时目录）：

10. 「模型接入」配好聊天模型 → 一问走直连：消息 `engine = 'direct'`、`modelName` 是配的那个；**没有启动 Hermes**（用替身 locator 断言没被调用）；`runtime_runs` 有一行 engine `direct`、状态 `succeeded`。
11. 模型调 `search_memory` → 结果来自和记忆桥同一个方法（合成库里放一条个人记忆、开着「个人记忆给聊天用」→ 能查到；关掉开关、也没逐条分享 → 查不到）。
12. 模型调 `search_web`，但没配搜索服务 → 工具结果是「联网搜索没有配置…」，回答照常完成；配了替身搜索服务 → 查询先经过 `sanitizePublicQuery`（含一个合成邮箱的搜索词，发出去时已经被替换掉）。
13. 模型调 `propose_task` 或 `record_observation`（不在工具清单里的名字）→ 不执行，作为失败的工具结果交回模型，`coding_tasks`、`items` 没有多出东西。
14. 回答完成后：问答存档建好、排了提炼；消息 meta 的 `memoryUsed` 含工具查到的那条；提炼这段对话时 `injectedMemoryByTurn` 认得出这条 `direct` 回答。
15. 假网关回 503「No available channel for model demo-a」→ 消息 `failed`，说明和 CF0 一样（含「换一个模型」），**没有**再走 Hermes 或 Core 有界循环。
16. 用户中途取消 → 消息 `cancelled`，已经答出的半截还在。
17. 聊天模型没配（三样缺一样）→ 走现在的路径，原有的测试不受影响。
18. 回答下面的引擎信息显示「直连」和模型名。

## 真机检查

- **甲（开发做，合成）**：起一个假的 OpenAI 兼容网关（支持 stream 和 tools），`IXAEON_DATA_DIR=<临时目录>` 启动应用，配好聊天模型。
  - 问一句闲聊；
  - 问一句要查记忆的：合成库里事先放好一条合成记忆，假网关第一轮调 `search_memory`；
  - 问一句要联网的：用替身搜索服务；
  - 中途停一次。
  
  每一步截图：回答、引擎信息、步骤。贴进交付说明，遮掉临时目录。
- **乙（开发做，真模型、合成数据）**：新加 `scripts/real/cf3-direct-chat.ts`，经 `run-batch.mjs` 跑。
  - 临时空库，写进几条**合成**记忆；网关用本机 magpie（`127.0.0.1:3425`，Key `magpie`）、用户在「模型接入」里选的那个模型（脚本参数传）。
  - 问 5 个合成问题：闲聊、要查记忆的、要联网的（公开的近期事实）、多轮追问、本来就答不了的。
  - 打印：每问用了哪些工具、第一个字出来要几秒、总共几秒、回答的前 80 字（都是合成的，可以打印）。
  - 搜索服务没配，就照实打印「联网搜索没有配置」。该触发工具的、不该触发的都要问到。
- **丙（用户做）**：用户用自己的数据连着聊三轮，其中一问要查记忆、一问要联网。交付说明里写「待用户实测」，不能写成已通过。

## CF3c（下一单，队列第 162 行，CF3b 并入后再做）

收掉聊天里的 Hermes 路径和 Core 有界循环：
- 没配聊天模型时，明确提示去「模型接入」配，不再找 Hermes；
- 用 core-bounded 当假模型通道的 12 个测试文件，改走直连引擎的 `FakeStreamChatClient`；
- A4、A5 等锁定验收里撞红的，列清单交整合方改；
- Hermes 还用不用来「干活」、怎么用，等 IXAEON 与 DSH 分工定下来再说。

规格到时候再写，这里只记方向。
