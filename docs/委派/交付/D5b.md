# D5b 锁定前核心模型核测试 交付（第一支：纯核心 `testReview.ts`）

- 分支：`dev/D5b`，从 `origin/dev2/D5b`（66771dc）起，先 merge `origin/main`（e955572）；档位 **B**
- 执行方：dev
- 第二支：[`dev/D5c`](D5c.md)（基于本支）——`executor.ts` 接线、桌面两处构造、25 条验收测试、真机脚本

## 为什么拆

整合方 2026-10-30 退回：整份实现源码约 354 行（`executor.ts` +220、`testReview.ts` +128、桌面 +6），超过 AGENTS.md 的 300 行上限。拆法照退回意见：

- **本支（D5b）**：`packages/core/src/execution/testReview.ts`——发给核心模型的提示词、`user` 的拼装与截断、把模型回答筛成问题列表、补测试的交代、两次失败的失败原因。**纯函数，没有编排状态机**。
- **D5c**：`executor.ts` 的接线（什么时候核、最多两次、补测试、失败时写报告）与桌面 `appRuntime.ts` 两行；验收测试和真机脚本也在那支。

两支的源码行数：本支 **128 行**；D5c 约 241 行。各自都在 300 行以内。契约、验收条件一个字没改。

## 已实现（本支改了什么）

| 文件                                              | 行数   | 说明                                                                                                                                                                                   |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/execution/testReview.ts`       | 128    | 契约第 3、4、5 条：`REVIEW_SYSTEM` 原文、`reviewUser()`、`cleanProblems()`、`fixTestsBrief()`、`twiceProblemsReason()`                                                                   |
| `packages/core/test/unit/d5b-test-review.test.ts` | 166    | 本支另加的单元测试（12 条）：原文逐字、20000/60000 字上限、越界与空白问题丢掉、两段交代的原文                                                                                          |
| `docs/委派/交付/D5b.md`                           | 本文件 | 交付说明                                                                                                                                                                               |

`git diff --stat origin/main...HEAD`（本支提交后补，不含第二支）：

```
 .../交付/D5b.md                                 |  73 +++++
 packages/core/src/execution/testReview.ts       | 128 +++++++++
 packages/core/test/unit/d5b-test-review.test.ts | 172 ++++++++++
 3 files changed, 373 insertions(+)
```

（源码只有 `testReview.ts` 的 **128 行**；单元测试与交付说明按 AGENTS.md 不计入。）

和整份实现（66771dc）相比，本支只把 `testReview.ts` 与测试拿出来；`executor.ts`、`appRuntime.ts` 和那份 25 条的验收测试文件**在本支的最终树上没有**（它们随 D5c 加回）。中间那一个提交是从 66771dc 的快照里剔除它们，好让第一支单独审、单独量行数。

没有新接口改名、没有新增设置项、没有迁移。`testReview.ts` 不碰数据库、不碰网络、不碰文件系统。

## 验收测试

- 任务的 14 条验收条件写成 25 个 `it`，文件是 `packages/core/test/acceptance/d5b-review-tests.test.ts`，**在第二支 D5c**。那支要接线才跑得动；本支只有纯函数，跑那份会 19 条红。
- 本支的 12 条单元测试只钉 `testReview.ts`：契约第 3 条 `system` 逐字（条件 4 的前半）、`user` 的拼法与 20000/60000 字上限（条件 4、12）、越界/空白 `detail`/不认识的 `kind` 都丢掉（条件 11）、契约第 4 条补测试交代与第 5 条失败原因的原文。
- 本支没有锁任何验收测试：B 档的 `acceptance.mjs lock` 是整合方的关卡。

## 自动化通过

- 本支单元测试：`node node_modules/vitest/vitest.mjs run --project unit packages/core/test/unit/d5b-test-review.test.ts` → **12/12 过**。
- `node scripts/acceptance.mjs run D5b`：**跑不了**。`docs/委派/锁定验收.json` 里还没有 D5b 这一条（25 条验收测试未锁定，本周例外：整合方 11-05 凌晨 4:30 之后才复审合并）。锁定后由整合方登记。
- `node scripts/verify.mjs`：见下面「verify 输出」，本机**全过**。
- 第二支（D5c）上的 25 条验收测试 25/25 过、真机检查甲通过——见 [D5c 交付说明](D5c.md)。

### verify 输出

```
  ✓ lint（ESLint） — 9.0s
  ✓ format:check（Prettier） — 3.8s
  ✓ local-user（提交的文件里没有本机的账户名） — 0.3s
  ✓ typecheck（tsc --noEmit） — 7.8s
  ✓ typecheck-acceptance（已完成任务的验收测试也过 tsc） — 7.2s
  ✓ build（desktop / mcp / extension） — 8.6s
  ✓ unit（Vitest 单元测试） — 4.2s
  ✓ integration（Vitest 集成测试） — 25.9s
  ✓ acceptance-lock（锁定的验收测试没被改） — 0.1s
  ✓ acceptance（已完成任务的锁定验收测试） — 291.0s
  ✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） — 3.5s
  ✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） — 4.5s
  ✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） — 2.8s
  ✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） — 3.1s
  ✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） — 3.7s
  ✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） — 3.2s
  ✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） — 4.4s
  ✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） — 3.0s
  ✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） — 2.4s
  ✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） — 2.7s
  ✓ review-p2（P2 受控实验与安全回滚 5 项） — 2.3s
  ✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） — 2.4s
  ✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） — 2.4s
  ✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） — 6.1s
  ✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） — 2.9s
  ✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） — 3.6s
  ✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） — 3.0s
  ✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） — 2.4s
  ✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） — 2.3s
  ✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） — 7.5s
  ✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） — 6.1s
  ✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） — 6.8s
  ✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） — 6.9s
全部通过（IXAEON v0.2 验证完成）
```

## 真机通过

**本支没跑真机检查，也没法跑。** 规格的真机检查 `scripts/real/d5b-review-tests.ts` 要驱动真的 `CodingOrchestrator`（核 → 补 → 再核 → 锁定 → 实现），要有接线；本支只有纯函数。脚本与甲的输出在 [D5c 交付说明](D5c.md)。乙（真模型网关，花钱）由整合方合并前跑。

## 已知缺口

1. 契约第 4 条「副本绝对路径换成 `<副本>`」发生在调用方（`executor.ts` 的 `askOnce` 用了 `hideWorkspacePath`），本支测不到；它的验收测试在 D5c 条件 4 里。
2. 契约第 6 条末句「错误的话里不带 Key / 地址」也没法在本支测：`testReview.ts` 不接触错误。D5c 交付说明里核过 `ModelError` 的 message 不带 Key / 网关地址。
3. `reviewUser()` 的 60000 字上限按「正文长度」累加，段与段之间的两个换行不计入；规格只写「所有文件合起来超过 60000 字」，差这几个字不影响「后面的文件只写路径」的判定，验收测试条件 12 过。要更严可以改成按最终整段长度算——留给整合方审测试时定。

## 用户接受

未发生。等第二支并入、用户在用的时候试过再写。

---

## 沿革（不改历史，只记一笔）

- 6126923（dev/D5b）：25 条验收测试，B 档先只推测试。
- 66771dc（dev2/D5b）：照用户 2026-10-25 定的「做 D5b」把整份实现写了；源码约 354 行，2026-10-30 被整合方退回拆支。
- 本支从 66771dc 起，只留 `testReview.ts`；实现接线与验收测试见 [D5c](D5c.md)。旧的两份交付说明在 git 历史里（`git show 66771dc:docs/委派/交付/D5b.md`）。