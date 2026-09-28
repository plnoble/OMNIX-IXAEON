# D3 Codex 审查

- 时间：2026-09-27T13:42:17.948Z
- 分支：grok/D3（5a6fb02），对照 docs/委派/D3-点要做就开工并回报.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/main/codingDispatch.ts:59–60`：派发拒绝被直接吞掉，仅设置续派标记；若此时没有其他任务执行，就没有结算事件再次唤醒队列，也没有错误回报。需要人工确认：未提供的 `CodingOrchestrator.dispatch` 是否保证所有非互斥异常都转为失败状态并正常返回；否则须补异常处理及抛错测试，现有 `claimedSuccess: false` 未覆盖此路径。
- 必须改｜`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:249–274`：回报归属测试只有一个对话，即使实现忽略 `origin_run_id`、始终写入第一个对话也能通过。须补两个对话的场景，断言只向任务来源对话追加回报，覆盖契约 3。
- 建议｜`apps/desktop/src/main/taskReport.ts:69–74`：为取前八行，先拆分、修剪并过滤整份验证输出；大输出会在主进程同步分配大量字符串。建议扫描到第八个非空行即停止。
- 建议｜`apps/desktop/src/main/taskReport.ts:30–36`：每次去重都对整个消息表执行 JSON 条件查询；建议利用已找到的 `conversationId` 缩小查询范围，避免聊天记录增长后同步扫描全部历史。

结论：需要修改
