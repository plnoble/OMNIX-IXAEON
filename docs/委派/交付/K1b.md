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
- 改动文件与行数（`git diff --stat origin/main`；源码改动 296 行 = 新增 291 + 删除 5，未超 300）：
 
```text
 apps/desktop/src/main/ipc.ts                       |  81 +++++++++
 apps/desktop/src/preload/index.ts                  |   2 +
 apps/desktop/src/renderer/src/api.ts               |   2 +
 apps/desktop/src/renderer/src/pages/Projects.tsx   | 197 ++++++++++++++++++++-
 apps/desktop/src/renderer/src/ui.tsx               |   2 +-
 .../test/acceptance/k1-project-import-page.test.ts | 197 +++++++++++++++++++++
 packages/contracts/src/ipc.ts                      |  12 ++
 scripts/real/k1-project-import.spec.ts             | 153 ++++++++++++++++++
 8 files changed, 641 insertions(+), 5 deletions(-)
```

和规格不一样 / 规格没写死的地方：

- 选文件复用了现有的 `pickFiles('documents')`（过滤器本来就带 `.json`），没有为「项目清单」新开一种对话框类型；一次只接受一个文件，多选或非 `.json` 直接报错、不进预览。
- 预览凭证是这一支新加的主进程内存票据（和现有恢复预览的 `previewToken` 同一思路），规格没有规定 IPC 形状；这样做保证渲染层不能改预览结果、也不能自己报路径。
- 拆支原因和 300 行上限见 [K1.md](K1.md)「已实现」。

## 验收测试（v2 规格任务）

`apps/desktop/test/acceptance/k1-project-import-page.test.ts`，5 个 `it`，对应界面契约（规格的 8 条验收条件全在 K1）：

| 测试 | 对应 |
| --- | --- |
| 标题栏有按钮；选了清单先弹预览，条数、无效原因都在 | 界面契约：标题栏按钮、预览内容；条件 1 的「确认前不变」在界面上表现为只调预览、不调 apply、列表不重读 |
| 取消：不写入，列表不刷新 | 契约：点「确认导入」后才写入 |
| 确认导入：按预览凭证写入、刷新列表、显示结果 | 契约：确认后刷新列表 |
| 确认失败（凭证过期）：关掉失效预览、显示原因 | 契约：凭证 5 分钟有效；失败后不能重复点确认 |
| 选到的不是 JSON：报错，不调预览 | 契约第 1 条：选一个 JSON 文件 |

## 自动化通过

- 第 1 轮审查前的旧记录（当时测试 4 条）：`node scripts/acceptance.mjs run K1b`（本支树，锁定 1 个文件）：

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

- 当前版本（5 条，第 2/3 轮审查后）`node scripts/acceptance.mjs run K1b`：

```text
 ✓ |acceptance| apps/desktop/test/acceptance/k1-project-import-page.test.ts (5 tests)

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- 当前版本的 `node scripts/verify.mjs`：`EXIT=0`，日志 `.logs/k1b-verify-final.log`；lint / format / local-user / typecheck / build / unit / integration / acceptance-lock / acceptance / 各 review 套件全过（acceptance 148 个文件 1189 条）。

- 分支 CI：run 41074930915（提交 `18b786b`）第一次红在 `l6-launcher.test.ts` 清理临时目录时的 EPERM（与本支无关），`gh run rerun 41074930915 --failed` 后 success（2026-10-30T15:21:36Z）。第 1 轮审查后的新提交由调度器推上去后还要再跑一次 CI；本支已按「最多三轮」转整合方，合并由整合方看新 CI 决定。

## 真机通过

`scripts/real/k1-project-import.spec.ts`，Playwright 拉真实 Electron，`IXAEON_DATA_DIR` 临时目录，5 条合成清单（A 改归档、B 不变、C/D 新增、E 的 status 不合法）；文件选择走主进程的对话框替身（`IXAEON_TEST_DIALOG_RESPONSES`），用户真实清单没读、没进仓库。

命令与输出原样（2026-10-31 01:20 在审查修改后的最终树上重跑，`IXAEON_ELECTRON_NO_SANDBOX=1`）：

```text
node apps\desktop\node_modules\@playwright\test\cli.js test -c scripts\real\playwright.real.config.ts k1-project-import.spec.ts

