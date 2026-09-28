# D3 Codex 审查

- 时间：2026-09-28T01:00:42.690Z
- 分支：grok/D3（97ec0d6），对照 docs/委派/D3-点要做就开工并回报.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`apps/desktop/src/main/codingDispatch.ts:54–63`，手动任务结束后，`resumeAfterRunning` 仍为 `true`；若队首任务因批准撤销而派发被拒，即使已加入跳过列表，第 61 行仍会提前退出，后续任务无人唤醒、持续排队。应按本次拒绝是否属于互斥决定退出，并补充此组合场景的测试。

建议：`apps/desktop/src/main/taskReport.ts:71–75`，失败回报只取八行，却先拆分、遍历整份验证输出；长输出会增加主进程的同步开销，建议收集到八个非空行后停止。

结论：需要修改
