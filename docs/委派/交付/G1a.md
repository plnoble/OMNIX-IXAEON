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

---

# 开发首批：G1a 内部 GoalStore（用户授权开始开发之后）

> 本节为最新状态；上面的纯测试整理记录保留为历史。**已写核心实现，但不是整单完成、不是已接受。**

## 已实现

- [goalStore.ts](../../../packages/core/src/goals/goalStore.ts)：创建、读取、列表、父子关系、明确用户确认、状态迁移、manual 进度；写入与事件在同一事务内。origin 与 confirmation 独立，用户明确 UI/API 操作可确认 agent 来源的目标；AI 来源本身既不是授权、也不是拒绝用户授权的理由。
- [types.ts](../../../packages/core/src/goals/types.ts) 和 [模块入口](../../../packages/core/src/goals/index.ts)：仅供内部存储使用。不接 UI/API/模型调用，不增加 Goal 任务完成后门，不计算 weighted。watch、watch_reason、next_review_at 未提前进入本单公开类型。
- **没有发布迁移**：[迁移注册](../../../packages/core/src/db/migrations.ts) 与开发前完全一致。本轮早先曾在未提交工作区试加 migration 39，已撤下；编号与正式迁移仍由整合方处理。没有在构造函数里偷偷建表。
- 未改三份原 G1 验收测试、未 lock/done/合并；未改已有任务表、TodoStore、CodingTaskStore；未做 G1d/G1e。

## 自动化验证及适用范围

新增 [开发回归](../../../packages/core/test/acceptance/g1a-core-regression.test.ts) 与 [临时库夹具](../../../packages/core/test/helpers/goalDraft.ts)：夹具先跑既有 migrate，再从已定草案加载 goals/goal_events SQL 到一次性数据库。**不是正式迁移，也不替代原 B 档验收**。

2026-10-25 本机结果（UTF-8 日志留在工作目录 .logs）：

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
exit 0

