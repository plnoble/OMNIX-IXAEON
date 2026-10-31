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
- 真机检查：**已补**（见下节「真机通过」）；UI 接线、`lock`、`done`、合并：都没做，也不由执行方做。
- 用户接受：未取得。

**本机完整门禁（2026-10-27 复跑，串行）**：`node scripts/verify.mjs` → **全部通过**。

⚠️ 过程中有一次假红，如实记录：我曾**并行**跑两个分支的 verify，
`packages/core/test/integration/performance.test.ts` 的「批量导入 50k 条消息」双双重测超时
（37.688s > 30s 门限）。单独重跑该用例 **5.6s 通过**，串行 verify 全过——是 CPU 争抢，不是回归。

本单只新增真机脚本与文档，未改任何源码或测试。

## 真机通过（2026-10-27 补，**通过**）

`node scripts/real/run-batch.mjs scripts/real/g1b-goal-links.ts` → **exit 0，16 项全过**。
真实 SQLite 文件 + 草案 SQL（不登记迁移、不替代迁移验收），脚本已提交 `scripts/real/g1b-goal-links.ts`。

重点：**统筹 §4.3 的加权规则被真实数据验证**——子目标内部 weight=100 的任务**完全不进父目标分母**
（父目标 = 33），子目标 `completed` 后才按 `parent_weight=3` 计入**一次**（父目标 = 83），
父目标只认自己那 2 条直接链接（不递归、不重复计数）。

```
===== scripts/real/g1b-goal-links.ts =====
== G1b 真机检查：Goal↔Task 关联与 weighted progress（真实 SQLite）==
✓ TodoStore.add 直接是 accepted — status=accepted
✓ 刚绑定时进度 0 — progress=0
✓ 完成权重 2 的任务后进度 67（2/3） — progress=67
✓ 状态没变时 recompute 不重复记 progress 事件 — 1→1
✓ 子目标自己算到 100 — progress=100
✓ 子目标内部任务不进父目标分母（子目标未 completed 时只计 parent_weight=3） — progress=33
✓ 子目标 completed 后按 parent_weight 计入父目标一次 — progress=83
✓ 父目标只认自己的直接链接（2 条） — links=2
✓ 用 refId="goal:xxx" 表达子目标被拒（须用 parent_goal_id）
✓ 同一 Todo 可同时服务多个 Goal（不被独占） — distinct_goals=2
✓ 对没有失败态的 Todo 报失败被拒（不造后门）
✓ Goal 仍 active（失败观察不机械转 blocked） — status=active
✓ 未定的 research_topic 关联被拒（不猜完成口径）
✓ 解绑未完成任务后进度上升（分母变小） — 83→100
✓ 重启后父目标进度保持 — progress=100
✓ 重启后子目标关系还在
== 真机检查通过（G1b 段）==
===== 汇总 =====
```

被真实代码纠正的两处（我脚本写错，不是代码错）：

1. `TodoStore.add` 直接返回 `accepted`，不是 `proposed`；
2. 「同一 Todo 挂第二个 Goal」不能用「进度下降」断言——t1 早已完成，挂上去 total 与 done 各 +1，
   进度仍是 100。改成查 `goal_links` 的 distinct goal 数 = 2。

**应用端到端 / UI 接线：仍未跑**（与 G1a 同因：`packages/core/src/index.ts` 未再导出 `goals/`）。

## 源码规模

goals 目录合计 493 行（G1a 289 + 本单 204），本单新增 204 行 < 300。

## 整合方复审（2026-10-29）

**结论：通过，并入 main。** B 档关卡（锁测试、写迁移、合并、`done`）由整合方做；用户 10-29 点名的「研究话题会让重算整体失败」合并前修掉了。

**整合方做的：**

1. **正式迁移第 40 号 `goal-links`**：照草案 §3.2 建 `goal_links` 和索引，`kind` 只许 todo / coding_task / research_topic。回归测试和真机脚本改用正式迁移，不再从草案里抽 SQL。
2. **修实现（用户 10-29 定的口径，合并前必修）**：`links.ts` 的 `recompute` 原来遇到研究话题整体抛错——挂一个研究话题，整个目标的进度就算不出来。改成研究话题可以挂、不进 weighted 的分子分母、不读它的状态（研究话题没有完成态）；给研究话题「记失败」仍然被拒。改动 9 行。**独立验收**：验它的两条测试是在改之前写好、并确认是红的；改完变绿；变异检查把它改回去会红；真机检查也改成验这条口径（见下）。
3. **第一次把验收测试对着实现真跑**：`g1b-goal-links.test.ts` 之前没跑过（分支上没迁移），一跑 10 条红，全是测试的毛病，照实现和用户口径改：
   - 造待办用了 `add` 再 `accept`（`add` 建出来就是 accepted），改成 `propose → accept`；
   - 子目标没设 weighted，重算当然不动它；
   - 五条「失败」对待办调 `noteTaskFailed`——待办没有失败状态，实现照「以真实 Store 为准」拒了（实现对）。改成用真实的编码任务、真的置成 `failed`，失败原因来自任务自己的 `error`。
4. **开发回归测试里两条一直在空跑**：`g1b-links-regression.test.ts` 里用真实编码任务的两条，开头「库里没有项目就 `return`」，新库本来就没有项目，所以从来没执行过（而且 `scope: []` 真跑会被拒）。改成真建一个合成项目、给一个合成的可修改范围，两条现在真跑、都过。
5. **锁定前补了 6 条**：研究话题挂着照样算进度、不进分子分母（1 / 2 → 50，算进去会是 14）；只挂研究话题时分母为 0、进度保持原值；编码任务「验证通过待接受」不算完成、用户接受（`completed`）才算；任务没真失败（待办、排队中的编码任务）记失败被拒；`goal-links` 这一号迁移相对 `goals-core` 只多 `goal_links` 一张表、`kind` 的 CHECK 拦非法值；手填进度的目标重算后值不变（变异检查漏出来的）。
6. **变异检查**：实现和迁移上改坏 15 处，抓到 14 处；没抓到的「不查 `goal:` 前缀」是等价的——按这个编号去读待办会因为不存在而被拒。

### 自动化通过

- `g1b-goal-links`（20 条）、`g1b-links-regression`（9 条，含原来空跑的 2 条）全过，两份一起锁定为 G1b；G1a 的测试照过。
- 本机账户名检查、`tsc`、验收测试类型检查、lint 过；分支 CI 结果见并入提交。

### 真机通过

`node scripts/real/run-batch.mjs scripts/real/g1b-goal-links.ts`（临时数据目录、合成数据、正式迁移）：全过，末行「== 真机检查通过（G1b 段）==」；输出里没有本机路径。研究话题那一步原来挂的是**不存在**的话题，「被拒」是因为话题不存在、没验到口径；改成挂真实话题（先让进度到 100，研究话题要是进了分母会掉到 17），把实现故意改回「进分母」时这一项会红。

### 用户接受

未发生：G1 还没有界面。

### 留给整合方 / 用户的一处观察（不挡 G1b）

研究话题自己的 `related_goal_id` 指向的是**记忆里 `type='goal'` 的条目**，不是 G1 新建的 `goals` 表——项目里现在有两套「目标」。G1 和记忆里的目标怎么对应（要不要互相引用、界面上算不算同一个东西），G1e / M1 动手前要定。
