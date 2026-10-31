# G1c 交付：Plan 多版本 + 可操作 Plan Step（**开发中，未复审未合并**）

- 分支：`dev2/G1c`，基于 `dev2/G1a`（cfef24e）；档位 **B**
- 执行方：dev2；用户 2026-10-25 定「架构已定型，开始开发」
- 范围：`goal_plans` / `goal_steps` / `goal_step_deps`、`PlanStore`、多版本、两阶段重排、依赖与推进

## 已实现

- `packages/core/src/goals/planTypes.ts`（新增）：`StepStatus` / `StepLink` / `Plan` / `PlanStep` / `AddVersionInput` 类型。
- `packages/core/src/goals/plans.ts`（新增，约 240 行）：`PlanStore`
  - `addVersion`：版本号自增；把上一版标 `superseded` + `superseded_by`，**旧版本的行一个字不删**；新版本步骤按传入列表建 `seq=1..n`、`pending`；记 `plan` 事件；**不改 Goal 状态**。
  - `stepsOf` / `plansOf` / `getPlan`：读；步骤按 `seq` 排序。
  - `bindStep`：绑定已有任务（先校验任务真存在），`kind` 限三类。
  - `setDeps`：整体替换某步依赖；自依赖、跨版本引用、成环都拒绝（递归检测）。
  - `reorderSteps`：**单事务两阶段**——先把本版所有步骤挪到 `max(seq)+n+1` 之上的**正数**临时区，再回填 `1..n`。全程不删行、不动 `id`，也不违反表上的 `CHECK(seq > 0)` 与 `UNIQUE(goal_id, plan_version, seq)`。非法列表（重复/缺失/外来 id）在写入前就抛错。
  - `setStepStatus` / `advanceStep` / `finishStep`：推进只改内部步骤状态；`advanceStep` 要求 `pending` 且依赖都已 `done`/`skipped`，写 `started_at`；`finishStep` 要求 `doing`，写 `ended_at`。
  - **历史版本只读**：所有写操作都先校验版本仍是 `current`，否则抛错。
- `test/helpers/goalDraft.ts`：同 G1b（按表加载草案 SQL，不登记迁移）。
- **没有发布正式迁移**；**没有接 UI/API/模型**；**不启动真实任务**（步骤推进不驱动任何执行器）。

## 自动化通过

```
tsc --noEmit                          exit 0
vitest g1c-plans-regression.test.ts   8 passed (8)
```

回归覆盖：第二版让旧版变 `superseded` 且旧行逐行不变、同一时刻只有一版 `current`、重规划不改 Goal 状态；历史版本的改状态/推进/收尾/绑定/设依赖/重排六种写全部被拒且快照不变；重排后 ID 集合、依赖、绑定、行数、状态都不变（用 `BEFORE DELETE` 触发器证明**没有删除重建**，用 `BEFORE UPDATE OF seq` 触发器证明**过程中每个 seq 都为正**）；非法重排三种输入整体失败且 `seq`/id 不变；用触发器在第二阶段写入时抛错，验证**整笔回滚**；依赖未完成不能推进、完成后能推进并写 `started_at`、成环被拒；proposed 目标排方案/改步骤/推进之后仍 `proposed`，且 `todos`/`coding_tasks` 一行没被创建；关连接重开后多版本、步骤、依赖都在。

## 没做 / 缺口

- **没有发布正式迁移**（三张方案表由整合方按草案落下）。
- 原 `g1c-goal-plans.test.ts` 未改，仍会红。已核出的缺陷（交整合方）：
  1. 它建完 v2 之后去 `advanceStep` **v1 的步骤**却期望成功，与「历史只读」直接冲突——我没有为了让这条过而放开历史写；
  2. 绑定的 `ct-1`/`td-9` 是假 ID，我的 `bindStep` 会校验真实任务存在，所以那条会失败；
  3. 它只断言终态，证明不了「两阶段/不删重建/中途回滚」，这些我在开发回归里补了；
  4. 草案 3.8.5 说 replan 要**复制**旧步骤与依赖，但测试传的是全新 `steps`。「复制 / 替换 / 两者如何组合」还没定义——我**只实现了显式传入 steps 的入口**，没自行发明复制接口。
