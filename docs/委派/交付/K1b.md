# K1b 从清单导入（桌面入口）交付

- 分支：`dev/K1b`，基于 `dev/K1` `8fd9810`；档位 A
- 执行方：dev
- 第一支：`dev/K1`（契约 + 核心），见 [K1.md](K1.md)；队列里仍然只有 K1 一行

## 已实现

这一支交规格最后一条界面契约的入口，核心计算用 K1 的 `planProjectImport` / `applyProjectImport`。

- `packages/contracts/src/ipc.ts`：加 `previewProjectImport({ ticket })` → `{ token, preview }`、`applyProjectImport({ token })` → `{ created, updated }` 两条 IPC 类型。
- `apps/desktop/src/main/ipc.ts`：
  - 预览只消费 `pickFiles` 的导入票据、从主进程按票据读 JSON（渲染层不接触授权路径），`planProjectImport` 只算不写；清单原件留在主进程内存，返回一次性 `token`（5 分钟有效）。
  - 确认时消费 token，按**当时**的库重新算一遍再 `applyProjectImport`（不照旧预览盲写）；写一条 `project.imported` 审计。
  - 选到的不是 `.json`、JSON 解析失败都报人话；不点确认不写库。
- `apps/desktop/src/preload/index.ts`、`renderer/src/api.ts`：接上两条方法。
- `renderer/src/pages/Projects.tsx`：项目页标题栏加「从清单导入」；选文件 → 预览弹窗（新增 / 变化 / 不变 / 无效的条数，各条名字、状态变化、无效原因和 `note`）→「确认导入」后写入、刷新列表、显示「新增 N 个项目，更新 N 个状态」；取消什么都不写。
- `scripts/real/k1-project-import.spec.ts`：真机检查脚本（Playwright + 真实 Electron，临时数据目录 + 5 条合成清单）。
- 改动文件与行数（`git diff --stat dev/K1`，含新文件；源码 241 行）：

```text
 apps/desktop/src/main/ipc.ts                       |  52 +++++-
 apps/desktop/src/preload/index.ts                  |   2 +
 apps/desktop/src/renderer/src/api.ts               |   2 +
 apps/desktop/src/renderer/src/pages/Projects.tsx   | 180 ++++++++++++++++++++-
 .../test/acceptance/k1-project-import-page.test.ts | 173 ++++++++++++++++++++
 packages/contracts/src/ipc.ts                      |  10 ++
 6 files changed, 414 insertions(+), 5 deletions(-)
```

和规格不一样 / 规格没写死的地方：

- 选文件复用了现有的 `pickFiles('documents')`（过滤器本来就带 `.json`），没有为「项目清单」新开一种对话框类型；一次只接受一个文件，多选或非 `.json` 直接报错、不进预览。
- 预览凭证是这一支新加的主进程内存票据（和现有恢复预览的 `previewToken` 同一思路），规格没有规定 IPC 形状；这样做保证渲染层不能改预览结果、也不能自己报路径。
- 拆支原因和 300 行上限见 [K1.md](K1.md)「已实现」。

## 验收测试（v2 规格任务）

`apps/desktop/test/acceptance/k1-project-import-page.test.ts`，4 个 `it`，对应界面契约（规格的 8 条验收条件全在 K1）：

| 测试 | 对应 |
| --- | --- |
| 标题栏有按钮；选了清单先弹预览，条数、无效原因都在 | 界面契约：标题栏按钮、预览内容；条件 1 的「确认前不变」在界面上表现为只调预览、不调 apply、列表不重读 |
| 取消：不写入，列表不刷新 | 契约：点「确认导入」后才写入 |
| 确认导入：按预览凭证写入、刷新列表、显示结果 | 契约：确认后刷新列表 |
| 选到的不是 JSON：报错，不调预览 | 契约第 1 条：选一个 JSON 文件 |

## 自动化通过

- `node scripts/acceptance.mjs run K1b`（本支树，锁定 1 个文件）：