Running 1 test using 1 worker

  ✓  1 scripts\real\k1-project-import.spec.ts:49:1 › K1 真机：5 条合成清单预览、确认导入、项目页刷新 (2.1s)

  1 passed (2.7s)
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

**第 1 轮 Codex 审查（2026-10-31 00:41）：退出码 1，4 条必须改，已全部改完并重新锁定测试（见下方「第 1 轮 Codex 审查」）。** 在这之前 2026-10-30 的几次重跑都只撞额度（退出码 3），记录如下：

2026-10-30 22:20（第 51 棒）重跑一次，仍然退出码 3：Codex 额度用完，脚本改用 Claude 代审，Claude 也没额度。分支没有新改动，队列状态保持「待审（Codex 额度）」；原样输出在 `.logs/k1b-codex-round1.log`（只在本机，未提交）。

2026-10-30 22:30（第 52 棒）再重跑一次，仍退出码 3。这次 Codex 自己给出的恢复时间是 2026-10-31 00:35（原文 `You've hit your usage limit … try again at Oct 31st, 2026 12:35 AM`），Claude 也仍然没有额度。审查前照上一棒的做法，把同号的旧单 `K1-技能受控对照验证表单.md` 临时改名，让脚本取到 `K1-项目清单导入.md`，跑完已还原（`git status` 干净，仓库脚本一个字没改）。分支没有新改动，队列状态保持「待审（Codex 额度）」；原样输出在 `.logs/k1b-codex-round1b.log`（只在本机，未提交）。

2026-10-30 22:35（第 53 棒）再重跑一次，仍退出码 3：Codex 额度用完，脚本改用 Claude 代审，Claude 也没额度（同上一棒，恢复时间未变）。这次仍照第 52 棒的做法临时改名钉住委派单，`--dry-run` 确认指向 `K1-项目清单导入.md` 后才跑，跑完已还原（`git status` 干净）。分支没有新改动，队列状态保持「待审（Codex 额度）」；原样输出在 `.logs/k1b-codex-round2.log`（只在本机，未提交）。

同一棒把第一支并进了 main：`dev/K1` 的 CI 绿（run 41069876174，success，12m29s），在操作目录 `git merge --no-ff origin/dev/K1`、`node scripts/acceptance.mjs done K1`，main 上的 `node scripts/verify.mjs` `EXIT=0`（日志 `ops/.logs/k1-merge-verify.log`）。**下一棒重跑审查时，`origin/main` 已经含第一支**：先把 `origin/main` 并进 `dev/K1b`（分支已经推过，用 merge 不用 rebase），审查用 `--base origin/main` 就等价于「只看第二支自己的改动」（对照 `dev/K1` 会把并进来的 main 改动也算成这一支的）。

2026-10-30 22:47（第 54 棒）按上面说的先把 `origin/main` 并进 `dev/K1b`（分支已推过，用 merge 不用 rebase，合并提交 `6c2651a`；只带入 main 上的队列行、`K1.md` 两行和锁清单一条，K1b 自己的源码和测试没动）。随后仍照第 52 棒的做法临时改名钉住委派单（`--dry-run` 确认「委派单：docs/委派/K1-项目清单导入.md」、上下文 61006 字），跑 `node scripts/codex-review.mjs K1b --base origin/main`，仍退出码 3：Codex 额度用完（恢复时间仍是 2026-10-31 00:35），脚本改用 Claude 代审，Claude 也没额度。队列状态保持「待审（Codex 额度）」；原样输出在 `.logs/k1b-codex-round3.log`（只在本机，未提交）。

