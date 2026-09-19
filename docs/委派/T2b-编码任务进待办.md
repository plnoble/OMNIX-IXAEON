# 委派单 T2b：聊天里提出的编码任务进待办，拍板即批准

任务来源：[三周任务单](../三周任务单.md) T2。档位：**B**（碰编码任务的批准，整合方复审后合并）。大小：中（≤200 行）。依赖：T2a。

## 背景

聊天里（Core 兜底循环的 `propose_task` 工具等）提出的编码任务，现在以「行动批准卡」挂在回答下面，卡片状态是提问时的快照——批准后重开对话仍显示「批准并排队」（D6 复核遗留）。设计决定 3：待办是薄的一层，底下指向已有的编码任务。这一单让编码任务也走待办：拍板「要做」= 批准并排队，「不做」= 取消，任务完成 = 待办完成，状态一律以任务表为准。

## 契约（写死，照着实现）

1. `AppRuntime.ask()`：这一轮里新建的编码任务（沿用现有「本轮提议任务」的查询）逐个 →
   `this.todos.propose({ title: 任务 goal 的第一行（最长 80 字）, conversationId, messageId: 这条回答的 id, linked: { kind: 'coding_task', id: 任务 id } })`：
   - 返回 `null`（你拒绝过同样的事）→ `this.coding.cancel(任务 id)`，这条不出现在回答上；
   - 否则并进这条回答的 `meta.proposedTodos`（与 T2a 的同一个列表，每项 `{ id, title }`）。
   - 不再写 `meta.proposedTasks`；`AskMessage` 里旧的「行动批准卡」只给历史消息留着显示，**去掉「批准并排队」按钮**，改为一句「到待办页处理」。
2. `AppRuntime.acceptTodo(id)`：底下是编码任务的，先 `await this.coding.approveAndQueue(任务 id)`，成功后再 `todos.accept`；批准失败就原样报错，待办不动。
3. `AppRuntime.rejectTodo(id)`：底下是编码任务、且任务还没结束（不是 completed / failed / cancelled）的，先 `this.coding.cancel(任务 id)`，再 `todos.reject`。
4. `AppRuntime.listTodos(input)`：返回之前先同步——「要做」的待办，底下编码任务已经 completed 的，`todos.complete`。
5. 界面：聊天里的待办卡（T2a）对底下是编码任务的，标一个「编码任务」小标签；待办页（T3）已经显示任务实时状态，不用再改。

## 验收（锁定，执行方不改）

- `node scripts/acceptance.mjs run T2b` 全过（`apps/desktop/test/acceptance/t2b-coding-todos.test.ts`）；
- `node scripts/verify.mjs` 全过；d6 聊天界面 e2e 按新的卡片改好并通过（它原来点的是「批准并排队」，改成点待办卡的「要做」）；
- 真机（临时数据目录 + 合成项目即可）：让一轮聊天起草一个编码任务，描述待办卡、点「要做」后任务页里的状态。

## 不要做

- 不改编码任务的执行、验证、验收流程本身；
- 不改待办的存取与迁移；不改锁定的验收测试。

## 交付

改动文件与行数；验收、verify、d6 e2e 的输出；真机描述；已知缺口。推送前先 rebase 到最新 main，**不要自己合并**（B 档由整合方复审）。
