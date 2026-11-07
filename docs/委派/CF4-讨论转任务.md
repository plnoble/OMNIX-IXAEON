# 规格 CF4：讨论转任务（用户点一下，把一段聊天转成编码任务草案，任务记下来自哪段对话）

档位：**B**。要加迁移（`coding_tasks` 加三列），还多了一个从聊天建任务的入口。源码约 200 行，超过 300 行照规矩拆成 CF4 / CF4b（core + IPC 一支、界面一支）。

依赖：CF1（聊天做首页）、CF3c（聊天只走直连）已并入。**迁移 43 由整合方写**，写好并推到 main 之前，执行方只写测试，不写实现。

来源：

- 队列第 153 行：「用户主动把一段讨论转成任务，任务记下来源对话与消息范围」。
- 用户 10-31 定的第 1 阶段先后（CF0 → CF1 → CF2 → CF3 → CF6 → CF4 → CF5）；建议书「Chat First, Task On Demand」：普通对话不建任务，**用户决定执行时才转成任务**（[三周任务单](../三周任务单.md)「总体升级」一节）。
- CF2 / CF3c 之后聊天什么任务都不建，编码任务只能去「任务」页从头填。CF3c 退役丙类测试时写明：「CF4 做讨论转任务时再补来源追踪的验收」。

**这一单说的「讨论」是聊天里的对话**，不是「待讨论」页。「待讨论」页（`Inbox.tsx`）列的是 `items` 表里 `needs_review` 的记忆条目（冲突、归属不明），它们是记忆，不是要做的事，不在这一单里。

## 现在的样子

- 对话和消息在 `conversations` / `messages` 表（迁移 26）。消息有 `seq`，同一对话内唯一、递增。
- 编码任务在 `coding_tasks` 表（迁移 15）。跟来源有关的只有 `origin_run_id`（迁移 35），记的是「哪一轮提问里建的」。CF3c 之后聊天不再建任务，新任务这一列都是空的。
- 建任务的入口只剩「任务」页的「创建草案」（`createCodingTask` → `CodingTaskStore.create`）：手填项目、目标、范围、验证命令，不知道是从哪段对话来的。
- 待办（`todos` 表）已经有 `conversation_id` / `message_id`，「待办：」开头的消息照旧建待办。这一单不动待办。
- 旧的 `proposeCodingTask`（D1，模型提草案）里有可以照抄的检查：目标 1–2000 字、验收条件 1–8 条且每条 1–200 字、项目要绑了文件夹（`assertProjectFolderBound`）。

## 要什么

1. **入口**：聊天页每条状态是 `complete` 的助手消息下面加一个按钮「转成任务」。点开一个表单（就在这条消息下面展开，不弹新窗口）：
   - **范围**：结束于这条助手消息；开始默认是它前面那条用户消息（就这一轮）。下拉框能把开始往前挪到这个对话里更早的任一条用户消息。表单上写「第 a–b 条，共 n 条消息」。
   - **目标**：预填范围里第一条用户消息的正文（超过 2000 字截断），用户可改。**不调模型生成目标**，不新增外发。
   - **验收条件**：多行输入框，一行一条，必填 1–8 条。
   - **范围（可修改的路径）**：默认 `.`，跟 D1 一样。
   - **项目**：对话有项目就是它，不能改；对话是「个人视角」的，下拉框选一个项目，没选不能提交。
   - 按钮「建草案」。点了才建，建的是 `draft`：不批准、不派发、不跑命令。这一步就是用户的确认。
2. **建出来的任务**：`CodingTaskStore.create` 多收三个参数，写进新的三列：
   - `originConversationId`、`originFromSeq`、`originToSeq`；
   - `originRunId` 显式传 `null`，不从异步上下文取；
   - `allowedCommands: []`，跟 D1 聊天里提的草案一样不带验证命令；后面怎么验证照 D1 草案现在的走法，这一单不改。
