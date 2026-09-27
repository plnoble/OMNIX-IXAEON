# D3 Codex 审查

- 时间：2026-09-27T08:14:07.986Z
- 分支：grok/D3（d9da469），对照 docs/委派/D3-点要做就开工并回报.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/main/appRuntime.ts:1744、1757`：遇到任务页手动派发的任务正在执行时，自动调度直接退出，没有在该任务结束后重新启动；随后点「要做」的任务会一直排队，违反自动续派契约。
- 必须改｜`apps/desktop/src/main/appRuntime.ts:1748、1799`：回报只在自动派发返回后生成；排队任务被取消后会被出队查询跳过，缺少取消回报；带 `origin_run_id` 的任务通过任务页手动派发也没有接入回报。需覆盖这些状态变化路径。
- 必须改｜`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:275`：再次排空队列时，任务已经是 `pending_accept`，不会再次尝试写回报；即使删除去重判断，该测试也能通过，未真正覆盖“同一状态只写一次”。
- 必须改｜`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:271`：`note.txt` 已出现在验收条件中，即使回报完全不列改动文件，此断言仍会通过；需用验收条件中未出现的文件名验证改动文件回报。
- 必须改｜`docs/委派/交付/D3.md:38、39`：没有提供 verify 输出，GitHub verify 仍写“推送后补”，缺少仓库要求的合并证据。需要人工确认：最新分支提交的本地 verify 与 GitHub CI 均通过，并补齐交付记录。

结论：需要修改
