# 三份架构改进 RFC（DeepSeek 蒸馏产出）

> 任务书 §30-G 要求「至少 3 个真正适合 ixaeon 的架构改进 RFC」。三份都满足：
> 问题在 ixaeon **真实存在**（有文件:行证据）、有外部实证参考、且**当前不做大规模改动**。
> 状态：**Proposed（未实现，等统筹批准）**。

---

# RFC-001：Canonical Conversation IR（协议与模型后端解耦）

## 问题（ixaeon 真实存在）

`packages/core/src/extraction/model/provider.ts:7-21` 的 `ModelProvider` 只有两个方法，
入参是 `system: string` + `user: string`：

```ts
chatStructured<T>(input: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
chatText(input: { system: string; user: string }): Promise<string>;
```

后果（都是现在就能观察到的）：

1. **无处安放多轮结构**：历史对话只能被压成一个 `user` 字符串（拼接），role 边界丢失；
2. **无处安放 reasoning 状态** → RFC-002 的坑；
3. **无处安放 tool 定义/调用/结果** → 未来接 tool calling 必然散落；
4. `OpenAIResponsesProvider`（21.4KB）**直接实现协议**，换 provider 需改业务调用点。

外部实证：`deepseek-recipe@935817c66f5d` 的 `core/src/{conversation,messages}.rs`（协议无关 IR）
与 `protocol/{openai,anthropic}/*/convert.rs`（每协议独立转换器）完全隔离，核心不 import 协议类型。

## 提议（最小版，不推倒重来）

新增 `packages/core/src/model/canonical.ts`（纯类型，无副作用）：

```ts
export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';
export interface CanonicalMessage {
  role: CanonicalRole;
  text: string;
  reasoning?: ReasoningState; // 见 RFC-002；仅 assistant
  toolCalls?: CanonicalToolCall[]; // 仅 assistant
  toolCallId?: string; // 仅 tool
}
export interface CanonicalConversation {
  messages: CanonicalMessage[];
  outputFormat?: 'text' | 'json';
}
```

适配策略（**增量**，不改 20+ 调用点）：

- 保留 `chatText/chatStructured` 签名不动，新增重载 `chat(c: CanonicalConversation)`；
- 旧调用方等价于 `chat({messages:[{role:'system',text},{role:'user',text}]})`；
- provider 实现侧：`CanonicalConversation → 协议 DTO` 的单向转换，一处一个文件。

## 成功标准

1. 现有所有测试不改即过（旧签名保留）；
2. 新增测试：多轮 IR 经 `FakeProvider` 往返，role/顺序不丢；
3. 新增测试：同一 IR 分别经 openai adapter 与 fake adapter，行为一致（协议无关性）；
4. 业务代码里**不出现**协议 DTO 类型（`git grep` 可查）。

## 非目标

不实现 `prefix` 续写、不实现 `LatestReminder`、不实现 multimodal、不做 tokenizer。

---

# RFC-002：ReasoningState（推理内容四态）

## 问题（ixaeon 真实踩过）

任务书 §9 记录的报错：`The reasoning_content in the thinking mode must be passed back`。
根因：把「模型这轮没产生推理」与「客户端漏传推理」当成同一件事。
我们现在连位置都没有（`provider.ts` 无 reasoning 字段），一旦接 thinking 模型就会重现。

外部实证：recipe `protocol/reasoning_content.rs:1-70` 用**三条件才拒绝**的规则，
并用 `tool_call_id.rs:1-40` 的 `ET_` 带内标记区分两种「空」。

## 提议

```ts
export type ReasoningState =
  | { kind: 'absent_legal' } // thinking 轮，模型确实没产生（对应 ET_）
  | { kind: 'present'; text: string } // 有推理内容，必须回传
  | { kind: 'not_applicable' } // 非 thinking 轮，丢弃
  | { kind: 'missing' }; // 应有但没有 → adapter 决定补空/报错
```

规则（与外部对齐）：

- `not_applicable`：非 thinking 模式下所有 assistant 的 reasoning 一律丢弃；
- `present`：原样回传；
- `absent_legal`：补空字符串回传，**不报错**；
- `missing`：由 provider 能力决定——支持严格模式的报可诊断错误（含「第几条消息」），否则补空并记录审计。

## 成功标准

1. 合成用例覆盖四态，每种都有明确期望（不靠「跑一下看看」）；
2. `missing` 情形报错时**指出具体消息 index**（可诊断）；
3. 连续多轮 thinking → tool → thinking 的往返不丢状态（FakeProvider 断言）。

## 非目标

不要求所有 provider 都支持 reasoning；不引入 DeepSeek 的 token 级细节。

---

# RFC-003：ModelCapabilities（能力声明替代名称判断）

## 问题（ixaeon 真实存在）

`provider.ts:8` 只有 `readonly modelName: string`。没有任何能力声明，所以：

- 结构化输出**始终走最弱档**（生成后 zod 校验 + 重试），即使 provider 支持原生 JSON schema；
- 无法表达「这个模型支持 seed / tool / vision / 多长上下文」；
- 未来必然写成 `if (modelName === 'gpt-...')`——正是外部刻意避免的形态。

外部实证：recipe 把模型版本差异收敛在 `encoding/src/{v4,v41}/*` 与各 `convert.rs`；
DeepInfer README 明确声明硬件/模型假设与**不含**项。

## 提议

```ts
export interface ModelCapabilities {
  structuredOutput: 'native-schema' | 'tool-call' | 'validate-only';
  seed: boolean;
  tools: boolean;
  vision: boolean;
  maxContext: number | null; // null = 未知，不猜
  streaming: boolean;
}
```

使用点改造（同样增量）：

- `chatStructured` 内部按 `capabilities.structuredOutput` 选择最强手段，**降级链显式**；
- 判断一律问能力，**禁止**新增 `modelName` 比较（可用 lint 规则或 review 约定守住）。

## 成功标准

1. 声明 `native-schema` 的 provider 走原生 schema 路径（测试用假 adapter 断言走了哪条路）；
2. 声明 `validate-only` 的回落到现有 zod 校验，行为与今天一致；
3. `git grep "modelName ==="` 在新增代码中为 0；
4. `maxContext` 未知时**不猜数值**（显式 null，调用方决定保守策略）。

## 非目标

不做模型路由、不做自动选择模型、不改 ModelPool（已停用）。