**审查脚本取委派单的坑（下一棒重跑前要看）：** `scripts/codex-review.mjs` 的 `findOrder('K1b')` 会往前退成 `K1` 再取 `readdirSync` 找到的第一个 `K1-*.md`。`docs/委派/` 下同时有另一件同号的旧单 `K1-技能受控对照验证表单.md`，在本机它排在前面，直接用原命令会把委派单解析错（`--dry-run` 显示「委派单：docs/委派/K1-技能受控对照验证表单.md」）。这次审查用一份临时副本把委派单钉成 `K1-项目清单导入.md` 才跑（副本已删，仓库脚本一个字没改）。额度恢复后重跑要么先确认 `--dry-run` 指向的是 `K1-项目清单导入.md`，要么请整合方把两件同号文件错开/让脚本按队列行取单。

第一支 `dev/K1` 的三轮审查（Claude 代审、最终「可以合并」）见 [K1-Codex审查.md](K1-Codex审查.md)；那三轮只审核心 + K1 的测试，不含这一支的界面、IPC 和真机脚本。

### 第 1 轮 Codex 审查（2026-10-31 00:41，退出码 1：需要修改）

Codex 0.166.0 审出 4 条「必须改」，已逐条处理（审查原文见 [K1b-Codex审查.md](K1b-Codex审查.md) 和本工作目录 `.logs/k1b-codex-round4.log`，后者只在本机）：

1. **archived 文案**：规格说界面上显示为「放弃」，共用映射原来写「归档」。`apps/desktop/src/renderer/src/ui.tsx` 改成「放弃」；界面测试锁成「进行中 → 放弃」。
2. **已有项目的清单备注没显示**：`planProjectImport` 的 `update` / `unchanged` 不带 `note`（新增条目才带）。`previewProjectImport` 另返回按项目名查的备注字典 `notes`，弹窗把变化行和不变行的备注都显示出来；测试加了这两行的备注断言。`note` 仍不入库。
3. **预览凭证没有过期清理**：原来只判断过期，不删除，取消后的整份 JSON 留到进程退出。加了到期定时器（`unref`）从主进程删除；交付说明原来「只等到过期」的写法也改正。
4. **大文件同步读主进程**：先 `stat` 限 2 MB，再用 `fs/promises` 异步读，读不了 / 太大 / JSON 不合法分别给人话。

改完重跑：`node scripts/acceptance.mjs run K1b` 4/4、`tsc --noEmit` 0、`node scripts/verify.mjs` 全过（见下一节）。测试改严后重新 `lock` 了 K1b。

### 第 2 轮 Codex 审查（2026-10-31 01:02，退出码 1：需要修改）

1 条「必须改」：预览超过 5 分钟后确认，凭证已失效，失败处理却保留弹窗和凭证、重新启用「确认导入」，再点必然失败；错误还只渲染在弹窗外。已改：`confirmImport` 失败时关掉预览、清掉 notes / token并显示原因；新增第 5 个测试锁住「确认失败后弹窗和确认按钮都没了、原因可见」。

### 第 3 轮 Codex 审查（2026-10-31 01:09，退出码 1：需要修改）

Codex 0.166.0 的两条「必须改」都在交付说明，不在实现：

- 它按「新增 + 删除」算源码改动 303 行，超 300；交付还写「294 行」。已删掉 4 行注释（不改变行为），现在源码改动 296 行（291 新增 + 5 删除），交付统计同步成 296。
- 交付还把 4/4 的旧输出当最终结果，实际测试已经 5 条。已保留旧记录并标明时间，追加当前 5/5 的验收输出和最终 `verify.mjs`（见下）。
- 建议（不是必须改）：`notes` 用项目名直接索引普通对象，项目名恰为 `__proto__` 时会拿到继承属性。这一条没做：项目名要恰好是 `__proto__` 才会发生，属于刻意构造；要加固的话，主进程用 `Object.create(null)`、界面用 `Object.hasOwn` 即可。

**按 AGENTS.md「最多审三轮」：第三轮仍是「需要修改」，不再重审，转整合方。** 分支状态改「待复审（整合方）」，不合并不 `done`；上面两条必须改已处理完，最终 `verify.mjs` 全过。

## 已知缺口

