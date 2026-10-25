# G1a 交付：Goal 核心（`goals` + `goal_events` + `GoalStore`）—— **本轮仅整理验收边界，无实现**

- 分支：`dev2/G1a`，基于 main `0f9deda`；档位 **B**（涉及数据库迁移）
- 执行方：dev2
- **本轮只做三件**：按用户 2026-10-25 的要求把 G1 的验收边界重新切开、把 G1a 砍到只剩 Goal 核心、
  把 Plan 那组测试整体迁到 G1c。**没有写任何实现**，也**没有 `acceptance.mjs lock`**。

## 这一轮改了什么（按用户九条）

### 1. G1a 砍到只剩 Goal 核心

`packages/core/test/acceptance/g1a-goal-store.test.ts`（重写，约 380 行、19 个 `it`）。只碰：

- 表：`goals`、`goal_events`——**并断言 `goal_links` / `goal_plans` / `goal_steps` / `goal_step_deps` 一张都不许有**
  （防止 G1a 把后面几单的表一起建了）；
- 接口：`GoalStore` 的 `create` / `get` / `childrenOf` / `confirm` / `transition` / `setProgress` / `list`。

保留了用户点名要的：origin × confirmation 正交、UI/API 创建可 active、proposed 不能被 AI 激活、
chat/ui/api 三种确认、状态机、`blocked_reason`/`decided_by`、**非法迁移事务回滚不残留 `goal_event`**、
manual progress、`progress_mode=weighted` 允许保存但 G1a 不算、parent/child（含 `parent_weight`）、
重启后仍在、不同 Goal 不串、`coding_tasks`/`todos` 结构完全不改。

新增一条：`GoalStore` 上**不许有 `recomputeProgress`**（那是 G1b 的活）——用 `undefined` 断言钉住。

### 2. 删掉 `setRefDone` 这个产品接口

G1a 的测试里**不再有任何「标记任务完成」的后门**。G1b 的测试改成**用真实的 `TodoStore`**：真的 `add` → `accept`
→ `complete`，再去算进度。任务状态的真值来源永远是 `TodoStore` / `CodingTaskStore` / `ResearchTopicStore` 自己。

### 3. weighted progress 全部移到 G1b

`packages/core/test/acceptance/g1b-goal-links.test.ts`（新，约 300 行、13 个 `it`）：`goal_links`、
读真实任务状态、`task_done`/`task_failed` 事件、weighted 进度、`watch`/`watch_reason`、`next_review_at`。
G1a 不再要求「3 个任务完成 1 个 = 33%」。

### 4. 子目标权重改用 `goals.parent_weight`

草案里 `goals` 加了列：

```sql
parent_weight INTEGER CHECK (parent_weight IS NULL OR parent_weight > 0) DEFAULT 1
```

根目标可为 NULL、子目标默认 1、非 NULL 时必须 > 0（测试里断言传 0 / 负数被拒）。
**不再用 `refId='goal:xxx'` 这种绕法**——G1b 的测试里明确断言 `kind='subgoal'` 和 `refId='goal:abc'` 都会被拒。

G1b 计算父目标 weighted 进度的规则（测试里钉住）：
直接任务按 `goal_links.weight`；直接子目标「完成」后按 `parent_weight` 计一次；
**子目标内部的任务不直接重复计入父目标**（有专门一条测试：子的任务完成时父目标进度仍是 0）。

### 5. Plan / Step 整体迁到 G1c

`packages/core/test/acceptance/g1c-goal-plans.test.ts`（新，约 330 行、11 个 `it`）：
`goal_plans` / `goal_steps` / `goal_step_deps` / `PlanStore` / `reorderSteps` / `advanceStep` / 依赖 / 成环拒绝 /
Step ID 稳定 / **两阶段 seq 重排**——原来 G1a 里那几条**一条没删，整组搬过去**。

用户补充的重排要求全在：重排后 **ID 集合、依赖、任务绑定、行数都不变**（证明不是删了重建），只有 `seq` 变；
传重复 id → 整体失败、`seq` 保持原样（单事务）；重排不重置状态。

**G1a 的测试里已经没有任何方案表或 `PlanStore` 的引用。**

### 6. 「AI 不能激活 proposed」分层测试

| 层  | 怎么测                                                                   |
| --- | ------------------------------------------------------------------------ |
| G1a | 直接 `transition(proposed → active, decidedBy='agent')` 必须拒且不留事件 |
| G1b | 自动跟踪 / 进度重算 / `noteTaskFailed` 跑完，proposed 仍是 proposed      |
| G1c | `replan` / `advanceStep` 跑完，proposed 仍是 proposed                    |
| G1d | 模型识别只能创建 proposed（那一单的测试，本轮没写）                      |

### 7. G1e 没写

按用户要求，等 G1a 的测试经整合方复审并锁定之后，再按 A 档做 G1e 的测试 + 实现。**现在没有提前钉 UI 数据接口。**

### 8. 文档修正（`docs/委派/G1-GoalEngine-草案.md`）

- 第 5 节重写：**按单切分**，每单一张表说明「只允许引用的表 / 接口」；验收条件共 32 条按单编号。
- 第 7 节：档位改成 **G1a=B、G1b=B、G1c=B、G1d=B、G1e=A**（用户定）；加了「每单必须能独立锁定、独立实现」。
- 第 9 节：从「还给整合方定的事」改成「**已定案**」——`seq` 可重排、Step ID 永久不变、单事务、
  两阶段临时序号避免 UNIQUE 冲突、**不允许删除重建 Step**；子目标权重用 `parent_weight`；
  任务真值来源永远是任务自己的 Store。

