# CF2 交付说明：聊天行为基线（先只交测试）

分支 `dev/CF2`，B 档。固定合成问题集 8 句原文写死在 `apps/desktop/test/acceptance/cf2-chat-baseline.test.ts`。

## 测试对应条件

| 条件 | 内容                                                                                               | 现在                                 |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1    | 问题 1–7：待办/编码任务行数不变、meta 无 `proposedTodos`、正文里「建议待办：」原样在               | 红（现在会拆成待办、正文被摘掉）     |
| 2    | 问题 8 建且只建一条用户待办（标题「周五前把发票寄出去」、来源 user），编码任务不变                 | 红（现在正文段也变成待办，多出几条） |
| 3    | 工具清单正好五个                                                                                   | 绿（现状已对）                       |
| 4    | `propose_coding_task` / `git_commit` 被拒、不建东西、不起子进程（`vi.mock` 盯 `spawn`/`execFile`） | 绿（现状已拒）                       |
| 5    | 已有 AI `proposed` 旧待办问完 8 句不动                                                             | 红（现在被改写/状态被动过）          |
| 6    | 问题 1 照常存档、存的正文带「建议待办：」                                                          | 红（现在存档前被拆掉）               |

运行：`6 tests | 4 failed | 2 passed`（1/2/5/6 红，3/4 绿），符合「实现还没改」的预期。已 `lock CF2`。

## 要退役 / 改写的旧断言（T2a，整合方处理，我没改）

1. `apps/desktop/test/acceptance/t2a-ask-todos.test.ts`
   - `it('落成等你拍板的待办，记着来自哪次对话、哪条回答；回答里去掉那一段')`：要求把回答末尾「建议待办」拆出来建待办、并从回答里删掉——与条件 1、6 冲突。
   - `it('你拒绝过的同一件事不再提，也不出现在这条回答上')`：依赖上一条建出的待办与 `meta.proposedTodos`——冲突。
   - 同文件里对 `meta['proposedTodos']` 的断言（L106、L118）——冲突（这一单后不再有该字段）。
   - `it('回答里没有这一段：不建待办，也不记 proposedTodos')` 与 `it('直接加成要做的待办…')`：不冲突（前者断言「没有就不建」，后者是用户发起的待办）。
2. `packages/core/test/acceptance/t2a-suggested-todos.test.ts`
   - 若条件 1 把 `extractSuggestedTodos` 删掉（`suggestedTodos.ts` 只在提问路径用），这份文件整份要退役；里面的 `describe('回答末尾的「建议待办」')` 5 条都是解析函数本身。
   - 其中 `describe('你自己在消息开头写「待办：」')` 是用户发起待办的行为，建议保留（可搬到别处），不冲突。
   - `describe('告诉 Hermes 怎么列')` 与 Hermes 约定有关，本单不改，可留。
3. `apps/desktop/test/acceptance/g04-task-origin.test.ts`
   - 条件 3 的断言点是回答消息 `meta.proposedTodos`（文件头注释与断言）：与「不再有 proposedTodos」冲突，需改写为看 `propose_task` 的 runId 来源。
4. `apps/desktop/test/acceptance/t2a-todo-cards.test.ts`
   - 核对结论：它用固定的 `meta.proposedTodos` 夹具画卡片；旧待办（含「建议」状态）还会显示，**行为上不冲突**，但若 `proposedTodos` 类型被删，**编译层面会红**，需改成直接按 todos 行构造。请整合方定。
5. `packages/core/test/acceptance/t2a-hermes-instruction.test.ts`、`packages/core/test/acceptance/cf3-prompt.test.ts`
   - 都断言「Hermes 约定 / 提示词里有『建议待办』约定或不含某段」，本单明确「不改系统提示、不改 Hermes 约定」，**不冲突**。

## 真机检查

未跑（先只交测试）：`scripts/real/cf2-baseline-counts.mjs` 与 8 句真实提问留到实现后一起做。

四项：已实现=无（只测试）；自动化通过=2/6（3、4）；真机通过=未跑；用户接受=未接受。

## 整合方锁定（2026-11-06）

改了测试的地方：

- **待办表记来源的列叫 `origin`（`agent` / `user`），没有 `source`**。条件 2 和条件 5 原来查、写的是 `source`，正确的实现也会报 SQL 错，条件 5 现在就红在这里。已改成 `origin`。条件 5 补了一句：问完 8 句，除旧待办外库里只有一条用户的待办。
- **条件 4** 补「拒绝之后这一轮照常完成」：最后一条消息状态 `complete`、正文是替身的普通回答。
- **条件 6** 补「交给存档的内容里带着那段」：查 `captureAsk` 收到的参数，不只查消息。

一次性原型（不提交）：把提问路径里 `extractSuggestedTodos` 那两行换成「原样不拆」，CF2 六条全过。改之前，条件 1、2、5、6 都红在「还在把回答变成待办」，红得对。

退役（跟 CF2 冲突，用户 11-03 定）：

- `t2a-ask-todos.test.ts` 两条：「落成等你拍板的待办…回答里去掉那一段」「你拒绝过的同一件事不再提…」。T2a 重锁。
- `integration/t2a-followups.test.ts` 一条：「问答存档与返回值里都没有『建议待办』那一段」（集成测试，不在锁定清单里）。
- 原型下这三份照旧全过。dev 列的其它几份核过：`g04-task-origin` 原型下没红，不用改；`t2a-todo-cards`、`t2a-hermes-instruction`、`cf3-prompt` 不冲突；`t2a-suggested-todos` 只测解析函数，实现时要是删了解析函数，再来找整合方退役。

可以写实现了。