3. **新 IPC**（写死，不改名）：
   ```ts
   createTaskFromConversation(input: {
     conversationId: string;
     fromMessageId: string;   // 范围开始那条消息
     toMessageId: string;     // 范围结束那条消息（就是点按钮的那条助手消息）
     goal: string;
     acceptance: string[];
     scope?: string[];        // 不传 = ['.']
     projectId?: string;      // 只在对话没有项目时用；对话有项目时传了也不认
   }): Promise<CodingTask>;
   ```
   主进程校验：两条消息都属于这个对话；开始的 `seq` 不大于结束的；结束那条是 `assistant` 且 `complete`；目标、验收条件照 D1 的长度规则；项目存在、绑了文件夹（同一道 `assertProjectFolderBound`，同一句文案）；对话有项目时用对话的项目。任何一条不满足就抛 `VALIDATION_FAILED`，什么都不建。
4. **原来的消息不动**：不改对话里任何消息的正文、状态、`meta`，不删，不归档对话。
5. **对话里看得到转过**：结束那条消息下面显示「已转成任务：<目标前 30 字>」和「到任务页看」按钮（复用现有的 `onOpenTask`）。数据来自新 IPC `listConversationTasks(conversationId): Promise<CodingTask[]>`，按 `origin_conversation_id` 查，不写进消息 `meta`。同一段可以再转一次，会多建一条。
6. **任务页看得到来源**：任务卡片上 `origin_conversation_id` 不为空时显示「来自对话「<对话标题>」第 a–b 条」，点了打开那个对话（App 里已有 `openConversationId`）。对话被删了显示「来自已删除的对话」。
7. **不把聊天原文交给执行器**：派发时执行器拿到的还是 `goal` + 验收条件 + 项目背景（`taskBackground`），这一单不往里加讨论原文。用户在表单里看到、改过的目标和验收条件，就是发出去的全部内容。
8. **留痕**：建成后 `recordAudit(db, 'conversation.task_created', { taskId, conversationId, messageCount })`，不记正文、不记目标。

## 迁移 43（整合方写，执行方不动）

```sql
-- CF4：编码任务记下来自哪段对话。删了对话时来源对话置空，消息范围留着当历史。
ALTER TABLE coding_tasks ADD COLUMN origin_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE coding_tasks ADD COLUMN origin_from_seq INTEGER CHECK (origin_from_seq IS NULL OR origin_from_seq >= 1);
ALTER TABLE coding_tasks ADD COLUMN origin_to_seq INTEGER CHECK (origin_to_seq IS NULL OR origin_to_seq >= 1);
CREATE INDEX idx_coding_tasks_origin_conversation ON coding_tasks(origin_conversation_id) WHERE origin_conversation_id IS NOT NULL;
```

为什么加列、不另建表：一条任务只来自一段对话，一对一；`todos` 也是在自己表上记 `conversation_id`。三列都可空：任务页手建的、旧任务都是空。`codingTaskSchema` 跟着加三个可空字段 `origin_conversation_id`、`origin_from_seq`、`origin_to_seq`（这是代码，执行方改）。

## 约束

- 不写迁移；不改发给模型的任何内容；不调模型。
- 不改「任务页新建」那条路；不动待办、不动「待讨论」页。
- 不改 `CodingTaskStore.create` 已有参数的含义，只加可选参数；不传时三列为空。

## 验收条件

测试用临时库、合成数据（项目「合成项目甲」，绑一个临时目录；对话里先用替身直连客户端聊两轮，照 `apps/desktop/test/acceptance/mp3-chat.test.ts` 的办法）。

1. **建出来的任务记着来源**：对第 2 轮的助手消息调 `createTaskFromConversation`，开始取第 1 轮的用户消息：
   - 返回的任务 `status = 'draft'`、`origin_conversation_id` 是这个对话、`origin_from_seq` / `origin_to_seq` 等于那两条消息的 `seq`、`origin_run_id` 为 null、`allowed_commands_json = '[]'`、`acceptance_json` 就是传入的几条；
   - `coding_approvals` 行数不变，任务没被派发（执行器替身调用 0 次）。
