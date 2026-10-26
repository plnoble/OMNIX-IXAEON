# DeepSeek → ixaeon Top 10 Lessons

> 任务书 §25。每条必须：**Lesson / Why / Evidence / ixaeon Impact / Action**。
> 禁止「它用异步调度所以我们也该用」这种话。每条都要指出**我们哪个具体能力会被改变**。

---

## 1. 推理内容的状态必须显式建模，不能靠「有没有传」

- **Lesson**：`reasoning_content` 有三种合法状态（这轮确实没推理 / 有推理回传 / 非思考模式不适用），
  仅凭「字段有没有值」无法区分，必须**带内标记**。
- **Why**：缺失值与合法空值的语义不同。把两者混为一谈，就会出现「模型没产生推理」被误判成「客户端漏传」而拒绝请求。
- **Evidence**：`deepseek-recipe@935817c66f5d:deepseek-recipe/src/protocol/reasoning_content.rs:1-70`
  （三条件才拒绝：最后一条 user 之后 + 有 tools + 无空思考标记）；
  `tool_call_id.rs:1-40`（`ET_` 标记让后续请求能区分）。
- **ixaeon Impact**：直接命中我们**真实踩过**的 `reasoning_content must be passed back` 报错。
  我们 `provider.ts` 连消息结构都没有，更谈不上状态。
- **Action**：在会话 IR 里给 assistant 消息加 `reasoning` 三/四态（`absent_but_legal` / `present` / `not_applicable`），
  并在 adapter 层按 provider 规则决定「回传 / 补空 / 丢弃」——**不要求每个 provider 都支持**。

---

## 2. API 协议不该直接进模型后端：中间必须有一层 IR

- **Lesson**：三个对外协议（OpenAI Chat / OpenAI Responses / Anthropic）各自有 `convert.rs`，
  核心 `Conversation`/`InputMessage` **不 import 任何协议类型**。
- **Why**：协议是**外部契约**，会变、会有怪癖（Responses 要 accumulator、V4/V4.1 排序不同）。
  若协议结构直达后端，每加一个协议就改一遍核心。
- **Evidence**：recipe `protocol/{openai/chat_completion,openai/responses,anthropic/messages}/*/convert.rs`
  vs `core/src/{conversation,messages}.rs`（`git/trees` 无交叉 import）。
- **ixaeon Impact**：我们现在 `OpenAIResponsesProvider` 21.4KB 直接实现协议，
  换 provider 要改业务调用点；`ModelProvider` 只有 `system`+`user` 两个字符串
  （`packages/core/src/extraction/model/provider.ts:7-21`）。
- **Action**：立最小 `CanonicalConversation`（消息数组 + 角色 + 可选 reasoning/tool 位），
  **provider adapter 只负责 IR ↔ 协议**。增量做，不重写 20+ 调用点。

---

## 3. 模型版本差异要有明确落点，不能在业务代码里 if

- **Lesson**：V4 与 V4.1 的渲染差异（工具结果排序、工具定义位置、reasoning effort 提示词）
  全部收敛在 `convert`/`encoding` 里，业务侧不感知。
- **Why**：版本差异是**必然**且会**持续增加**的；散落到各调用点后，每次上新模型都要全仓搜索。
- **Evidence**：`core/src/messages.rs:44-58` 注释写死 V4 与 V4.1 的排序差异；
  `encoding/src/v4/dsv4.rs` 与 `v41/dsv41.rs` 各一份。
- **ixaeon Impact**：我们 `ModelProvider` 只有一个 `modelName: string`（`provider.ts:8`），
  没有能力声明 → 未来必然长出 `if (modelName === '...')`。
- **Action**：加 `ModelCapabilities`（是否支持 native JSON schema / tool / vision / seed / context 上限），
  判断改成问能力，而不是问名字（任务书 §15）。

---

## 4. 可复现不是「调试方便」，是评测的地基

- **Lesson**：给定 token + 固定 `seq_seed` → 相同输出；且刻意让结果**与批组成无关**。
- **Why**：如果同一输入在不同并发/批组成下结果不同，那「这次比上次好」这个判断本身就是噪声。
- **Evidence**：DeepInfer README「Deterministic sampling」「Batch-invariant inference」；
  `tests/models/test_batch_invariant.py`。
- **ixaeon Impact**：我们 `chatStructured` 内部会「默认重试一次」（`provider.ts:17` 注释），
  重试后结果可能不同且**我们无法区分是模型抖还是输入变**。
- **Action**：请求里带 `seed`（provider 支持则传，不支持则记录「不可复现」），
  并**记录每次调用的 seed + 模型版本**，让回归可对照。

---

## 5. 受约束生成：能强制就别只校验

- **Lesson**：结构化输出有强度层次：**grammar 强制（不可能产出非法）** > 原生 JSON schema > tool call > 生成后校验修复。
- **Why**：校验是**事后**，失败就要重试，重试就花钱花时间；强制是**事前**，成本为零。
- **Evidence**：DeepInfer `deepinfer/structure_output/{compiler,mask,matcher}.py`（基于 xgrammar，
  支持 regex / JSON schema / EBNF），README「constrain generation to a regex, JSON schema, or EBNF grammar」。
