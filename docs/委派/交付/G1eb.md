# G1eb Goals 详情页 交付（第二支：详情，只读）

- 分支：`dev/G1eb`，基于 `dev/G1e`（第一支，`01ecbc1`；base 是 `origin/main` `b56516b`）；档位 **A**（用户 2026-10-30 定 G1e 只读）
- 执行方：dev

## 已实现

在第一支的列表页之上加详情页：点目标卡片（或详情里的子目标）进入，显示描述、子目标、当前方案步骤（每步状态，**不能改**）、方案历史（旧版本连同步骤）、关联任务、事件时间线（每条写明 `decided_by`）。主进程只加一个 `getGoalDetail` 读通道，只 SELECT / 读 Store，不写表、不改 `GoalStore` / `PlanStore` / 关联接口。

- `apps/desktop/src/renderer/src/pages/Goals.tsx`（+184 / −9）：详情视图、子目标可点进入、当前方案步骤、方案历史、关联任务、事件时间线；没有输入框和写按钮。
- `apps/desktop/src/main/appRuntime.ts`（+75）：`getGoalDetail(id)` 组装 `GoalSummaryView` + 方案 / 步骤 / 关联 / 事件；关联任务按 `goal_links.kind` 到 `todos` / `coding_tasks` / `research_topics` 读实时标题与状态。
- `packages/contracts/src/ipc.ts`（+26 / −1）：`GoalDetailView`、`GoalPlanView`、`GoalStepView`、`GoalLinkView`，以及 `getGoalDetail` 契约。
- `apps/desktop/src/main/ipc.ts`（+1）、`apps/desktop/src/preload/index.ts`（+1）：注册 / 暴露 `getGoalDetail`（只读）。
- `docs/委派/锁定验收.json`（+9）：登记 `G1eb` 的验收测试指纹。
- `scripts/real/g1e-goals-page.ts`（+51 / −22）：真机检查扩到详情段和「返回列表」；Electron 可执行文件按平台取，不写死 `electron.exe`。
- `scripts/codex-review.mjs`（+7 / −1）：第二支没有自己的规格时，原回退只认「一个数字 + 一个字母」的 id（`U3b`），`G1eb` 这种先去掉 `b` 仍找不到规格的 id 会直接报错。改成逐字往前退，直到找到第一支 / 总规格（`G1eb` → `G1e` → `G1`）。这是跑审查时发现的工具 bug，不涉及产品代码。

源码改动 **新增 287 行、删除 10 行，合计 297 行**（`git diff --numstat dev/G1e` 的 `apps/*/src` + `packages/*/src`；按 Codex 第二轮的口径，删除的改写行也算进 300 行限制）。本支 < 300。

**拆两支**：第一支 `dev/G1e` 只做列表（规格第 30–32、34 条的列表部分），本支做详情（第 33 条、34 条的详情部分）。两支合起来超过 300 行，按 AGENTS 先交列表、再交详情；第二支基于第一支，两个分支、两套锁定测试和交付说明。

## 验收测试

- `apps/desktop/test/acceptance/g1eb-goals-detail.test.ts`（3 条，jsdom 页面）
  - 33：显示描述、子目标、当前方案步骤及状态（不能改）、方案历史（旧版本和旧步骤都能看）、关联任务、事件时间线（`decided_by` 显示成用户 / 模型）。
  - 33：子目标能点进去看它自己的详情（树，不画图；只换数据，不画依赖图）。
  - 34：详情页没有 input / textarea / select / form，也没有确认 / 驳回 / 改 / 推进 / 重规划 / 挂 / 改状态的按钮；只有「返回列表」和子目标。
- `apps/desktop/test/acceptance/g1eb-goals-detail-ipc.test.ts`（2 条，真实 SQLite + 真实 `registerIpc`）
  - 33：详情通道带出描述、子目标、两版方案（旧版步骤仍在）、当前步骤状态 / 依赖 / 绑定的任务、关联任务、事件及 `decided_by`；**对子目标调详情也成功**（不会报「目标不存在」）；已放弃的子目标不列进 `children`（否则点进去会 404）。
  - 34：goals 通道只有 `listGoals` / `getGoalDetail` 两个读接口；打开列表和详情前后 goals 六张表逐行不变；不存在的目标报「目标不存在」。

