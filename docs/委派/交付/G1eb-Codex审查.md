# G1eb 审查（Codex 额度用完，由 Claude 代审）

- 时间：2026-10-30T08:29:44.761Z
- 分支：dev/G1eb（fcc07dc），对照 docs/委派/G1-GoalEngine-草案.md
- 审查者：Claude（2.1.312）；上下文由脚本喂入（不让审查者跑命令）
- 花费：0.5880228 美元

- 必须改 `docs/委派/交付/G1eb.md`（Codex 审查一节「测试文件行宽 / 末尾换行 / 脚本缩进」那条）＋ `scripts/real/g1e-goals-page.ts:52`、`:210`：交付说明写「脚本里 `proposed` 两行缩进已对齐」，但 diff 里 `const proposed = goals.create({`（52 行）和 `proposedText.includes('同一个目标提了两次') &&`（210 行）仍顶格。说明与实际改动不符，属于交付说明不实。要么把这两行对齐，要么改正说明。
- 建议 `scripts/real/g1e-goals-page.ts:186`：`childOk` 只查 `main` 里有没有「合成子目标：找模板」。父目标详情里的子目标按钮本身就带这几个字，所以没点进子目标也会判「是」。可以改成查子目标详情特有的内容（比如没有子目标、状态是「已完成 进度 100%」），或者核对 `goal-child-*` 已经消失。
- 建议 `apps/desktop/src/renderer/src/pages/Goals.tsx:180-189`：`open` 没有请求序号保护。快速连点两个目标或子目标时，先发的请求如果后返回，会盖掉新的详情；点「返回列表」后旧请求才返回，也会写进 `detail`。交付说明已如实列为缺口，现交互下罕见。
- 建议 `apps/desktop/src/renderer/src/pages/Goals.tsx:252-254`：`role="button"` 的卡片按空格时没有 `preventDefault`，会一边滚页一边打开详情。交付说明已列缺口。
- 建议 `apps/desktop/src/main/appRuntime.ts:2358`：`getGoalDetail` 先算整个 `listGoals()`（每个目标都查方案和步骤），再 `find` 出一条，另外每步还单独查依赖和关联。目标多了以后，每打开一次详情都要同步全量计算、阻塞主进程。可以按 id 取单条摘要。
- 建议 `scripts/codex-review.mjs:98-107`：任务分支改了审查门禁脚本。逻辑本身对（`G1eb → G1e → G1`，遇到非字母结尾就停），但这个工具管所有任务的审查，最好单独提交、由整合方过目，不和产品分支一起合。
- 建议 `apps/desktop/test/acceptance/g1eb-goals-detail.test.ts`、`g1eb-goals-detail-ipc.test.ts` 文件末尾：缺换行（`\ No newline at end of file`）。在重新 `lock` 之前顺手补上即可，属于本分支自己的测试，允许改。
- 需要人工确认：规格第 4 节写「关联任务（能跳过去）」，验收条件第 33 条只要求显示。执行方没做跳转，已如实记为缺口，是否接受由整合方定。
- 需要人工确认：本机 `verify` 停在 `review-needs-lifecycle-ui`（端口被用户正在运行的 IXAEON 占用），交付说明没写 `local-user` 这一步跑没跑过；GitHub CI 也还没看。按 AGENTS，这一支必须本机 verify（含 `local-user`）通过、分支 CI 绿了才能合并。
- 需要人工确认：交付说明写第二轮 Claude 代审「exit 0、可以合并」，但这次改动里没有提交 `docs/委派/交付/G1eb-Codex审查.md`。AGENTS 要求审查结论文件随分支一起提交，合并前要确认已经补上（或者由本轮审查生成后提交）。

结论：需要修改