- 预览凭证留在主进程内存、5 分钟过期；到期有定时器删除，取消预览不会留到进程退出。
- 预览后到确认前库若被别人改，界面只显示实际写入数（`apply` 按确认时的库重算），不另提示差异；规格没要求。
- 清单文件上限 2 MB；更大的清单不支持（规格没写上限，这是为了不阻塞主进程）。
- 对话框复用了 `documents` 类型，过滤器里除 `.json` 也能看到 md/txt；选错会报「请选择一个 .json 清单文件」，不会读。
- 条件 7 的同名项目处理与数据库 `name UNIQUE` 的关系见 [K1.md](K1.md)「已知缺口」。

## 用户接受

未发生（用户用过并认可之后才写）。

## 整合方复审（2026-10-31，第 56 棒）

**结论：并入 main。** 三轮审查的「必须改」都已处理；逐行读了 IPC、预览弹窗和真机脚本，路径只经票据、`note` 不入库、确认时按当时的库重算、只用 `ProjectService` 写库，和规格一致。第 3 轮那条「建议」整合方顺手做了，另外发现一处真问题一起改。

### 整合方已改（本次合并提交）

- **备注对不上大小写不同的项目名**（真问题）：`planProjectImport` 按项目名不分大小写匹配，但 `notes` 原来按清单里的写法当键、界面按库里的名字查——清单写 `foo`、库里是 `Foo` 时，「不变 / 变化」行的备注就丢了。改成主进程按 plan 里匹配到的项目、用**库里的名字**当键给备注（`apps/desktop/src/main/ipc.ts` 的 `importNotes`）。
- **原型上的键**（第 3 轮的建议）：主进程 `notes` 用 `Object.create(null)`；界面只认 `notes` 自己的键（`Projects.tsx` 的 `noteOf`）。原来项目名叫 `constructor` / `toString` 时会把原型上的函数当备注渲染（React 报「Functions are not valid as a React child」，留一个空的备注）。
- 源码改动合计仍是 300 行（新增 295 + 删除 5），没超。

### 补的测试（已重锁 K1b）

- `k1-project-import-page.test.ts` 加第 6 条「项目名叫 constructor / toString、清单没给备注：预览里不显示备注」。变异检查：把 `Projects.tsx` 换回开发方原版，这条变红（`expected <span class="muted"></span> to be null`）；换回改后的版本 6/6 过。
- 真机脚本 `scripts/real/k1-project-import.spec.ts` 加两处断言：清单里 B 写成 `合成项目b`（大小写和库里不同）带备注，预览「不变」一栏要显示这条备注；导入后 A 的 `description` 仍是库里原来的（条件 8）。

### 自动化通过

- `node scripts/acceptance.mjs run K1b`：6/6 过。
- `node scripts/verify.mjs`（合并后的最终树，`done K1b` 之前）：全部通过——lint、format、local-user、typecheck、typecheck-acceptance、build、unit 69、integration 483（17 跳过）、acceptance-lock（82 个任务 158 个文件）、acceptance 148 个文件 1189 条、各 review 套件。

### 真机通过（整合方亲手在最终版本上跑，先 `node scripts/build.mjs`）

```text
node apps\desktop\node_modules\@playwright\test\cli.js test -c scripts\real\playwright.real.config.ts k1-project-import.spec.ts

Running 1 test using 1 worker

  ✓  1 scripts\real\k1-project-import.spec.ts:49:1 › K1 真机：5 条合成清单预览、确认导入、项目页刷新 (2.3s)

  1 passed (2.8s)
```

看了预览截图（`.logs/k1-preview.png`，合成数据）：「新增 2 个、变化 1 个、不变 1 个、无效 1 个」；A「进行中 → 放弃」；B 那行显示「清单备注 B」；E 进无效、原因写 status 不合法；底部说明「只登记项目名、目录和状态…」。

### 新发现、没改的缺口

- 项目卡片上的操作按钮还写「归档」，状态标签已经是「放弃」——同一个状态两种叫法。按钮文字不在这一单的 300 行里改（改了就超），留作后续小单。

### 四样分开

- 已实现：是（K1 + K1b，并入 main）。
- 自动化通过：是（上面）。
- 真机通过：是，合成清单、临时数据目录（上面）。
- 用户接受：未发生。