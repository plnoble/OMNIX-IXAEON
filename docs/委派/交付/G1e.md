# G1e Goals 列表页 + 详情页 交付（第一支：列表）

- 分支：`dev/G1e`，基于 `origin/main` `6b0cbfb`（rebase 后）；档位 **A**（用户 2026-10-30 定 G1e 只读）
- 执行方：dev

## 已实现

按用户 2026-10-30 的决定，G1e **只读**：列表页没有任何确认 / 驳回 / 改步骤 / 推进 / 重规划 / 挂任务的控件，主进程只开一个 `listGoals` 读通道。写操作归 G1f（B 档，暂缓）。

- `apps/desktop/src/renderer/src/pages/Goals.tsx`（新增 115 行）：Goals 列表页；顶部单独一块只显示 `proposed` 并标「待你确认」（带 `watch` 的也标出疑点及原因）；主列表显示标题、状态、进度、子目标数、下次复核（过期加 `warn` 标黄）、`watch` 疑点及原因、`blocked_reason`、下一步（当前方案第一个依赖已满足的 `pending` 步骤）。
- `apps/desktop/src/renderer/src/App.tsx`（+12）：导航「目标」和页面挂载。
- `apps/desktop/src/main/appRuntime.ts`（+54）：`listGoals()` 用 `GoalStore.list` / `PlanStore.plansOf` / `stepsOf` / `depsOf` 组装只读视图；只 SELECT，不调用任何写接口。
- `packages/contracts/src/ipc.ts`（+26）：`GoalSummaryView` 与 `listGoals()` 契约；没有写方法。
- `apps/desktop/src/main/ipc.ts`（+2）、`apps/desktop/src/preload/index.ts`（+2）：只注册 / 暴露 `listGoals`。
- `packages/core/src/index.ts`（+2）：把 `GoalStore` / `PlanStore` 及其只读类型导出给主进程用（不改 Store 接口）。
- `docs/委派/锁定验收.json`（+9）：登记本支验收测试指纹。

**拆两支**：本支只做列表（规格第 30–32、34 条的列表部分）；详情页（第 33 条、34 条的详情部分）在 `dev/G1eb`，基于本支，交付说明写 `G1eb.md`。原因：把详情页一起放进同一支会超过 300 行；按 AGENTS「超过 300 行必须拆」，先交列表、再交详情。

源码改动合计 **213 行**（`git diff --numstat` 的 apps/*/src + packages/*/src 新增行）：

```
 apps/desktop/src/main/appRuntime.ts        |  54
 apps/desktop/src/main/ipc.ts               |   2
 apps/desktop/src/preload/index.ts          |   2
 apps/desktop/src/renderer/src/App.tsx      |  12
 apps/desktop/src/renderer/src/pages/Goals.tsx | 115
 packages/contracts/src/ipc.ts              |  26
 packages/core/src/index.ts                 |   2
```

## 验收测试

- `apps/desktop/test/acceptance/g1e-goals-page.test.ts`（4 条，jsdom 页面）
  - 30：列表显示 active 标题、状态、进度、下次复核；过期复核带 `warn` 标黄。
  - 31：blocked 卡片直接显示 `blocked_reason`；`watch` 单独标出并显示 `watch_reason`（列表卡片和顶部 `proposed` 块各一条）。
  - 32：`proposed` 在顶部单独一块只显示、标「待你确认」；没有确认 / 驳回按钮。
  - 34：界面上没有 input/textarea/select/form，也没有改目标 / 方案 / 步骤 / 关联的按钮。
- `apps/desktop/test/acceptance/g1e-goals-page-ipc.test.ts`（3 条，真实 SQLite + 真实 `registerIpc`）
  - 30/31：列表数据来自真实 `goals` 表（进度、复核时间、`blocked_reason`、`watch`、子目标、下一步）。
  - 30：靠前的 pending 步骤依赖没满足时，下一步取后面第一个可做的 pending（实现若忽略依赖会选错，测试会红）。
  - 34：`goals` 相关通道只允许读（`listGoals`、第二支的 `getGoalDetail`），并显式禁止 `confirm` / `reject` / `create` / `update` / `set` / `link` / `unlink` / `replan` 等写通道；连续浏览前后六张表逐行不变。

## 自动化通过

- `node scripts/acceptance.mjs run G1e`：本支 7 条全过（页面 4 + IPC 3）；第二支（详情页）的验收测试另锁。
- `node scripts/verify.mjs`：见下方「验证记录」（2026-10-30 20:02–20:09 在最终树重跑，全过，`EXIT=0`）。
- GitHub 上的 verify：没看（本支由调度器代推，推送发生在本棒结束之后；本机 `verify.mjs` 全过，见下）。

验证记录（2026-10-30 20:02–20:09，原样）：