```text
 ✓ |acceptance| apps/desktop/test/acceptance/k1-project-import-page.test.ts (4 tests) 699ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- `node scripts/verify.mjs`（K1 + K1b 最终树的同一条命令）：`EXIT=0`，逐项全绿；完整日志在本工作目录 `.logs/k1b-final-verify.log`，尾部：

```text
  ✓ local-user（提交的文件里没有本机的账户名） — 0.3s
  ✓ typecheck（tsc --noEmit） — 8.3s
  ✓ typecheck-acceptance（已完成任务的验收测试也过 tsc） — 7.0s
  ✓ build（desktop / mcp / extension） — 9.0s
  ✓ unit（Vitest 单元测试） — 3.8s
  ✓ integration（Vitest 集成测试） — 25.6s
  ✓ acceptance-lock（锁定的验收测试没被改） — 0.1s
  ✓ acceptance（已完成任务的锁定验收测试） — 246.3s
  ✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） — 3.3s
  ✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） — 4.4s
  ✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） — 2.6s
  ✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） — 2.7s
  ✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） — 3.5s
  ✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） — 2.9s
  ✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） — 4.1s
  ✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） — 2.8s
  ✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） — 2.2s
  ✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） — 2.5s
  ✓ review-p2（P2 受控实验与安全回滚 5 项） — 2.1s
  ✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） — 2.1s
  ✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） — 2.1s
  ✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） — 5.5s
  ✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） — 2.8s
  ✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） — 3.4s
  ✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） — 2.9s
  ✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） — 2.2s
  ✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） — 2.2s
  ✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） — 6.8s
  ✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） — 6.1s
  ✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） — 6.8s
  ✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） — 6.8s
EXIT=0
```

- GitHub 上的 verify：本棒不推（调度器替推），没看；推送后由下一棒看 CI 再合并。

## 真机通过

`scripts/real/k1-project-import.spec.ts`，Playwright 拉真实 Electron，`IXAEON_DATA_DIR` 临时目录，5 条合成清单（A 改归档、B 不变、C/D 新增、E 的 status 不合法）；文件选择走主进程的对话框替身（`IXAEON_TEST_DIALOG_RESPONSES`），用户真实清单没读、没进仓库。

命令与输出原样（在最终提交的 `dev/K1b` 树上重跑）：

```text
node apps\desktop\node_modules\@playwright\test\cli.js test -c scripts\real\playwright.real.config.ts k1-project-import.spec.ts

Running 1 test using 1 worker

  ✓  1 scripts\real\k1-project-import.spec.ts:49:1 › K1 真机：5 条合成清单预览、确认导入、项目页刷新 (2.0s)

  1 passed (2.5s)
```

脚本里另外断言了：

- 预览条数 `新增 2 个、变化 1 个、不变 1 个、无效 1 个`，无效原因含 `status 不合法`；
- 预览阶段 `listProjects()` 还是 3 个（引导项目 + A + B，没有新增）；
- 确认后 A=`archived`、B=`paused`、C=`active`、D=`paused`、E 不存在，结果行是「新增 2 个项目，更新 1 个状态」。

截图（合成数据，落 `.logs/`，已 gitignore）：

- 预览弹窗：`.logs/k1-preview.png`
- 导入后的项目页：`.logs/k1-after.png`

注：在接力调度器起的 DSH 里跑时，`IXAEON_ELECTRON_NO_SANDBOX=1` 会让脚本把 Electron 的 TEMP/APPDATA 指到工作区并加 `--no-sandbox`（工作区 Electron 是 Low IL，写不进系统的临时目录；见 `docs/委派/交付/L14.md`）。用户平时直接跑不加这个变量。

## Codex 审查（A 档）

**这一支还没审。** 2026-10-30 这一棒本机 Codex 和 Claude 的额度都用完了（`node scripts/codex-review.mjs K1b --base dev/K1` 退出码 3），按 AGENTS.md 分支先等着，队列状态改「待审（Codex 额度）」；额度恢复后重跑同一命令，再把结论写进 `K1b-Codex审查.md`。

第一支 `dev/K1` 的三轮审查（Claude 代审、最终「可以合并」）见 [K1-Codex审查.md](K1-Codex审查.md)；那三轮只审核心 + K1 的测试，不含这一支的界面、IPC 和真机脚本。

## 已知缺口

- 预览凭证留在主进程内存、5 分钟过期；取消预览不立即清（只等到过期），没有外部影响，只是内存里多一条。
- 预览后到确认前库若被别人改，界面只显示实际写入数（`apply` 按确认时的库重算），不另提示差异；规格没要求。
- 对话框复用了 `documents` 类型，过滤器里除 `.json` 也能看到 md/txt；选错会报「请选择一个 .json 清单文件」，不会读。
- 条件 7 的同名项目处理与数据库 `name UNIQUE` 的关系见 [K1.md](K1.md)「已知缺口」。

## 用户接受

未发生（用户用过并认可之后才写）。