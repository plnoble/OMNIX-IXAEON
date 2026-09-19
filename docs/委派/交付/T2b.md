# T2b 编码任务进待办 交付

- 分支：grok/T2b，基于 main 274b295（领活提交）；档位 B（碰编码任务的批准，整合方复审后合并）
- 执行方：Grok

## 已实现

聊天里提出的编码任务进待办：拍板「要做」= 批准并排队，「不做」= 取消，任务完成 = 待办完成，状态一律以任务表为准。旧的「行动批准卡」只给历史消息留着显示，按钮换成一句「到待办页处理」。

改动文件与行数（`git diff --stat origin/main...HEAD`）：

```
 apps/desktop/e2e/d6-chat-ui.spec.ts                | 23 +++++++-
 apps/desktop/src/main/appRuntime.ts                | 66 +++++++++++++---------
 apps/desktop/src/renderer/src/pages/Ask.tsx        | 38 +++----------
 apps/desktop/src/renderer/src/pages/AskMessage.tsx | 18 +++---
 4 files changed, 78 insertions(+), 67 deletions(-)
```

要点：

- `AppRuntime.ask()`：沿用原「本轮提议任务」查询（created_at >= startedAt、project_id 非空、LIMIT 5），逐个 `todos.propose({ title: 任务 goal 第一行（≤80 字）, conversationId, messageId: 回答 id, linked: { kind: 'coding_task', id } })`；返回 null（拒绝过的同样的事）→ `coding.cancel(任务 id)`；否则并进 `meta.proposedTodos`（与 T2a 同一列表）。不再写 `meta.proposedTasks`，返回值里的 `proposedTasks` 字段也去掉（契约里的 schema 字段保留 optional，无人再消费）。
- `acceptTodo`：底下是编码任务的先 `await coding.approveAndQueue`，成功再 `todos.accept`；批准失败原样抛错，待办不动。
- `rejectTodo`：底下是编码任务且未结束（非 completed/failed/cancelled）的先 `coding.cancel`，再 `todos.reject`。
- `listTodos`：返回前同步——「要做」的待办底下任务已 completed 的，`todos.complete`。
- 界面：待办卡对编码任务标「编码任务」小标签（Ask.tsx 从 `listTodos()` 的 `linked_kind` 取，不读消息快照）；旧批准卡的「批准并排队」按钮去掉，draft 状态显示「到待办页处理」；`AskMessage` 的 `onApprove` prop 保留为 optional（锁定测试在传，运行时忽略）。
- 取消的回合（cancelled）里 T2a 的建议待办不进卡（原逻辑），编码任务待办照常进（沿用原 proposedTasks 无条件查询的行为，委派单未要求区分）。

与委派单不一样的地方：无。

## 自动化通过

- `node scripts/acceptance.mjs run T2b`：1 文件 5 测全过（t2b-coding-todos.test.ts）；
- `node scripts/verify.mjs`：全部通过（lint / format / typecheck / unit / integration / acceptance-lock / acceptance / build / review 全绿；`node` 退出码 0）；
- d6 聊天界面 e2e（按新卡片改好：注入 proposedTodos + todos 行，点待办卡的「要做」，断言待办页「要做」区出现该条、`todo-linked` 徽章显示「排队中」；旧批准卡只验证显示与「到待办页处理」）：`1 passed (6.4s)`；
- GitHub 上的 verify：已推送后未看运行号（B 档不自行合并，等整合方复审时一并看）。

## 真机通过

三段都跑了，合成数据，临时数据目录，不碰用户数据：

**1. 真 Hermes 可用性（scripts/real/hermes-ask.ts，合成问题）**：

```
=== 问：一句话回答：1+1 等于几？｜引擎 hermes｜模型 gemini-3.7-flash-tiered｜11 秒
--- 回答末尾 400 字：
1+1 等于 2。
--- 解析出的待办（0 件）：[]
```

