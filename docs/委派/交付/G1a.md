# G1a 交付：Goal Engine 核心存储（**只推测试**，等整合方锁定）

- 分支：`dev2/G1a`，基于 main `2dcfa45`；档位 **B**（涉及数据库迁移——用户 2026-10-25 定）
- 执行方：dev2
- 状态：**只有测试，没有实现**。按 B 档规矩，测试推上去等整合方看过、在 main 上 `lock` 之后再写实现。
  **我没有 `acceptance.mjs lock`**（那是整合方的关卡）。

## 规格

`docs/委派/G1-GoalEngine-草案.md`（v2，**仍是草案**，等整合方定稿）。用户 2026-10-25 已拍板的设计：
表名 `goals`、不给 `coding_tasks` 加列、`confirmation` 独立于 `origin`、只做 manual+weighted、
`goal_links` 不表子目标、失败不机械判 blocked、Plan Step 独立成表、**G1a/G1b/G1c 都是 B 档，G1e 是 A 档**。

## 这一支交了什么

`packages/core/test/acceptance/g1a-goal-store.test.ts`（约 480 行、22 个 `it`），源码改动 **0 行**。

钉住的接缝（实现要照这个写，改名就等于改契约）：

```ts
migrate(db)                    // goals / goal_events / goal_plans / goal_steps / goal_step_deps
new GoalStore(db)
  .create(input) .get(id) .childrenOf(id)
  .confirm(id, { how, messageId }) .transition(id, to, { decidedBy, reason })
  .setProgress(id, v) .recomputeProgress(id)
  .link(goalId, { kind, refId, weight }) .setRefDone(goalId, { kind, refId }, done)
new PlanStore(db)
  .addVersion(goalId, { reason, assumptions, steps }) .stepsOf(goalId, version)
  .bindStep(...) .setDeps(...) .depsOf(stepId)
  .reorderSteps(goalId, version, idsInOrder)
  .advanceStep(stepId) .finishStep(stepId)
```

## 覆盖的 8 组条件

1. **迁移与表结构**：五张表都在；`goals` 有第一版要的列；**断言没有 evidence/blocking 相关列**（用户定「连字段都不造」）；
   断言 `coding_tasks` / `todos` **没有 goal_id / subgoal_id** 列，且 `coding_tasks.goal`（文本）仍是文本。
2. **origin × confirmation 正交**（用户补充要求）：UI 创建 → `user`/`ui`/`active`；API → `user`/`api`/`active`；
   聊天表达想法 → `agent`/`pending`/`proposed`；**`origin=agent` 能被 `ui` 确认、`origin=user` 也能走 `chat` 确认**；
   再加一条数据库层：手写 SQL 造 `active + pending` 会被 CHECK 拒。
3. **AI 任何路径都改不成 active**：直接 `transition` 抛错且不留事件；重算进度、加重规划跑完仍是 proposed。
4. **状态机与事务回滚**（用户补充要求）：`proposed→completed` 拒、`abandoned→active` 拒、blocked 无理由拒；
   **连续几次非法迁移之后 `goal_events` 一行都没多**；`blocked` 的事件 `decided_by` 只能是 agent/user；
   `blocked→active` 清空理由并记事件。
5. **progress**：manual 下完成任务不改值；weighted 3 等权完成 1 → 33、完成 2 → 67；
   分母 0 保持原值；子目标的任务只算子目标，子目标完成后父按权重只计一次。
6. **Plan Step 稳定 ID 与两阶段重排**（用户补充要求）：
   重排后 **ID 不变、依赖不变、绑定的任务不变**，只有 `seq` 变；行数不变（证明不是删了重建）；
   传重复 id 时整体失败、`seq` 保持原样（事务）；重排不重置状态（doing 跟着走）；
   `goal_plans` **没有 `steps_json` 列**；`advanceStep` 依赖没满足时抛错、满足后进 doing 并写 `started_at`；
   依赖成环被拒。
7. **重启后仍在**：关连接、重开、重读目标/子目标/方案/步骤/依赖/事件全在。
8. **不同目标不串状态**：各自挂任务各自完成互不影响；一个 blocked 不影响另一个。

## 自动化通过

- 这一支是**红的**（`Cannot find module '../../src/goals/index.js'`）——实现还不存在，符合 B 档「先推测试」。
- `node scripts/verify.mjs`：全过（未锁定的测试不进 `run-done` 那一步，见下面输出）。

## 真机通过

没跑。这一支只有测试，真机检查（`scripts/real/g1-goal-engine.mjs`）跟实现那一支一起交。

## 需要整合方在锁定前确认的三件事

1. **`goal_steps.seq` 重排的实现方式**：我要求「两阶段临时序号 + 单事务、不删不重建」（用户定的）。
   测试用「重排后 ID/依赖/绑定不变 + 行数不变」来钉；如果整合方认可，锁定时就照这个。
2. **`setRefDone` 这个测试接缝**：为了在核心层测「任务完成 → 进度变」而不真去建 coding_task，
   我加了一个「把某个引用标成完成」的口子。它只是测试用的状态记录，**不代表真任务的真值来源**——
   真实现里应该以 `todos` / `coding_tasks` 的真实状态为准（G1b 再接线）。这条请整合方审。
3. **`goal_links` 里 `refId: 'goal:<id>'` 表达「子目标在父目标里的权重」**：草案里没写细，
   我用这个约定在测试里算了「子目标完成 → 父按权重计一次」。如果整合方要改成单独一列 `kind='subgoal'`
   （用户说过「goal_links 不要表子目标」，所以不能用 kind），那就得再想；**这条要拍板**。