## 自动化通过

- `node scripts/acceptance.mjs run G1eb`：5 条全过（页面 3 + IPC 2）；第一支 `G1e` 的 7 条照过。
- `node scripts/acceptance.mjs check`：80 个任务、156 个锁定测试指纹都没被改。
- `node scripts/verify.mjs`：**本机没全过**。最后两次重跑都在 `review-needs-lifecycle-ui` 被「默认端口 43191 已被占用」挡住——占用者是用户从资源管理器启动的 `IXAEON.exe`（安装目录版，15:57 启动），按规矩不杀用户的进程。该步之前的 lint / format / typecheck / build / unit / integration / acceptance / 其余 review 都过了；分支 CI 没有这个本机进程，应以 CI 为准。
- GitHub 上的 verify：没看（本支由调度器代推，推送发生在本棒结束之后）。

失败片段（原样）：

```
    Error: IXAEON 默认端口 43191 已被占用：有正在运行的 IXAEON，请先关闭它再跑界面测试（本测试不会动正在运行的服务）
  3 failed
    apps\desktop\test\review\needs-lifecycle-ui-20260908.spec.ts:57:5 › LUI01…
    apps\desktop\test\review\needs-lifecycle-ui-20260908.spec.ts:74:5 › LUI02…
    apps\desktop\test\review\needs-lifecycle-ui-20260908.spec.ts:113:5 › LUI03…
✗ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） 失败（2.0s）
```

## 真机通过

`node scripts/build.mjs && node scripts/real/run-batch.mjs scripts/real/g1e-goals-page.ts`：真 Electron、临时数据目录、合成目标 / 子目标 / 方案 / 待办 / proposed，真实点「目标」→ 详情 → 返回列表 → 重开应用；末行 `RESULT 通过`。脚本输出（临时目录已遮成 `<临时目录>`）：

```
== G1e 真机检查（列表段）==
列表：active 卡片
合成目标：把周报自动化

进行中

进度  42% · 子目标 1 个

下次复核：2026-09-01（已过期）

有疑点

编码任务失败：生成脚本没跑通

下一步：2. 写初稿
过期复核的 class：warn
列表：blocked 卡片
卡住原因：预算还没批
列表：watch
有疑点

编码任务失败：生成脚本没跑通
顶部 proposed 块
AI 觉得你可能想要的目标（待你确认）

合成候选目标：每天读论文

待你确认
有疑点

同一个目标提了两次
界面上的按钮数（导航外）：0
详情页
进行中 进度 42%

每周五自动生成周报，先收集资料再写初稿

子目标
合成子目标：找模板 · 已完成 · 100%
当前方案 v2

1. 收集资料 · 做完

2. 写初稿 · 待做

关联：待办 · 合成待办：找模板 · accepted

3. 收尾 · 待做

方案历史

v1 · 已被取代 · 2026-10-30

第一版太粗

1. 旧步骤

v2 · 当前 · 2026-10-30

拆细一点

1. 收集资料；2. 写初稿；3. 收尾

关联任务

待办 · 合成待办：找模板 · accepted

事件时间线

2026-10-30 · 建立 · 用户

2026-10-30 · 进度 · 用户

2026-10-30 · 方案 · 模型：排了第 1 版方案：第一版太粗

2026-10-30 · 方案 · 模型：排了第 2 版方案：拆细一点
详情页的按钮：返回列表 / 合成子目标：找模板 · 已完成 · 100%
子目标详情
已完成 进度 100%

（没有描述）

子目标

没有子目标

当前方案

还没有方案

方案历史

没有方案历史

关联任务

没有关联任务

事件时间线

2026-10-30 · 建立 · 用户

2026-10-30 · 状态 · 用户
子目标详情点得进去：是
返回列表后详情是否关闭：是
只读：打开列表 / 详情前后 goals 六张表逐行不变
重开应用后列表还在：是；详情还在：是
== G1e 列表 + 详情段真机检查通过 ==
RESULT 通过
```

（真机检查只覆盖界面；G1v 的「应用端到端验收」仍单列，见缺口。）

## Codex 审查（A 档）