## 自动化通过

- `g1a` / `g1b` / `g1c` 三个文件**都是红的，错因都是 `Cannot find module '../../src/goals/index.js'`**
  ——实现还不存在，符合 B 档「先推测试」。
- `node scripts/verify.mjs`：**见下**（未锁定的测试不进 `run-done`，既有的门禁不受影响）。

## 真机通过

没跑。这一支只有测试；真机检查跟实现那一支一起交。

## 已知缺口 / 留给整合方锁定时拍板

1. **测试接缝的命名**：`GoalStore.link` / `noteTaskFailed` / `PlanStore.addVersion` / `reorderSteps` /
   `advanceStep` / `setStepStatus` / `bindStep` / `setDeps` / `finishStep` 这些名字是测试钉死的，
   实现必须照写；如果整合方觉得哪个名字不合适，锁定时改测试（**这是 B 档整合方的权力，我不改**）。
2. **`noteTaskFailed` 的定位**：它是「把某个任务失败的事实告诉目标」的入口，不负责判断（不做 blocked）。
   谁在什么时机调它（自动跟踪接线）属于 G1b 实现细节。
3. **`g1b` 里 `noteTaskFailed` 传了 `reason`**：测试里用来验证 `watch_reason` 会带上任务号；
   如果实现想让 `watch_reason` 只列任务号、理由另存，锁定时一起定。

---

# 第二轮整理（dev2，2026-10-25 晚，仍只改测试与草案，无实现）

用户指出：第一轮里 G1a 钉了几条「当前阶段还没有」的否定断言，会把 G1b/G1c 的正常演进锁死。
本轮按用户六条要求把「当前还没做」与「永久不许做」分开，只锁后者。

## 删掉的三条（属于「当前还没有」，未来必须允许出现）

1. **G1a**：`goal_links` / `goal_plans` / `goal_steps` / `goal_step_deps`「一张都不许有」的断言 —— **删**。
   G1b/G1c 合并后这些表本来就该存在。改成只正向断言 G1a 自己的两张表在、能读能写。
2. **G1a**：`GoalStore.recomputeProgress` 必须 `undefined` —— **删**。G1a 自己不调用它即可，
   G1b 可以合法地在这个类上加能力。
3. **G1c**：`goal_links` 不许存在 —— **删**（同样是「当前还没有」）。

三处都留了注释写明「故意不断言，锁死会挡演进」。

## 保留的永久约束（第 3 条要求，全部核实仍在）

- `coding_tasks` / `todos` **不加** `goal_id` / `subgoal_id` / `plan_version`（g1a、g1b 各一处）；
- `coding_tasks.goal` 仍是「目标描述文本」，不能被占用成外键；
- `goal_links.kind` 不许 `subgoal`、不许 `refId='goal:xxx'` 偷渡子目标（g1b）；
- `goal_plans` 没有 `steps_json` 列，Step 是权威结构（g1c）；
- 重排后 Step **ID 集合、依赖、任务绑定、行数都不变**（g1c，用户定的两阶段重排）。

## 第 4 条：三份测试的否定断言逐条过了一遍

| 文件 | 行       | 断言                                                                | 判定                   |
| ---- | -------- | ------------------------------------------------------------------- | ---------------------- |
| g1a  | L116-118 | `coding_tasks`/`todos` 无 `goal_id`/`subgoal_id`/`plan_version`     | **永久约束，留**       |
| g1a  | 若干     | `blocked_reason`/`confirmed_by_message_id`/`parent_goal_id` 为 NULL | 状态机行为，留         |
| g1b  | L103-104 | `todos` 无 `goal_id`/`plan_version`                                 | **永久约束，留**       |
| g1b  | —        | `kind='subgoal'`、`refId='goal:abc'` 被拒                           | **永久约束，留**       |
| g1c  | L88      | `goal_plans` 无 `steps_json`                                        | **永久约束，留**       |
| g1a  | 原       | 「四张 G1b/G1c 表不许有」                                           | 当前阶段限制，**已删** |
| g1a  | 原       | `recomputeProgress` 必须 undefined                                  | 当前阶段限制，**已删** |
| g1c  | 原       | `goal_links` 不许有                                                 | 当前阶段限制，**已删** |

## 第 5 条：草案 3.6 的旧描述已改

原文「子目标 `completed` 时按它在父目标 `goal_links` 里的权重计一次」是 v1 遗留。
改成：**直接子目标完成后按子目标自身的 `parent_weight` 计入直接父目标一次；子目标内部的任务不重复计入父目标**；
并写明分母 = 直接任务权重（`goal_links.weight`）+ 直接子目标的 `parent_weight`。

## 测试计数（prettier 重排后按 `it(` 数）

- `g1a-goal-store.test.ts`：**22 个 it**
- `g1b-goal-links.test.ts`：**14 个 it**
- `g1c-goal-plans.test.ts`：**12 个 it**

三个文件仍是红的，错因都是 `Cannot find module '../../src/goals/index.js'`（实现还不存在）。
`node scripts/verify.mjs`：全过（未锁定测试不进 `run-done`）。

## 本轮没做的

没写实现、没 `acceptance.mjs lock`、没 `done`、没做 G1e。