- **ixaeon Impact**：我们**已有** zod 校验 + 失败重试（`provider.ts:13-18`），但**始终走最弱的一档**——
  即使 provider 支持原生 JSON schema 也没用上。
- **Action**：结构化调用按能力声明选最强可用手段（native schema → tool → 校验修复），
  **不重做**既有 zod 契约（那个设计是对的）。

---

## 6. 任何「按 schema 缓存」都必须有上限和 kill switch

- **Lesson**：编译器缓存（schema → 编译产物）会随**不同 schema 数量无界增长**。
- **Why**：用户/模型能构造无限多 schema，缓存就成了 OOM/DoS 通道。
- **Evidence**：DeepInfer `structure_output/compiler.py:15-33` 原文
  「the cache grows unboundedly with distinct schemas and may cause OOM (DoS vector, see CVE-2025-32381)」，
  并提供 `DEEPINFER_XGRAMMAR_DISABLE_CACHE` kill switch，还记录「xgrammar ≤0.1.x 开缓存出过生产事故」。
- **ixaeon Impact**：我们目前**没有**这类缓存（是好事），但一旦加「schema 编译缓存」「prompt 模板缓存」
  就会重演同一个坑。
- **Action**：立规矩——**所有按内容增长的缓存必须有字节上限 + 关闭开关 + 超限降级**，
  并在代码注释里写清「为什么」。

---

## 7. 成本应该在调度时估算并留痕，事后才能验证估算准不准

- **Lesson**：调度时就把 `attn_tflops`/`total_tflops` 记为「immutable scheduling-time estimate」，
  事后可与实际对比。
- **Why**：不记录估算，就永远不知道估算偏差；没有偏差数据，任何「智能调度」都是拍脑袋。
- **Evidence**：`csrc/engine/scheduler.hpp:61-62`（`double attn_tflops; double total_tflops; // immutable scheduling-time MFU estimate`）、
  `engine/stats_logger.py`、`flops_estimator.hpp`。
- **ixaeon Impact**：我们**没有任何**调用成本预估记录；`ModelPool` 当年的问题正是「字段齐全、值是编的」。
- **Action**：每次模型调用记录「预估 token/成本」与「实际用量」两列，先只记录不用于决策，
  攒够数据再谈路由。

---

## 8. 便宜草稿 + 昂贵验证 是可迁移的通用模式（但只到架构层）

- **Lesson**：用低成本 draft 产出候选，再用高能力单位**只做验证/纠错**，而不是全量重做。
- **Why**：绝大多数工作不需要最强模型从零做；验证比生成便宜得多。
- **Evidence**：DeepInfer DSpark「accelerate decoding with draft tokens and use confidence estimates to schedule verification」
  （`models/mtp/dflash.py`、`mtp_varlen.hpp`、`DEEPINFER_USE_NEXTN_DECODE` 默认草稿 5）。
- **ixaeon Impact**：我们现在每个任务都用同一档模型；没有「草稿-验证」分层。
- **Action**：**只写 RFC**（任务书 §13），且**明确区分**：token 级推测解码 ≠ agent 级草稿验证。
  真做需要先有能力声明（Lesson 3）与成本记录（Lesson 7）。

---

## 9. 重/轻工作应当分级，不要让长任务拖死短任务

- **Lesson**：Prefill（重、长）与 Decode（轻、逐 token）分开调度，各有预算与批组成规则。
- **Why**：混排会让短任务排在长任务后面，尾延迟爆炸（fairness/starvation 问题）。
- **Evidence**：`csrc/engine/scheduler.hpp:36-47`（`EngineType NORMAL|PROMPT|COMPLETION`、`SchedulerOutputs.prompt_run`）。
- **ixaeon Impact**：JobQueue 有 kind 去重与「给聊天让路」（`jobQueue.ts:204`），
  但**没有**「重任务/轻任务」分级——整仓分析这类长任务会占住后台。
- **Action**：REFERENCE 级借鉴：给 job 标 `heavy|light`，heavy 限并发、light 优先，
  复用现有 kind 去重机制，不新造调度器。

---

## 10. 明确声明「本版不含什么」，比宣称能力更重要

- **Lesson**：README 主动写明「KV cache system / VE-Prefill-Decode 分离部署 / DP 副本负载均衡 **不在本版**」。
- **Why**：不写清边界，使用者会按「官方框架」的预期去用，然后在生产上撞墙；
  写明边界也让「哪些是依赖、哪些是本体」一目了然（`vendor/` 六个 submodule）。
- **Evidence**：DeepInfer README「Required for a complete inference service (not included in this release)」三项。
- **ixaeon Impact**：我们的交付说明里常有「已实现 / 自动化通过 / 真机通过 / 用户接受」四段分离——
  方向对，但**能力边界**常靠读者自己推断。
- **Action**：每份设计/交付文档显式写「本版**不含**什么」，
  并像 `vendor/` 那样把「依赖」与「本体」分开列。
