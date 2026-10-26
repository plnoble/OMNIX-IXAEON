# 交付：DS2 —— Canonical IR / ReasoningState / ModelCapabilities

- 分支：`dev2/DS2`（基于 main）；档位 **B**（改变模型调用约定、涉及发给模型的提示词约定）
- 来源：`docs/research/deepseek/adoption/rfc-proposals.md` 的 RFC-001 / RFC-002 / RFC-003
- 执行方：dev2

## 已实现（三块，逐条对应 RFC）

### 1. RFC-001 Canonical Conversation IR

`packages/core/src/model/canonical.ts`（新增）

- `CanonicalRole`（`system|user|assistant|tool`）、`CanonicalToolCall`、`CanonicalMessage`、`CanonicalConversation`；
- `fromLegacyPrompt(system, user)`：旧「system+user 两段」到 IR 的等价映射；
- **刻意不含**（照 DeepSeek 蒸馏的 Do Not Copy 清单）：`prefix` 续写、`LatestReminder` 独立消息位、多模态 token spec、tokenizer 细节。

**为什么**：原来 `ModelProvider` 只有 `system: string` + `user: string`，多轮角色/推理/工具轮次无处安放，
换 provider 要改业务调用点。外部实证：`deepseek-recipe` 的 `core/conversation.rs` 与 `protocol/*/convert.rs` 完全隔离。

### 2. RFC-002 ReasoningState（四态）

`packages/core/src/model/reasoning.ts`（新增）

- `ReasoningState`：`absent_legal`（thinking 轮确实无推理，容忍）/ `present`（原样回传）/
  `not_applicable`（非 thinking 轮，丢弃）/ `missing`（应有却没有）；
- `renderReasoningFor(state, {thinking, strict})`：非 thinking 一律丢弃；`absent_legal` 补空串**不报错**；
  `missing` 在严格档报**可诊断**错误、非严格档补空（由调用方记审计）。

**为什么**：我们**真实踩过** `The reasoning_content in the thinking mode must be passed back`。
根因是把「模型没产生推理」与「客户端漏传」当成同一件事。外部实证：recipe 用三条件才拒绝 + `ET_` 带内标记区分。

### 3. RFC-003 ModelCapabilities

`packages/core/src/model/capabilities.ts`（新增）+ `provider.ts` 接口扩展

- `ModelCapabilities`：`structuredOutput`（`native-schema|tool-call|validate-only`）/ `seed` / `tools` /
  `vision` / `maxContext` / `streaming`；
- `CONSERVATIVE_CAPABILITIES`：未知时一律最弱档，**不夸大**；`maxContext` 未知为 `null`，**不猜数值**；
- `ModelProvider` 新增 `readonly capabilities`；
- `FakeProvider` 声明 `validate-only`（它确实只能校验，不许声称 native-schema）；
- `OpenAIResponsesProvider` 声明 `native-schema`（`/responses` 确实用 `json_schema strict`）、
  `seed:false`、`maxContext:null`。

## 修改文件与行数

| 文件                                                        | 变更                          |
| ----------------------------------------------------------- | ----------------------------- |
| `packages/core/src/model/canonical.ts`                      | 新增 45 行                    |
| `packages/core/src/model/reasoning.ts`                      | 新增 62 行                    |
| `packages/core/src/model/capabilities.ts`                   | 新增 36 行                    |
| `packages/core/src/extraction/model/provider.ts`            | +8 行（接口加 capabilities）  |
| `packages/core/src/extraction/model/fake.ts`                | +6 行                         |
| `packages/core/src/extraction/model/openai.ts`              | +18 行                        |
| `packages/core/test/acceptance/ds2-canonical-model.test.ts` | 新增测试 152 行（不计入源码） |

**源码合计约 175 行**（< 300，单包可交）。

## 自动化通过

```
tsc --noEmit                                                    exit 0
eslint (src/model + extraction/model + 本测试)                  exit 0
vitest --project acceptance ds2-canonical-model.test.ts         9 passed (9)
```

9 条覆盖：三块各自的成功标准（多轮角色保序、reasoning 与 toolCalls 位、旧签名兼容、
四态互不相等、`absent_legal` 不报错、`missing` 严格档报可诊断错、present 原样回传、
capabilities 字段与 `maxContext:null`、FakeProvider 不虚报 native-schema、validate-only 走 zod 校验路径）。

## 未做 / 需要整合方拍板

1. **没有 lock、没有 done、没有合并**（B 档关卡归整合方）。
2. **`capabilities` 是必需字段**：现有两个实现已声明；仓库外若还有 `ModelProvider` 实现会编译失败——
   这是有意的（强制不得含糊），但请整合方确认这个破坏面可接受。
3. **未接 `chat(CanonicalConversation)` 重载**：RFC-001 提到的新入口本轮**没实现**，
   只做了类型层 + 旧入口不变。真正让多轮 IR 跑起来需要改 `chatStructured/chatText` 的内部拼装，
   涉及发给模型的提示词约定（B 档），建议单独一单。
4. **`OpenAIResponsesProvider` 声明的 `native-schema` 有前提**：`/chat/completions` 回退端点只有
   `json_object` + 提示词附 schema，不是强约束。是否要为回退端点声明更弱档（或运行时动态降级），
   请整合方定——我按「主端点行为」声明，并在代码注释写明了这个差异。
5. **未做 seed**：`seed:false` 如实声明，固定种子要改调用协议，另开一单。

## 真机通过 / 用户接受

- 真机：**未跑**（本轮无外发调用；`FakeProvider` 合成测试）。
- 用户接受：**未取得**。
