# G1b 交付：任务关联 + weighted 进度 + 失败信号（**开发中，未复审未合并**）

- 分支：`dev2/G1b`，基于 `dev2/G1a`（cfef24e）；档位 **B**
- 执行方：dev2；用户 2026-10-25 定「架构已定型，开始开发」
- 范围：关联表 `goal_links`、真实任务状态读取、weighted 进度、失败信号（watch/事件/复核提前）、父子权重

## 已实现

- `packages/core/src/goals/links.ts`（新增）：`linkTask`/`unlinkTask`/`noteTaskFailure`/`recompute`。
  - 关联只接受 `todo`/`coding_task`/`research_topic`；`kind='subgoal'`、`refId='goal:*'` 一律拒绝（子目标只由 `parent_goal_id` 表达）。
  - **任务状态真值只从真实 Store 读**：`TodoStore.get` / `CodingTaskStore.get`。`coding_task` 只有 `completed` 算完成，`pending_accept`（验证通过但用户还没接受）不算。
  - `noteTaskFailed` **只记录真实处于 failed 的编码任务**；任务不是 failed、或没关联到该目标，直接抛错。没有「调用方声称完成/失败」的入口。
  - 失败只写 `watch=1`、`watch_reason`、把 `next_review_at` 提前、记 `task_failed` 事件；**不改状态**。同一次状态观察（同版本号）只记一次事件，避免重复刷。
  - weighted：分母 = 直接任务权重 + 直接子目标 `parent_weight`；分子 = 已完成任务的权重 + 已完成子目标的 `parent_weight`；`round(100×分子/分母)`；分母 0 → 保持原值；manual 只观察事件、不动进度值。
- `goalStore.ts`：加 `link` / `unlink` / `noteTaskFailed` / `recomputeProgress` 四个方法，转调 `links.ts`（G1a 原有逻辑未改）。
- `test/helpers/goalDraft.ts`：改成可按表加载草案 SQL（先跑既有 migrate，再取草案建表语句），**不登记迁移**。

## 自动化通过

```
tsc --noEmit        exit 0
vitest g1b-links-regression.test.ts   9 passed (9)
```

回归覆盖：关联边界（含子目标/`goal:` 前缀/不存在的任务被拒）、真实 coding 任务 `pending_accept` 不算完成而 `completed` 算、3 等权任务 33/67、权重 1:3 → 25、manual 不随任务变化、空目标保持原值、子目标按 `parent_weight` 计一次且内部任务不重复计入、真实 failed 任务的 watch/事件/不重复记、对非 failed 任务报失败被拒、`system` 写 blocked 被拒、proposed 跑完自动跟踪仍 proposed、关连接重开后关联与进度仍在。

**两条真实编码任务用例带保护**：合成库若没有 `projects` 行，用例提前返回（不伪造项目/任务）。也就是说它们在当前 fixture 下**可能是跳过的**，不算真验证过——这条要在有真实项目的库上补跑。

## 没做 / 缺口

- **没有发布正式迁移**（`goal_links` 表由整合方按草案落下）。开发回归靠临时库加载草案 SQL，不等于迁移验收。
- 原 `g1b-goal-links.test.ts` 未改，仍会红。它本身有确定缺陷（已单独记录给整合方）：`add→accept` 重复批准会在真实 TodoStore 抛错；子目标默认 manual 却要求任务完成后进度 100；对 Todo 调 `noteTaskFailed`（Todo 没有 failed 态）、甚至对已 done 的 Todo 假报失败；没覆盖真实 coding 任务。**我没有为了实现去放宽产品行为，也没有加无校验的失败后门。**
- **研究主题（research_topic）的 weighted 完成口径未定**：`research_topics` 没有完成态（只有 Run 有 succeeded/failed，且成功后还会排下一轮）。所以 `recompute` 在遇到研究主题关联时**显式抛错**，不把「一轮成功/暂停/关闭」猜成完成。要整合方先定口径。
- 真机检查、UI 接线、`acceptance.mjs lock`、`done`、合并：**都没做**，也不由执行方做。
- 用户接受：未取得。

## 源码规模

goals 目录合计 493 行（G1a 289 + 本单 204），本单新增 204 行 < 300。
