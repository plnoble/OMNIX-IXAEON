# 委派单 T2a：聊天里的待办——AI 列「建议待办」、你写「待办：」直接加

任务来源：[三周任务单](../三周任务单.md) T2。档位：**B**（改了发给模型的约定，整合方复审后合并）。大小：中（≤300 行）。依赖：T3（`runtime.todos`、`acceptTodo` / `rejectTodo` / `listTodos` 的 IPC）。

## 背景

Hermes 聊天里模型只有联网与记忆桥（默认关）两类工具，没有办法「提一个待办」。所以约定：AI 建议你或 IXAEON 接下来去做具体的事时，在回答最后按固定格式列出，由代码解析成待办（等你拍板）；你自己在消息开头写「待办：…」就直接加一条（算要做）。不依赖任何工具开关，也不多花一次模型调用。

## 契约（写死，照着实现，不改名、不改措辞）

1. 新文件 `packages/core/src/runtime/suggestedTodos.ts`，三样都从 `packages/core/src/index.ts` 导出：

   ```ts
   export const SUGGESTED_TODOS_INSTRUCTION =
     '（IXAEON 约定：如果你建议用户或 IXAEON 接下来去做具体的事，在回答最后另起一段，第一行写「建议待办：」，下面每行以「- 」开头写一件，最多 5 件；没有就不写这一段。）';
   export function extractSuggestedTodos(answer: string): { answer: string; todos: string[] };
   export function parseUserTodo(message: string): string | null;
   ```

   - **标题行**：去掉 `#`、`*` 和空白后正好是「建议待办：」或「建议待办:」的一行；有多行取最后一个。正文里顺口提到「建议待办」的不算。
   - 标题行之后，连续的列表行（`- `、`* `、`• `、`1.`、`1)`、`1、` 开头）和空行都属于这一段，遇到第一个非空、非列表的行就结束。
   - **待办**：每件去掉编号、首尾空白；空的去掉、重复的去掉；最多 5 件；每件最长 80 字，超出截断。
   - **回答**：标题行之前的正文（去掉结尾空白）+ 列表之后剩下的话（去掉首尾空白），非空的部分用一个空行连起来。没有标题行：原样返回，待办为空。
   - `parseUserTodo`：消息开头（允许前导空白）是「待办：」「待办:」「记个待办：」「加个待办：」「加待办：」，后面非空 → 返回后面的标题（去首尾空白）；其余返回 `null`。

2. `packages/core/src/runtime/session.ts`：Hermes 路径派发的这一轮末尾一律加上 `\n\n${SUGGESTED_TODOS_INSTRUCTION}`（与记忆桥开关无关）。Core 兜底路径不加。
3. `AppRuntime.ask()`：
   - 用户消息存下之后：`parseUserTodo(question)` 非空 → `this.todos.add({ title, conversationId, messageId: 用户这条消息的 id })`。问题照常发给模型。
   - 拿到回答后、`finishMessage` 之前：`extractSuggestedTodos(result.answer)`，存进消息的是**去掉那一段之后**的回答；每件 → `this.todos.propose({ title, conversationId, messageId: 这条回答的 id })`，返回 `null` 的（你拒绝过的）跳过。
   - 这条回答的 `meta`：有提议时写 `proposedTodos: Array<{ id: string; title: string }>`；你加了待办时写 `userTodo: { id, title }`。没有就不写这两个键。
4. 界面：
   - `AskMessage` 加两个可选属性：`todoStatus?: Record<string, TodoStatus>`、`onDecideTodo?: (id: string, decision: 'accept' | 'reject') => void`。
   - 回答的 `meta.proposedTodos` 画成卡片 `todo-card-<id>`（标题）。状态（查 `todoStatus`，查不到当作 proposed）是 proposed 的，给「要做」`todo-card-accept-<id>`、「不做」`todo-card-reject-<id>` → `onDecideTodo`；其余只显示结果：accepted「要做」、done「已完成」、rejected「不做」。
   - `meta.userTodo` 画成 `user-todo-note`：「已加到待办：<标题>」。
   - `Ask.tsx`：打开对话时、每轮回答后，用 `api.listTodos()` 取这些待办的**当前状态**传给 `AskMessage`（不读消息里的快照）；`onDecideTodo` 调 `api.acceptTodo` / `api.rejectTodo` 后刷新状态。

## 验收（锁定，执行方不改）

- `node scripts/acceptance.mjs run T2a` 全过（`packages/core/test/acceptance/t2a-suggested-todos.test.ts`、`t2a-hermes-instruction.test.ts`，`apps/desktop/test/acceptance/t2a-ask-todos.test.ts`、`t2a-todo-cards.test.ts`）；
- `node scripts/verify.mjs` 全过；d6 聊天界面 e2e 仍然通过；
- 真机（真 Hermes，一次）：问一句像「我这周该做点什么？」，如实描述 AI 有没有列「建议待办」、卡片出没出现、点「要做」后待办页里有没有。模型不照格式列也如实写。

## 不要做

- 不改待办的存取与迁移；不做编码任务的批准（T2b）；
- 约定的措辞一个字不改（改措辞 = 改提示词，B 档要整合方定）；
- 不改锁定的验收测试。

## 交付

改动文件与行数；验收、verify、d6 e2e 的输出；真机描述；已知缺口。推送前先 rebase 到最新 main，**不要自己合并**（B 档由整合方复审）。

## 并入时整合方改的（2026-09-19）

**约定措辞收紧**（B 档，整合方定）。执行方没做真机，整合方用真 Hermes（gemini-3.7-flash-tiered，临时空库，不碰真实数据）问了 5 个问题：

| 问题                                           | 原措辞 | 新措辞 |
| ---------------------------------------------- | ------ | ------ |
| 我这周该做点什么？                             | 5 件   | 5 件   |
| 我想把家里那台旧笔记本处理掉，接下来该怎么做？ | 5 件   | 5 件   |
| Electron 和 Tauri 有什么区别？                 | 3 件   | 无     |
| 为什么夏天手机充电会变慢？                     | 4 件   | 无     |
| 帮我解释一下什么是向量数据库                   | 4 件   | 无     |

原措辞「如果你建议用户或 IXAEON 接下来去做具体的事」下，解释概念、回答事实的问题每次都附几件，「等你拍板」会越积越多——正是用户说过不要的「每句话都要审核」。新措辞只在问下一步、请它安排、或明确要人去办时才列（全文见 `packages/core/src/runtime/suggestedTodos.ts`）。锁定验收要求的「建议待办：」「- 」「5」「没有就不写」都还在。

**另外补的**（测试在 `apps/desktop/test/integration/t2a-followups.test.ts`、`t2a-streaming-todos.test.ts`）：

- 问答存档（记忆提炼的输入）和 `ask()` 的返回值也用拆掉「建议待办」段之后的回答。原来存档的是原文，同一件事会既是待办、又被提炼成一条「AI 建议」；
- 这一轮回答失败时，你写的「待办：…」照样加上了，「已加到待办」的提示也留在这条回答上；
- 回答还在逐字出来时，先不显示末尾的「建议待办」段（原来会先闪出来，答完才消失）；
- 回答下面的待办卡加了小标题「建议待办」和样式。