2. **原消息不动**：建之前和建之后，这个对话所有消息的 `content`、`status`、`meta_json`、`updated_at` 逐条相同；对话的 `archived_at` 仍为 null。
3. **校验**，下面每种情况都抛 `VALIDATION_FAILED`，`coding_tasks` 行数不变：
   - 消息不属于这个对话（用另一个对话的消息 id）；
   - 开始的 `seq` 大于结束的；
   - 结束那条是用户消息，或是 `failed` / `streaming` 的助手消息；
   - 目标为空或超过 2000 字；验收条件 0 条、9 条，或某条超过 200 字；
   - 个人视角的对话没传 `projectId`；
   - 项目没绑文件夹：报错文案跟任务页批准时那句一样。
4. **项目以对话为准**：对话属于项目甲时传 `projectId = 项目乙`，建出的任务 `project_id` 是项目甲。
5. **个人视角的对话**：传 `projectId = 项目甲`（已绑文件夹），建出的任务 `project_id` 是项目甲。
6. **留痕不含正文**：`audit_events` 多一行 `conversation.task_created`，详情里有 `taskId`、`conversationId`、`messageCount = 4`；详情的 JSON 里不出现目标原文，也不出现任何一条消息的正文。
7. **对话删了**：删掉对话后再读任务，`origin_conversation_id` 为 null，两个 `seq` 不变，任务还在。
8. **任务页手建的不受影响**：`createCodingTask` 建的任务三列都是 null。
9. **执行器拿不到聊天原文**：派发一条转出来的任务（假执行器），交给执行器的内容里不含两轮对话的任何一句正文（对话里放一句独特的合成句子「合成暗号：蓝鲸七号」，断言它不出现）。
10. **界面**（jsdom，照 `cf6-conversation-ui.test.ts` 的办法替身 api）：
    - `complete` 的助手消息下有 `message-to-task-<messageId>`；用户消息、`failed` 的助手消息下没有；
    - 打开表单后目标框预填那条用户消息的正文；开始下拉框 `message-to-task-from` 的选项是这个对话里结束那条之前的全部用户消息；
    - 验收条件为空时「建草案」`message-to-task-submit` 不可点；
    - 提交时 `createTaskFromConversation` 收到的参数跟表单一致（验收条件按行拆、去掉空行）；
    - 建完那条消息下出现 `message-task-link-<taskId>`，点了调 `onOpenTask(taskId)`；
    - 任务页卡片 `task-origin-<taskId>` 显示「来自对话「<标题>」第 a–b 条」。

## 真机检查

- 设 `IXAEON_DATA_DIR=<临时目录>` 启动应用。模型用 `scripts/real/cf3-fake-gateway.mjs` 起的假网关（模型 `demo-a`，Key `sk-synthetic`），项目「合成项目甲」绑一个临时的空目录。
- 新对话里问两句合成问题（比如「帮我想想记账小程序要哪些页面」「那先做记一笔这页」），在第 2 条回答下点「转成任务」，开始挪到第 1 句，填两条验收条件，建草案；到任务页看来源，点回对话。截图遮掉临时目录。
- 写 `scripts/real/cf4-task-origin.mjs`，只读那个临时库，输出：
  - 编码任务行数、其中 `origin_conversation_id` 不为空的行数；
  - 那条任务的 `origin_from_seq`、`origin_to_seq`、状态；
  - 这个对话的消息条数；
  - `conversation.task_created` 审计行数。

  预期：编码任务 1（有来源的 1），范围 1–4，`draft`，消息 4 条，审计 1。

- 只贴脚本输出和截图，不贴对话原文。

## 交付

B 档：先只推测试（`packages/core/test/acceptance/cf4-*.test.ts`、`apps/desktop/test/acceptance/cf4-*.test.ts`），队列状态改「测试待审（整合方）」，接着去领别的。整合方写迁移 43、锁定测试后再写实现。交付说明 `docs/委派/交付/CF4.md`。