- **第一轮（Codex 0.166，2026-10-30 16:00 左右）**：模型容量满（`Selected model is at capacity`），退出码 2，没写出审查文件。按 AGENTS，结论不明按「待审（Codex 额度）」处理。
- **第二轮（Claude 2.1.312 代审，2026-10-30T08:21Z，exit 0）**：结论 **可以合并**。逐条处理：
  - **N+1 / 打开详情先算整个列表（建议）**：不预优化，记缺口；合成数据量小。
  - **子目标 / abandoned 子目标（人工确认）**：**已修**。第一支的 `listGoals` 现在把 `abandoned` 的子目标从 `children` 里滤掉；`getGoalDetail` 对正常子目标能取到（IPC 测试补了「对子目标调详情成功」和「abandoned 子目标不列进 children」）；真机脚本补了「点进子目标详情」并核对。
  - **关联任务不能跳（人工确认）**：规格第 4 节写「能跳过去」，验收条件第 33 条只要求显示；现有路由没有按任务 id 跳转的入口，不新造路由，如实记缺口，交整合方定。
  - **快速连点两个目标时旧结果盖新结果（建议）**：未修；属竞态，现交互下罕见，记缺口。
  - **列表卡片按空格会滚页（建议）**：未修；记缺口。
  - **测试文件行宽 / 末尾换行 / 脚本缩进**：脚本里 `proposed` 两行缩进已对齐；测试文件不在 `format:check` 范围，锁定后不再格式化（会改指纹）；行宽不改。
  - **`scripts/codex-review.mjs` 的规格回退改动（建议单独提交）**：这是跑本支审查时被原逻辑（只认 `U3b` 这种「数字+字母」id）挡住，改成往前退字母；不涉及产品代码。没有单独拆提交，连同本支交整合方过目。
  - **只读日志措辞**：已从「打开列表前后」改成「打开列表 / 详情前后」。
  - **本机 verify / CI**：本机 verify 被用户正在运行的 `IXAEON.exe` 占 43191 挡住（见上，不杀用户进程）；GitHub CI 还没看到，按 AGENTS 不能合并，交整合方。
- **L1**：与第一支相同，未跑，交整合方定。

## 已知缺口

- **L1 没跑**：与第一支相同——L1 需要真实配置的模型和真实对话，本单只有只读详情页；未跑，不冒充。
- **关联任务只能看、不能跳**：规格第 4 节写「关联任务（能跳过去）」，验收条件第 33 条只要求显示。应用现有路由没有「按任务 id 跳到任务页」的入口，本支不新造路由；留给 G1f / G1v 定。
- **已放弃的目标不进详情**：`abandoned` 不在列表，子目标里的 `abandoned` 也不列进 `children`（否则点进去会 404）；直接请求它的详情报「目标不存在」，和列表口径一致，规格没要求看已放弃的目标。
- **快速连点会竞态**：连续很快点两个目标 / 子目标时，先发的请求后返回会盖掉新的；未加序号保护，现数据量下罕见，转 G1v。
- **空格键会滚页**：列表卡片 `onKeyDown` 对空格没有 `preventDefault`，按空格会一边滚一边打开详情；未修，转 G1v。
- **N+1 查询**：每个目标查方案 / 步骤，每步查依赖 / 关联任务；打开详情还会先算整个列表（审查建议按 id 查），合成数据量小，当前不预优化。
- **加载失败**：列表失败只显示错误条，卡片仍是「加载中…」；详情 404 会显示错误条并回列表。属体验瑕疵，转 G1v 看真实使用。
- **关联任务的 status 是任务自己的原值**（如 `accepted` / `completed`），没有另做中文映射；kind 已显示成「待办 / 编码任务 / 研究话题」。
- **研究话题**：只显示 `goal_links` 里 `kind='research_topic'` 的关联；**不读** `research_topics.related_goal_id`（它指向记忆里的目标，不是 `goals` 表），没有把两套「目标」混用。
- **没有写操作**：确认 / 驳回、改步骤、推进、重规划、挂任务都归 G1f（B 档，暂缓）；本支没有为界面新开写 IPC。
- **G1v**：应用端到端验收是独立一单（队列第 137 行），本支的真机检查不冒充 G1v。

## 用户接受

未发生（用户用过并认可之后才写）。