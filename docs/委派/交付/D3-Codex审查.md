# D3 Codex 审查

- 时间：2026-09-27T08:24:42.016Z
- 分支：grok/D3（8388e0a），对照 docs/委派/D3-点要做就开工并回报.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/main/ipc.ts:591`、`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:442`：任务页取消仍直接调用 `coding.cancel`，排队任务取消后不会生成回报；测试手动补调 `onTaskSettled`，掩盖了入口遗漏。须接通实际取消入口，并通过该入口验收。
- 必须改｜`apps/desktop/src/main/codingDispatch.ts:80–81`：仅按 `granted_at` 排序，同一时间戳的多个排队任务没有确定的批准顺序，可能乱序派发；须保留批准先后，并补同时间戳场景的测试。
- 必须改｜`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:217–247、421–446`：顺序测试只有一个等待任务，倒序调度也能通过；取消测试取消的是等待项，未验证正在执行的任务失败或取消后继续派发。须补多个等待项及失败、取消后的续派测试。
- 建议｜`apps/desktop/src/main/codingDispatch.ts:65–68`：需要人工确认：`dispatch` 拒绝时是否保证任务离开 `queued`。当前吞掉异常后立即循环，若状态仍为 `queued`，会不断重试同一任务，阻塞后续任务甚至主进程；应增加无进展时的退出保护。
- 必须改｜`docs/委派/交付/D3.md:37–39、65`：声称“本轮补”验证证据，但验收仍记为旧的 9 条，`verify` 输出和 GitHub CI 结果仍是占位。须补当前 11 条验收及 `verify` 输出；需要人工确认：当前分支提交的 GitHub verify 是否通过。

结论：需要修改