- **自动复制模式（replan 继承旧步骤）未实现**，等整合方定语义。
- 真机检查：**已补**（见下节「真机通过」）；UI 接线、`lock`、`done`、合并：都没做，也不由执行方做。
- 用户接受：未取得。

**本机完整门禁（2026-10-27 复跑，串行）**：`node scripts/verify.mjs` → **全部通过**。

⚠️ 过程中有一次假红，如实记录：我曾**并行**跑两个分支的 verify，
`packages/core/test/integration/performance.test.ts` 的「批量导入 50k 条消息」双双重测超时
（37.688s > 30s 门限）。单独重跑该用例 **5.6s 通过**，串行 verify 全过——是 CPU 争抢，不是回归。

另：G1c 首次串行 verify 红在 relay 的 `l5-init` / `l6-prompt`（各跑 136s+ 才失败，它们要真克隆 git）；
单独重跑这两个文件 **7/7 通过（47.96s）**，第二次串行 verify 全过——属联网/负载偶发。
本单只新增真机脚本与文档，未改任何源码或测试。

## 真机通过（2026-10-27 补，**通过**）

`node scripts/real/run-batch.mjs scripts/real/g1c-goal-plans.ts` → **exit 0，30 项全过**。
真实 SQLite 文件 + 草案 SQL，脚本已提交 `scripts/real/g1c-goal-plans.ts`。

重点（§5 里最容易做成假动作的几条，全部实测）：

- **重排不是删了重建**：行数 3→3 不变、ID 集合不变、顺序真变了、Step 状态与 `started_at` 未被重置、
  task 绑定与依赖都还在；
- 旧版永久保留、v2 产生后 v1 → `superseded` 且 `superseded_by=2`、同 Goal 只有一版 current；
- 历史版本只读（对 v1 的 pending 步骤 advance 被拒）；
- `advanceStep`：依赖未完成拒绝；满足后 pending→doing 且写 `started_at`；
- Replan 不改 Goal 状态；给 proposed 目标排方案**不会激活它**；重启后两版并存。

```
===== scripts/real/g1c-goal-plans.ts =====
== G1c 真机检查：Plan/Step/Replan（真实 SQLite）==
✓ v1 版本号为 1 — version=1
✓ v1 是 current — status=current
✓ v1 有三步 — n=3
✓ seq 从 1 递增 — 1,2,3
✓ 每步都有稳定 id
✓ 新步骤状态是 pending
✓ 依赖写入成功
✓ 依赖没完成时 advanceStep 被拒
✓ 第一步推进后是 doing — status=doing
✓ 推进时写了 started_at
✓ finishStep 后是 done — status=done
✓ 依赖完成后第二步可推进
✓ 重排后行数不变 — 3→3
✓ 重排后 ID 集合不变
✓ 重排后顺序真的变了
✓ 重排后 Step 状态没被重置
✓ 重排后 task 绑定没丢
✓ 重排后依赖没丢
✓ v2 版本号为 2 — version=2
✓ v2 是 current
✓ v1 被标 superseded — status=superseded
✓ v1 的 superseded_by 指向 2 — superseded_by=2
✓ v1 的历史步骤行还在（旧版永久保留）
✓ 同一 Goal 只有一版 current — current=1
✓ 历史版本不可推进（只读）
✓ Replan 没改 Goal 状态（仍 active） — status=active
✓ 给 proposed 目标排方案不会把它激活 — status=proposed
✓ 重启后 v2 仍是 current
✓ 重启后 v1 的 3 步还在
✓ 重启后 v2 的 1 步还在
== 真机检查通过（G1c 段）==
===== 汇总 =====
```

