# deepseek-recipe：协议适配与 Conversation IR（实证分析）

> `deepseek-ai/deepseek-recipe@935817c66f5d`，Rust workspace（7 crate），MIT。
> 标注：**FACT** = 源码直接读到；**INFERENCE** = 由代码推断；**HYPOTHESIS** = 待验证。

## 0. 这个项目是什么（FACT）

**不是**推理引擎，是**协议适配 + 编码层**：把对外 API（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）
的请求，转成 DeepSeek 模型侧的「会话 + 提示词 + token ids」，再把模型输出转回对外协议（含流式 chunk、工具调用、reasoning）。

crate 结构（FACT，`git/trees/main`）：

| crate                      | 职责                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `deepseek-recipe-core`     | **协议无关的核心 IR**：`conversation.rs` `messages.rs` `prompt.rs` `tools.rs` `special_tokens.rs`     |
| `deepseek-recipe`          | **协议转换**：`protocol/{openai/chat_completion, openai/responses, anthropic/messages}` 各含 `request | response/{convert,schema,chunk_generator}`；`protocol/{reasoning, reasoning_content, tool_call_id, json_schema, output_constraint, validation}` |
| `deepseek-recipe-encoding` | tokenizer + 版本化编码 `v4/dsv4.rs`、`v41/dsv41.rs`                                                   |
| `deepseek-recipe-image`    | 多模态图像抓取/解析（`fetcher/resolver/retry/limits`）                                                |
| `deepseek-recipe-macros`   | 提示词渲染宏（`prompt.rs`）、`untagged.rs`                                                            |
| `deepseek-recipe-python`   | PyO3 绑定                                                                                             |
| `server-rs` / `server-py`  | 两个协议服务示例                                                                                      |

**这是任务书 §8 所问「是否存在 Conversation IR」的直接答案：存在，且是分层的（FACT）。**

## 1. Conversation IR 的真实形态（FACT）

`deepseek-recipe-core/src/conversation.rs:9-45`：

```rust
pub struct Conversation {
    pub messages: Vec<InputMessage>,
    pub thinking_mode: bool,              // 下一轮 assistant 是否用 thinking 模式
    pub tools: Vec<ToolDefinition>,       // 按声明顺序
    pub tool_choice: ToolChoice,          // 协议归一化之后的选择
    pub reasoning_effort: Option<ReasoningEffort>,
    pub response_format: ResponseFormat,  // Text | JsonObject | JsonSchema | Regex
}
```

`deepseek-recipe-core/src/messages.rs:11-58` 的 `InputMessage` 枚举只有 5 种变体：

```
System { content: Prompt, image_sources, tools: Option<Vec<ToolDefinition>> }
User   { content: Prompt, image_sources }
Assistant { content: String, reasoning_content: Option<String>, tool_calls: Option<Vec<ToolCall>>, prefix: bool }
Tool   { content: Prompt, image_sources, tool_call_id: Option<String> }
LatestReminder { content: String }
```

**关键设计决定（FACT + INFERENCE）**：

1. **内容类型分两种**：`Prompt`（可含显式 special token 与图片占位符）vs 纯 `String`。
   FACT 注释点明原因：「Rendering inserts each grounding-token spelling found in assistant content or reasoning content
   as an explicit special token; all other text of these strings is plain text」——
   即**助手输出里出现的特殊 token 拼写要被重新识别为 token**，而不是当普通文本。这是「文本 ↔ token」边界的显式化。
2. **`prefix: bool`（FACT）**：`Assistant` 消息可标记为「继续这段前缀」而非开新轮；
   注释明确「caller 只能把它放在最后一条，Chat Completions 转换会拒绝其他位置」。这是**部分续写**能力，我们没有。
3. **`LatestReminder`（FACT）**：作为独立消息类型存在（不是塞进 System），说明「临时提醒」需要**位置**语义。
4. **协议 schema 与核心 IR 完全隔离（FACT）**：`protocol/openai/*/schema.rs` 定义协议 DTO，
   `convert.rs` 做 DTO→IR；核心 IR **不 import 任何协议类型**。三个协议各自独立 convert。
   这正是「API 格式不直接进模型后端」的**实证实现**。

**INFERENCE**：因为 IR 是「会话 + 工具 + 思考模式 + 输出格式」的封闭集合，新增一个 provider 只需写一份 convert，
不动核心——这是我们应该照抄的**分层形状**（不是照抄字段名）。

## 2. Reasoning 状态的处理（FACT，直接对应任务书 §9 的痛）

`deepseek-recipe/src/protocol/reasoning_content.rs:1-70` 给了精确规则：

