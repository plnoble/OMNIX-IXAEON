# ixaeon Gap Analysis（对外部能力 vs 我们现状）

> 任务书 §27 强制产物。**在本文完成前不许提实现计划。** 所有 ixaeon 侧结论都带 `文件:行`。
> 外部侧证据见 `../deepinfer/capability-map.md`、`../recipe/architecture.md`。

## 0. 我们现在的真实状况（FACT，逐个核过）

### 0.1 模型调用层：只有一个 32 行的抽象

`packages/core/src/extraction/model/provider.ts:7-21`：

```ts
export interface ModelProvider {
  readonly modelName: string;
  chatStructured<T>(input: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
  chatText(input: { system: string; user: string }): Promise<string>;
}
```

**FACT**：只有 **2 个方法**；输入只有 `system: string` + `user: string`；
**没有**消息数组、没有多轮结构、没有 tool 定义/调用/结果、没有 reasoning 状态、没有 seed、没有流式。

实现只有两个：

- `extraction/model/openai.ts:11` `OpenAIResponsesProvider`（21.4KB）
- `extraction/model/fake.ts:10` `FakeProvider`

**FACT**：`git grep "interface ModelProvider|type ModelProvider"` 在 `packages/contracts/src` 无命中 ——
这个「统一接口」住在 **extraction 目录下**，不是全局契约。

### 0.2 「Canonical IR」不存在

**FACT**：`git grep "CanonicalConversation|canonical"` 在 `packages/core/src` **零命中**。

### 0.3 对话结构：只有「聊天消息对」，没有工具轮次

`messages` 表（`db/migrations.ts:73` 附近区）角色是 user/assistant + citations/meta；
`ConversationStore.appendMessage`（`storage/conversationStore.ts:219`）接受 role/content/runId/engine/modelName/citations/meta。

**FACT**：没有 tool_calls / tool_results / reasoning_content 的持久化列。

### 0.4 结构化输出：我们有，但形态不同

- 我们的做法：**zod schema 传入 + 实现内 safeParse 校验 + 失败抛 ModelError（可重试）**
  （`provider.ts:13-18` 注释：「实现负责校验（zod safeParse）；校验失败抛 ModelError」）。
- 外部做法（DeepInfer）：**解码期用 grammar 强制**（xgrammar），根本不可能产出非法结构。

**判定（2026-10-26 二次核实后修正）**：`OpenAIResponsesProvider` **已经在用 `json_schema strict: true`**
（`extraction/model/openai.ts:134-143`：`body.text.format = { type: 'json_schema', name, strict: true, schema }`），
即**已走第二强档**，不是「始终最弱档」。zod 仍是 provider 无关的契约层，这点比外部更通用。
**真正缺的是**：(a) **没有能力声明**去判断某 provider 支不支持 native schema（现在是硬编码在这个实现里）；
(b) 没有进一步的降级链（native schema → tool call → 校验修复）。→ G8 降级为「**P2、小改进**」，不是 P0。

### 0.5 工具调用

**FACT**：`packages/core/src` 里没有 tool calling 的统一抽象；`apps/mcp` 是 MCP server 侧（对外暴露工具），
不是「模型调用工具的协议适配」。

### 0.6 确定性 / 可复现

**FACT**：没有 seed 参数（`provider.ts` 无 seed 字段）；`chatStructured` 内部「默认重试一次」
→ **同一输入重试后可能得到不同结果，且我们无法区分「模型不稳」与「输入变了」**。

### 0.7 缓存

**FACT**：存在的是**结果缓存类**东西（`memory/semanticIndex.ts` 语义索引、研究 `last_fingerprint` 去重），
**没有**统一的「可复用计算缓存」抽象（key/fingerprint/TTL/invalidate）。

### 0.8 能力描述

**FACT**：`ModelProvider` 只有 `modelName: string`；没有任何能力声明（是否支持 JSON schema / tool / vision / seed / 上下文长度）。

---

## 1. ixaeon 已经有什么（对应任务书 §27-1）

| 能力             | 现状                                      | 证据                                |
| ---------------- | ----------------------------------------- | ----------------------------------- |
| 模型调用抽象     | ✅ 有，但极薄（2 方法）                   | `extraction/model/provider.ts:7-21` |
| 结构化输出       | ✅ 有（zod + 校验重试），provider 无关    | 同上 :13-18                         |
| 结构化失败处理   | ✅ 有（ModelError + retriable）           | `provider.ts:24-31`                 |
| 多 provider 实现 | ⚠️ 仅 2 个（openai / fake）               | `extraction/model/{openai,fake}.ts` |
| 协议适配层       | ❌ 无（OpenAI Responses 直接实现，无 IR） | 无 `CanonicalConversation`          |
| 工具调用 IR      | ❌ 无                                     | —                                   |
| reasoning 状态   | ❌ 无（踩过报错）                         | 任务书 §9 所述                      |
| 种子/确定性      | ❌ 无                                     | `provider.ts` 无 seed               |
| 统一缓存抽象     | ❌ 无                                     | —                                   |
| 能力声明         | ❌ 无                                     | `provider.ts:8` 仅 modelName        |
| 后台任务队列     | ✅ 有（JobQueue + 退避）                  | `jobs/jobQueue.ts:39`               |
| 审计             | ✅ 有                                     | `audit.ts:6`                        |
| 记忆/检索        | ✅ 有（items + hybrid）                   | `memory/semanticIndex.ts` 等        |