被真实代码纠正的一处（我脚本写错）：`bindStep` 会校验任务真实存在，
原来用假 ID `'synthetic-todo-id'` 被正确拒绝——改用真 TodoStore 建的任务。

**应用端到端 / UI 接线：仍未跑**（同上）。

## 源码规模

本单新增 281 行（`plans.ts` + `planTypes.ts`），< 300。

## 整合方复审（2026-10-30）

**结论：通过，并入 main。** B 档关卡（锁测试、写迁移、合并、`done`）由整合方做。

**整合方做的：**

1. **正式迁移第 41 号 `goal-plans`**：照草案 §3.3 建 `goal_plans`、`goal_steps`、`goal_step_deps` 和索引；`goal_plans` 没有 `steps_json`（步骤是权威结构），`goal_steps` 保留 `seq > 0` 与「同一版本内 seq 唯一」两条约束。回归测试和真机脚本改用正式迁移，不再从草案里抽 SQL（回归测试原来连 `migrate` 都没跑）。`goals/index.ts` 补导出 `PlanStore` 和方案类型，给以后的界面用。
2. **用户 10-29 的决定，核对一致**：重规划必须写理由、必须显式给出至少一个新步骤，不从旧版本复制；旧版本被取代后只读。实现本来就是这样，草案 §3.8 第 5 条已改。
3. **修实现（规格第 24 条）**：`setStepStatus` 原来能直接把一步设成 `doing`，绕过「依赖没完成不能开始」的检查（`advanceStep` 有这个检查）。改成设 `doing` 时同样查依赖；两处共用一个 `unfinishedDeps`。改动 15 行，源码合计 291 行，仍在 300 以内。**独立验收**：验它的测试是在改之前写好、确认是红的；改完变绿；变异检查把它改回去会红。
4. **第一次把验收测试对着实现真跑**：3 条红，都是测试的毛病——两条拿编出来的任务号（`'ct-1'`、`'td-9'`）去挂步骤，实现会查任务是否真实存在（对），改成真建待办和编码任务；一条在建了第 2 版之后去推进第 1 版的步骤，历史方案只读（对），改成推进当前版本。
5. **锁定前补了 7 条**：挂编出来的任务号被拒；`goal-plans` 这一号迁移相对 `goal-links` 只多三张方案表；重规划不给步骤被拒、新版本的步骤就是给的那几条；旧版本被取代后改状态 / 推进 / 挂任务 / 写依赖 / 重排都被拒、旧步骤逐行不变；依赖没完成时 `setStepStatus` 也不能设 `doing`；重规划不写理由被拒；数据库拦同一版本内重复的 `seq`（后两条是变异检查漏出来的）。
6. **变异检查**：实现和迁移上改坏 14 处，补测后 14 处都抓到。

### 自动化通过

- `g1c-goal-plans`（18 条）、`g1c-plans-regression`（6 条）全过，两份一起锁定为 G1c；G1a、G1b 的测试照过。
- 本机账户名检查、`tsc`、验收测试类型检查、lint 过；分支 CI 结果见并入提交。

### 真机通过

`node scripts/real/run-batch.mjs scripts/real/g1c-goal-plans.ts`（临时数据目录、合成数据、正式迁移）：全过，末行「== 真机检查通过（G1c 段）==」；其中「历史版本不可推进（只读）」「Replan 没改 Goal 状态」「给 proposed 目标排方案不会把它激活」三项对应用户定的规矩；输出里没有本机路径。

### 用户接受

未发生：G1 还没有界面（G1e）。

### 留给后面的（不挡 G1c）

- **方案和步骤的事件一律记成 `decided_by='agent'`**：用户在界面上重规划、改步骤时，其实是用户做的。G1e 做界面时，入口要带上「谁做的」，事件照实记。
- **两套「目标」**（见 G1b 交付说明末尾）：研究话题的 `related_goal_id` 指向记忆里 `type='goal'` 的条目，不是 `goals` 表。G1e / M1 动手前要定怎么对应。