**2. 真 Hermes 聊天轮（真应用、临时数据目录、合成项目、真模型 gemini-3.7-flash-tiered）**：预置 config.json（setupComplete + chatModelName + hermesBridge 开着、令牌同值——复用本机 Hermes config.yaml 里已有的 ixaeon 注册，没有改写它），问答页选「合成项目」提问「请调用 propose_task 工具起草一个编码任务…」。模型如实回答：

```
=== 引擎摘要：引擎 hermes · 模型 gemini-3.7-flash-tiered
=== 回答：当前环境中未提供 `propose_task` 工具（MCP 仅加载了记忆相关的
`search_memory`、`record_observation` 和 `get_evidence`）。
=== 待办卡数量：0
```

这是**设计如此**，不是缺陷：记忆桥给聊天引擎的工具只有 `HERMES_BRIDGE_TOOLS = ['search_memory', 'get_evidence', 'record_observation']`，编码工具（propose_task 等）刻意不给聊天引擎（受众是 model，不是 coding_client）。propose_task 只有 Core 兜底循环有。所以本机上「真模型的聊天」拿不到编码任务工具，改用第 3 段验证全链路。

**3. 完整聊天轮起草编码任务（真应用 + 脚本模型替身）**：真 Electron、真 `AgentSession` 兜底循环、真 `CoreToolBroker`、真 `CodingOrchestrator`/`TodoStore`/`ConversationStore`，模型是脚本（`IXAEON_FAKE_MODEL` 脚本第一步 `propose_task`、第二步 `answer`——与仓库 d6 e2e 同一机制）。问答页选「合成项目」问「帮我起草一个编码任务：新建 note.txt 写 hello」：

```
=== 引擎摘要：引擎 core-bounded · 模型 fake-model-v1
=== 回答：已起草一个编码任务，等你拍板。
=== 待办卡数量：3（1 卡 + 要做/不做 2 按钮）
=== 卡片内容：新建 note.txt，内容写 hello（合成任务）编码任务 | 要做 | 不做
=== 已点「要做」，按钮换成状态文字
=== 待办页「要做」区：新建 note.txt，内容写 hello（合成任务） | AI 提的 | 从对话来 | 编码任务：排队中
=== DB todos: [{"title":"新建 note.txt，内容写 hello（合成任务）","status":"accepted","origin":"agent","linked_kind":"coding_task"}]
=== DB tasks: [{"status":"queued","g":"新建 note.txt，内容写 hello（合成任务）"}]
```

即：卡片带「编码任务」标签；点「要做」后待办变 accepted、任务变 queued；待办页「要做」区显示该条并标「编码任务：排队中」。截图存 `apps/desktop/release/t2b-real/`（t2b-real-card / t2b-real-accepted / t2b-real-tasks，目录不入库）。检查脚本为一次性 Playwright spec，跑完已删，未提交。

没做/没法做的：真模型的聊天轮起草编码任务——见第 2 段，本机设计上拿不到该工具；如整合方认为需要真模型路径，需要提供带 API key 的兜底模型环境或调整工具暴露设计。

## Codex 审查（A 档）

不适用（B 档，整合方复审）。

## 已知缺口

- 真模型聊天轮起草编码任务在本机不可达（设计边界，见真机第 2 段）；已用真应用 + 脚本模型全链路验证替代。
- 「要做」的待办底下任务 failed 的，待办不跟着动（委派单只要求 completed → done；failed 仍显示「要做」，用户可在任务页看到失败原因后手动处理）。
- 已排队的任务在聊天里的旧批准卡上仍显示「已排队执行」徽章（历史消息快照，未接实时状态）。

## 整合方复审（2026-09-19）

对照委派单五条契约与锁定测试：ask 把本轮编码任务推进 `proposedTodos`（拒绝过的取消任务）；accept/reject/listTodos 按任务表接线；旧批准卡去掉「批准并排队」，待办卡标「编码任务」。d6 已改点「要做」。行数 169/67，未改锁定测试与待办存取。CI `35430989506` 绿。真 Hermes 聊天轮拿不到 `propose_task` 是既有工具暴露边界，交付已用真应用+脚本模型补了全链路。并入 main。

## 用户接受

未发生（用户用过并认可之后才写）。