## 2. DeepSeek 有什么（对应 §27-2，摘要）

引擎层：两阶段调度、异步调度、batch-invariant、确定性采样、受约束解码（grammar）、DSpark、EP/EPLB、SWA bounded replay。
协议层：**Conversation IR + 每协议独立 convert**、`ET_` 标记区分「无推理/漏传」、模型版本化 encoding、协议各自流式实现。

## 3. 两者重复什么（§27-3）

| 能力        | 我们已有等价物                       | 说明                                                       |
| ----------- | ------------------------------------ | ---------------------------------------------------------- |
| 结构化输出  | ✅ zod + 校验                        | **不重复实现**；我们缺的是「约束强度分层」，不是「有没有」 |
| 采样参数    | ⚠️ 部分（温度等散在调用处）          | 缺显式 seed                                                |
| 审计/可观测 | ✅ recordAudit                       | 思路一致                                                   |
| 重试        | ✅ ModelError.retriable + 实现内重试 | —                                                          |

**结论**：结构化输出、审计、重试 **都不该重做**。

## 4. ixaeon 缺什么（§27-4，真正的 gap）

| #   | Gap                                   | 影响                                           | 外部参考                                         |
| --- | ------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| G1  | **没有协议无关的会话 IR**             | 换 provider 要改业务代码；无法支持工具轮次     | recipe `Conversation`/`InputMessage`             |
| G2  | **reasoning 状态无表达**              | 已踩过 `reasoning_content must be passed back` | recipe `ET_` + `reasoning_content.rs`            |
| G3  | **没有 seed / 可复现记录**            | 回归、benchmark、replay 不可信                 | DeepInfer deterministic sampling                 |
| G4  | **没有能力声明**                      | 只能 `if modelName == ...`                     | recipe 版本化 encoding；DeepInfer 硬件/模型假设  |
| G5  | **没有统一缓存抽象**                  | 每处各写一套缓存与失效                         | DeepInfer KV/状态缓存思想；xgrammar 缓存上限教训 |
| G6  | **没有「便宜草稿 + 强模型验证」模式** | 成本高、质量无分层                             | DeepInfer DSpark                                 |
| G7  | **工具调用无 IR**                     | 未来接 tool calling 会散落                     | recipe `Tool`/`ToolCall`                         |
| G8  | **结构化输出无能力分层**              | 有原生 schema 的 provider 也走「生成后校验」   | DeepInfer grammar 强制                           |

## 5. 哪些值得补（§27-5）—— 按「问题是否真实存在于我们」判

**值得补（问题真实存在）**：

- **G2 reasoning 状态** → 我们**真的**踩过，真实痛点，优先级最高；
- **G4 能力声明** → 现在 `modelName` 一个字符串承载所有判断，必然长出 `if model ==`；
- **G3 seed/可复现** → D5a/D5b 验收、benchmark 都需要「同输入同输出」；
- **G1 会话 IR** → 是 G2/G7 的**前置**（没有消息结构，reasoning/tool 无处安放）；
- **G8 结构化分层** → **降级为 P2**：`json_schema strict` 已在用（`openai.ts:134-143`），只剩「按能力选档 + 降级链」；
- **G6 草稿+验证** → 成本问题真实，但**依赖先有 G1/G4**。

**可延后**：

- **G5 统一缓存** → 有价值，但**当前没有多处重复实现**，属于「先设计不实现」；
- **G7 工具调用 IR** → 我们**还没有**模型侧工具调用需求（MCP 是反方向），先只有 IR 位置预留。

## 6. 哪些只是实现方式不同（§27-6）

- **batch-invariant / 异步调度 / EP/EPLB / SWA replay / KV 管理**：这些是**推理引擎内部**为 GPU 集群做的，
  我们没有推理引擎，**问题形态完全不同** → 只取思想（确定性、重叠、成本意识），**不做实现**。
- **tokenizer 版本化**：我们不直接持 token（走 provider API）→ 只需「能力按版本声明」，不需 tokenizer。

## 7. 哪些会造成过度设计（§27-7，自我约束）

- ❌ 现在就去实现「统一缓存层」（没有第二处用法，是为未来设计）；
- ❌ 现在就去实现「Workload Router」（模型就那么几个）；
- ❌ 现在就去实现「Speculative Execution」（没有强弱模型分层预算）；
- ❌ 照搬 recipe 的全部 IR 字段（`prefix`、`LatestReminder`、multimodal token spec 我们都不需要）；
- ❌ 为了 IR 而重写现有 `ModelProvider` 的全部调用方（20+ 处），**应增量**。

## 8. 结论（进 Adoption Matrix 的输入）

**真正值得做的只有 4 件**，且都能小步落地：

1. **会话 IR 的最小版**（消息数组 + 角色 + tool 位 + reasoning 位）——为 G2/G7 立地基；
2. **reasoning 状态四态**（有/无标记/缺失/非思考轮）——直接消除已踩的坑；
3. **能力声明**（provider 声明支持什么）——替代 `if model ==`；
4. **seed + 记录**——让验收可复现。

其余（缓存统一、草稿验证、路由）→ **写 RFC，不现在做**。
