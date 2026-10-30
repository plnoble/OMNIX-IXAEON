# G1eb Goals 详情页 交付（第二支：详情，只读）

- 分支：`dev/G1eb`，基于 `dev/G1e`（第一支，`a79068a`；base 是 `origin/main` `6b0cbfb`）；档位 **A**（用户 2026-10-30 定 G1e 只读）
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
- `node scripts/verify.mjs`：**本机全过**（2026-10-30 20:12–20:18 在最终树重跑，`EXIT=0`；19:55 那次也全过。端口空出来后真 Electron 的四步也过了）。此前 15:58 那次卡在 `review-needs-lifecycle-ui`：用户正在运行的 `IXAEON.exe` 占着 43191，按规矩不杀用户的进程；失败原文保留在下面。
- GitHub 上的 verify：没看（本支由调度器代推，推送发生在本棒结束之后）。

验证记录（2026-10-30 20:12–20:18，原样）：

```
  ✓ lint（ESLint） — 11.2s
  ✓ format:check（Prettier） — 4.3s
  ✓ local-user（提交的文件里没有本机的账户名） — 0.3s
  ✓ typecheck（tsc --noEmit） — 8.6s
  ✓ typecheck-acceptance（已完成任务的验收测试也过 tsc） — 8.4s
  ✓ build（desktop / mcp / extension） — 9.3s
  ✓ unit（Vitest 单元测试） — 4.0s
  ✓ integration（Vitest 集成测试） — 24.9s
  ✓ acceptance-lock（锁定的验收测试没被改） — 0.1s
  ✓ acceptance（已完成任务的锁定验收测试） — 243.0s
  ✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） — 3.2s
  ✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） — 4.1s
  ✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） — 2.5s
  ✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） — 2.8s
  ✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） — 3.6s
  ✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） — 3.4s
  ✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） — 4.2s
  ✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） — 2.8s
  ✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） — 2.3s
  ✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） — 2.5s
  ✓ review-p2（P2 受控实验与安全回滚 5 项） — 2.2s
  ✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） — 2.1s
  ✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） — 2.2s
  ✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） — 5.7s
  ✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） — 2.9s
  ✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） — 3.4s
  ✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） — 2.9s
  ✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） — 2.2s
  ✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） — 2.2s
  ✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） — 6.7s
  ✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） — 5.7s
  ✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） — 6.6s
  ✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） — 6.4s
全部通过（IXAEON v0.2 验证完成）
```

15:58 那次失败片段（原样保留）：

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

本支一共跑了四轮，其中第 1 轮没有结论，实际审查三轮：

- **第 1 轮（Codex 0.166，2026-10-30 16:04 左右）**：模型容量满（`Selected model is at capacity`），退出码 2，没写出结论。按 AGENTS，结论不明；原始输出在 `.logs/review-g1eb.log`（未提交）。
- **第 2 轮（Codex，16:14，exit 1）**：4 条「必须改」——关联任务不能跳、交付说明的 verify 表述与事实矛盾、L1 未跑、源码按「新增 + 删除」算 307 行超 300。处理：
  - **关联任务跳转**：**不同意 / 未做**。规格第 4 节写「能跳过去」，验收条件第 33 条只要求显示；现有路由没有按任务 id 跳转的入口，不新造路由，如实记缺口，交整合方定。
  - **交付说明**：按实际 verify 结果改写（当时本机卡在用户正在运行的 `IXAEON.exe` 占 43191），保留失败原文。
  - **L1**：**不同意**，理由同第一支（见 `G1e.md`「Codex 审查」）：只读页面没有模型凭据，不能用脚本模型冒充真模型聊三轮；L1 未跑如实记缺口。
  - **300 行**：按「新增 + 删除」计 287 + 10 = 297 行，在限内；交付说明已注明口径。
- **第 3 轮（16:21，Codex 额度用完，Claude 2.1.312 代审，exit 0）**：结论 **可以合并**。按建议修了三处：第一支 `listGoals` 把 `abandoned` 子目标从 `children` 滤掉、IPC 测试补「对子目标调详情成功」、真机脚本补「点进子目标详情」并核对；N+1、竞态、空格滚页记缺口。
- **第 4 轮（16:29，Claude 代审，exit 1）**：结论 **需要修改**，只剩 1 条「必须改」：交付说明写「脚本里 `proposed` 两行缩进已对齐」，实际仍顶格，属说明不实。已改齐两行缩进；同时采纳建议：真机脚本的 `childOk` 改成查子详情特有的「已完成 进度 100%」（原来只查父详情里也有的子目标按钮，等于空过），两个新测试补末尾换行并重新 `lock`；重跑真机检查，`RESULT 通过`。其余建议（N+1、竞态、空格滚页、`scripts/codex-review.mjs` 的规格回退单独提交）仍记缺口 / 交整合方。

审查已到 AGENTS 的「最多审三轮」：实际第三轮仍判「需要修改」，不再跑下一轮。**本支不合并，交整合方复审**；第一支同样交整合方。审查文件是最后一轮（16:29）的输出，结论为「需要修改」（[G1eb-Codex审查.md](G1eb-Codex审查.md)）。

## 已知缺口

- **L1 没跑**：与第一支相同——L1 需要真实配置的模型和真实对话，本单只有只读详情页；未跑，不冒充。
- **审查未达一致**：实际审查三轮，最后一轮仍判「需要修改」（L1 和关联任务跳转两条分歧），按 AGENTS 的三轮上限不再审，本支不合并，交整合方定。
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