- 非 thinking 模式：所有 assistant 消息的 `reasoning_content` **置 None**；
- thinking 模式：有则保留，缺则**补空字符串**；
- `ReasoningContentBehavior::Reject` 下，满足全部三个条件才拒绝：
  （a）该消息在最后一条 user 之后（或整个列表没有 user）；
  （b）该消息有 tool calls（或 `has_tools=true`）；
  （c）该消息没有任何 tool call 带「空思考标记」。

**`ET_` 标记机制（FACT，`tool_call_id.rs:1-40`）**：tool call id 形如
`call_{index:02}_{ET_?}{20位随机}{4位校验}`，其中 `ET_` 表示「这一轮没产生 reasoning content」。
目的（原文注释）：「让后续请求的转换能区分『模型这轮确实没产生推理内容』与『历史消息漏传了推理内容』」。

这个问题我们**真实踩过**（任务书 §9 引的那条 `reasoning_content must be passed back` 报错）。
recipe 的方案给出了**可操作的答案**：不是「一律要求」也不是「一律容忍」，而是**用带内标记区分两种情况**。

**INFERENCE**：这是 §9 要的 `ReasoningState` 的最佳实证参考——四态可判：
`无推理内容（合法，ET_ 标记）` / `有推理内容（回传）` / `缺失（应拒绝或补空）` / `非 thinking 轮（丢弃）`。

## 3. Tool calling 的 IR 化（FACT）

- `ToolDefinition` / `ToolChoice` 在 core（协议无关）；
- `protocol/openai/responses/request/tools.rs`、`response/custom_tool_input.rs` 做协议特有形态（含 custom tool input）；
- `messages.rs:44-58` 的 `Tool` 变体带 `tool_call_id: Option<String>`，且**注释写死了 V4 与 V4.1 的排序差异**：
  V4 按 id 排序、无 id 排最前；V4.1 按「前一条 assistant 消息的 call 顺序」排、无 id 保持原位。
- **FACT**：模型版本差异被**收敛在注释与 convert 里**，不散落到业务代码。

## 4. Tokenizer / 编码的版本化（FACT）

- `deepseek-recipe-encoding/src/v4/dsv4.rs`、`v41/dsv41.rs` —— **每个模型版本一个编码实现**；
- `static/tokenizers/{v4,v41}/tokenizer.json` 随仓发布；
- `docs/tokenizer.md` 有专门文档。

**INFERENCE**：这印证「模型版本差异要有明确落点」——我们的 `ModelCapabilities`（任务书 §15）应照这个思路：
**能力按模型版本声明，不在业务代码里 `if model == ...`**。

## 5. 流式（FACT）

`deepseek-recipe/src/stream/{decoder,inference,logprobs,output_parser,processor}`，
每个协议有独立 `response/chunk_generator.rs`、`openai/responses/response/accumulator.rs`。

**INFERENCE**：流式转换被拆成「增量解码 → 协议 chunk 生成」两段，且**Responses 协议需要 accumulator**
（因为它是「事件累加成对象」而非「逐 delta」），说明**不同协议的流式模型本身不同**，不能一个抽象硬套。

## 6. 对我们的直接启示（→ 进 `adoption/`）

| 观察（FACT）                                            | 我们的现状（待 §27 gap 分析核实）                      | 初步方向                                                         |
| ------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| 协议 DTO 与核心 IR 双向隔离，每协议独立 convert         | 我们的 provider 适配散在 `AppRuntime`/`modelPool` 附近 | **ADAPT**：立 `CanonicalConversation` + 每 provider 一个 adapter |
| `ET_` 带内标记区分「无推理」与「漏传」                  | 我们踩过 `reasoning_content` 报错                      | **ADAPT**：`ReasoningState` 四态                                 |
| `Prompt` 与 `String` 类型区分（special token 边界显式） | 我们拼字符串                                           | **REFERENCE**（我们不做 tokenizer）                              |
| 模型版本差异收敛在 encoding/convert                     | 我们 `if model == ...` 散落                            | **ADAPT**：`ModelCapabilities`                                   |
| 流式按协议各自实现                                      | 待查                                                   | **REFERENCE**                                                    |

## 7. 不该抄的（→ `adoption/rejected-ideas.md`）

Rust/PyO3 结构、`special_tokens.rs` 的具体 token 拼写、`prefix` 续写的具体协议细节（我们没有该需求）、
图像抓取栈（`deepseek-recipe-image`，依赖 opencv）、具体 `tool_call_id` 格式（含 xxh3 校验的 20+4 位）。