```
  ✓ lint（ESLint） — 12.6s
  ✓ format:check（Prettier） — 4.4s
  ✓ local-user（提交的文件里没有本机的账户名） — 0.4s
  ✓ typecheck（tsc --noEmit） — 10.0s
  ✓ typecheck-acceptance（已完成任务的验收测试也过 tsc） — 7.7s
  ✓ build（desktop / mcp / extension） — 9.7s
  ✓ unit（Vitest 单元测试） — 4.1s
  ✓ integration（Vitest 集成测试） — 25.2s
  ✓ acceptance-lock（锁定的验收测试没被改） — 0.1s
  ✓ acceptance（已完成任务的锁定验收测试） — 253.1s
  ✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） — 3.5s
  ✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） — 4.6s
  ✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） — 2.8s
  ✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） — 3.0s
  ✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） — 4.2s
  ✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） — 3.3s
  ✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） — 4.6s
  ✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） — 2.9s
  ✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） — 2.5s
  ✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） — 3.2s
  ✓ review-p2（P2 受控实验与安全回滚 5 项） — 2.5s
  ✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） — 2.4s
  ✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） — 2.4s
  ✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） — 9.4s
  ✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） — 5.6s
  ✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） — 4.5s
  ✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） — 3.2s
  ✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） — 2.3s
  ✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） — 2.3s
  ✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） — 8.0s
  ✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） — 6.0s
  ✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） — 6.8s
  ✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） — 6.6s
全部通过（IXAEON v0.2 验证完成）
```

注：`acceptance` 一步只跑已并入任务（locking 状态 `done`）的锁定测试；本任务自己的 `G1e` / `G1eb` 测试由上面 `acceptance.mjs run` 单独跑。

## 真机通过

`node scripts/build.mjs && node scripts/real/run-batch.mjs scripts/real/g1e-goals-page.ts`：真 Electron、临时数据目录、合成目标 / 方案 / 待办，真实点开「目标」页；末行 `RESULT 通过`。脚本输出（临时目录已遮成 `<临时目录>`）：

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
只读：打开列表前后 goals 六张表逐行不变
重开应用后列表还在：是
== G1e 列表段真机检查通过 ==
RESULT 通过
```

## Codex 审查（A 档）

三轮都是 Codex 本尊审的（没用到 Claude 代审）：

- **第一轮（2026-10-30 15:33，exit 1）**：3 条「必须改」：
  - **#1 `proposed` 块没显示 `watch`（条件 31）**：已改，顶部 `proposed` 卡片也标「有疑点」并显示 `watch_reason`；页面测试补了「proposed + watch」的断言。
  - **#2 下一步测试可能空跑**：原测试里第一个 pending 步骤的依赖恰好已满足，实现忽略依赖也能过。已补 IPC 测试：第一个 pending 依赖没满足、第二个可做，`nextStep` 必须是第二个；改坏实现会红。
  - **#3 L1 证据（三轮聊天记忆 + 办成一件事）**：**不同意**，理由：
    1. G1e 的验收条件是规格第 5 节第 30–34 条，没有 L1；规格第 8 节给这一单的界面检查是「临时数据目录、合成数据点一遍」，已跑（见下）。
    2. L1 要真实配置的模型和真实对话；本单是只读目标页，没有模型凭据，也不能拿脚本模型冒充真模型聊三轮（AGENTS：「模拟工具不等于真实接入」）。
    3. G1a / G1b / G1c 的交付说明也没有 L1（都写「G1 还没有界面」），整合方当时照常并入；把 L1 当每单必须，会让所有无模型的任务都过不了。
    4. 本单在「已知缺口」里如实写「L1 未跑」，不冒充。
- **第二轮（15:46，exit 1）**：3 条「必须改」：真机脚本用 `确认\n` 判断只读会误判（已改成按实际按钮数判断并重跑）、交付说明与事实矛盾（已改，见「自动化通过 / 真机通过」）、L1 仍未跑（同上）。
- **第三轮（15:48，exit 1）**：结论仍是「需要修改」，只剩 L1 一条；原始意见见 [G1e-Codex审查.md](G1e-Codex审查.md)。

三轮都判「需要修改」；按 AGENTS「最多审三轮」，不再审第四轮，本支不合并，队列改待复审（整合方）；G1eb 同批交。

## 已知缺口

- **L1 没跑**：AGENTS 的 L1（连着聊三轮记得住、至少办成一件事）需要真实配置的模型和真实对话；本单只有只读目标页、没有模型凭据，合成脚本模型不能冒充。未跑，如实写在这里，交整合方 / G1v。
- **详情页在本支之外**：规格第 33 条（描述、子目标、当前步骤、方案历史、关联任务、事件时间线）在 `dev/G1eb` 做；本支的列表卡片暂时不能点进详情。
- **没有写操作**：按用户 2026-10-30 定，确认 / 驳回、改步骤、推进、重规划、挂任务都归 G1f（B 档，暂缓）。
- **G1v 应用端到端验收**仍是独立一单（第 137 行），本支的真机检查只覆盖列表段，不冒充 G1v。
- 研究话题的 `related_goal_id` 仍指向记忆条目；本支列表不展示、也不混用。

## 用户接受

未发生（用户用过并认可之后才写）。