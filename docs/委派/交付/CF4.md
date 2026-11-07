# CF4 交付说明：讨论转任务（先只交测试）

分支 `dev/CF4`，B 档。规格 `docs/委派/CF4-讨论转任务.md`。

## 已实现

无（B 档先只交测试；迁移 43 由整合方写，实现等迁移上 main 后再做）。

## 自动化：测试已写、现在应当红

- `apps/desktop/test/acceptance/cf4-task-from-conversation.test.ts`：条件 1–9，13 条。
  当前 `13 failed`，全部红在 `createTaskFromConversation is not a function`（实现未写）。
- `apps/desktop/test/acceptance/cf4-ui.test.ts`：条件 10 前两项（按钮出现位置、表单与提交），2 条。
  当前红在找不到 `message-to-task-<id>` / 表单元素。

跑法：`node scripts/acceptance.mjs run CF4`（解锁前可单独
`node node_modules/vitest/vitest.mjs run --project acceptance <文件>`）。

## 没覆盖到的（交整合方定）

- **条件 10 最后一项「任务页卡片 `task-origin-<id>` 显示来自对话「标题」第 a–b 条」没写自动化**：任务页现在没有稳定的卡片 testid，界面结构要等实现时定。我先不编 testid 免得锁死实现；实现时补，或整合方指定 testid 后我补测试。
- 真机检查（`scripts/real/cf4-task-origin.mjs` + 截图）留到实现那一轮做。

## 真机通过

未跑（测试先行，实现未写）。

## 用户接受

未接受。

## 备注

- 核心测试放在 `apps/desktop/test/acceptance/`（要和 `AppRuntime` 一起跑，`packages/core` 下 import 不到 `apps/desktop/src/main`）。
- 迁移 43（`coding_tasks` 三列 + 索引）按规格由整合方写；执行方不动迁移。