node node_modules/vitest/vitest.mjs run --project acceptance packages/core/test/acceptance/g1a-core-regression.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
```

回归含真实 ConversationStore 的用户消息、拒绝不存在/assistant 消息、origin×confirmation、两目标隔离、状态机、父子权重存值、重启持久化；用 TEMP TRIGGER 在插入 goal_event 时抛错，验证已执行的 Goal 更新也被回滚（不是仅检验输入拒绝）。不会访问真实用户数据库。

**原验收尚未全过**：原 [G1a 验收](../../../packages/core/test/acceptance/g1a-goal-store.test.ts) 两处聊天确认使用 m-1/m-9，但没有建消息。初次临时迁移试跑为 20/22，另外两条触发 FOREIGN KEY constraint failed。这是夹具问题，不关闭外键、不自动伪造消息、不拿 null 代替确认消息。撤下正式迁移注册后，原验收会因缺 goals 表而失败；须整合方先落迁移并修正夹具，再正式验收。

`node scripts/verify.mjs` 本机完整执行 exit 0（`.logs/g1a-implementation-verify.txt`）。随后去掉新增的同对话确认/已完成后手动进度限制，并补回 proposed 否决需用户的已定规则；末次 typecheck 与开发回归 10/10 通过。源码新增合计 289 行（goals 三个文件），正式迁移注册、根模块导出和旧验收文件均未改。完整门禁在最终提交后再复核，分支 CI 结果另记，不能把其中任一项冒充正式 G1a 验收通过。

## 权限边界与待复审

- GoalStore 是内部可信调用边界。via=ui/api、confirm() 的调用必须由未来已鉴权的用户动作提供，不能把模型自报的字符串当授权。这里验证消息存在且 role=user/status=complete，**不声称已验证聊天正文的批准意图或端到端鉴权**。
- 原 G1a 测试依然要求 watch/next_review_at 列，而用户后来把它们归 G1b；草案 SQL 也尚有旧列。开发夹具原样读取现有草案，不自行改写规格。正式迁移分层由整合方按用户最终要求处理。
- 正式迁移、原验收夹具修订、测试锁定、B 档复审/合并仍未做。核心代码没有被应用调用，所以不是“打开应用即可使用 Goals”。

## 真机通过 / 用户接受

### 核心逻辑真机跑（2026-10-27 补，**通过**）

`node scripts/real/run-batch.mjs scripts/real/g1a-goal-core.ts` → **exit 0，37 项全过**。
真实 SQLite 文件 + 草案 SQL（不登记迁移、不替代迁移验收），**不是内存 mock**。
脚本已提交：`scripts/real/g1a-goal-core.ts`。

覆盖（统筹 §6 组合场景里属于 Goal 核心的那段）：

```
== G1a 真机检查：Goal 核心链路（真实 SQLite 文件 + 草案 SQL）==
✓ 界面亲手建的目标直接 active（via=ui 即用户确认） — status=active
✓ origin 默认 user — origin=user
✓ confirmation 记为 ui — confirmation=ui
✓ confirmed_at 有值
✓ AI 提的目标是 proposed（不是 active） — status=proposed
✓ 它的 origin 记为 agent
✓ confirmation=pending
✓ confirmed_at 为空（还没人确认）
✓ 未经用户确认，proposed 不能直跳 active（AI 无法绕过）
✓ 用户确认后转 active — status=active
✓ confirmation 变成 ui
✓ origin 仍是 agent（两维度正交，确认不改来源）
✓ 子 Goal 的 parent_goal_id 指向父
✓ 子 Goal 的 parent_weight 记录为 0.3
✓ childrenOf 能查到它
✓ active → paused 合法
✓ paused → active 合法
✓ 转 blocked 必须给 blocked_reason（不给就拒）
✓ active → blocked 合法
✓ blocked_reason 被记下 — 需要用户拍板选哪个数据源
✓ blocked → active 合法
✓ 离开 blocked 后 blocked_reason 清空
✓ proposed → paused 被拒
✓ proposed → blocked 被拒
✓ proposed → completed 被拒
✓ active → completed 合法
✓ completed → active 被拒（终态不可复活）
✓ 非法跳级确实抛错
✓ create 自身记了事件 — before=10 after=11
✓ 被拒的 transition 不留事件 — now=11
✓ 被拒后目标状态没被改 — status=proposed
✓ 重启后 Goal 还在
✓ 重启后状态仍是 completed — status=completed
✓ 重启后 origin=user 仍在
✓ 重启后子目标关系仍在
✓ 重启后 AI 提的目标仍是 active+agent
✓ 重启后事件历史还在 — events=6
== 真机检查通过（G1a 段）==
```

**如实说明三条被真实代码纠正的假设**（是我脚本写错，不是代码错）：

1. `via:'ui'` 本身就等于「用户亲手确认」→ 建出来直接 `active`，不必再 confirm；
2. `origin` 的合法值是 `user | agent`（不是 `ai`）；
3. `transition` 签名是 `{ decidedBy: 'user'|'agent'; reason?: string | null }`，且
   `reason` **只对 blocked 必填**——原先把「completed + 空白 reason」当失败场景是错的，
   改用 `proposed → completed`（真会被 `ALLOWED` 表挡下）来验事务原子性。

### 真实应用端到端：**仍未跑**

- UI 与迁移接线未生效；
- 实测 `packages/core/src/index.ts` **没有再导出 `goals/`**（只有测试 import `src/goals/index.js`），
  产品入口尚未接上——所以「在应用里点出目标」这一步确实还跑不了，不是我省略；
- 组合场景其余步骤（Plan/Step、绑真实 Todo、weighted progress、task failure→watch、
  `advanceStep`）属 G1b/G1c，等并入 main 后由组合脚本补，见 §6 依赖。

### 用户接受

**未取得**。开发授权不等于验收接受。

## G1b / G1c 实现前核出的契约缺口（不靠改产品过测）

1. [G1b 夹具](../../../packages/core/test/acceptance/g1b-goal-links.test.ts) add→accept 错误：[TodoStore.add](../../../packages/core/src/storage/todoStore.ts#L57-L73) 已返回 accepted，第二次 accept 必抛错。另一个 child 默认 manual 却期望任务完成后进度100，须夹具显式 weighted。
2. G1b 对 Todo 调 noteTaskFailed，甚至对 done Todo“假装失败”；Todo 无 failed 状态。这与用户要求真实任务 Store 为权威相矛盾，不新增无校验失败后门。
3. [ResearchStore](../../../packages/core/src/research/researchStore.ts) 的 Topic 没有完成态；Run 成功后还会排下一轮。不得把单轮成功、disabled 或 paused 猜成 Topic 完成；研究关联的 weighted 完成口径需整合方明确。
4. [G1c 验收](../../../packages/core/test/acceptance/g1c-goal-plans.test.ts) 在创建 v2 后推进 v1，和历史方案只读冲突。当前版不激活 Goal 与旧版不可变要分开验证，不为该测试允许历史写。
5. G1c 的 seq 有 CHECK(seq>0)，两阶段临时区必须取正数高位，不能用负数/0；“最终 ID/行数不变”也不能证明没有同 ID 删除重插。应在审查验收中补过程约束，不弱化 CHECK。
6. 草案要求 replan 复制原步骤及依赖、绑定，测试却传全新 steps；如何表达“保留/替换/复制”尚未明确。开发不能自行发明接口语义。上述缺口交整合方，不改原测试粉饰通过。
