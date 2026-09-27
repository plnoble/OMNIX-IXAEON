# D3 Codex 审查

- 时间：2026-09-27T08:35:31.281Z
- 分支：grok/D3（15b82b7），对照 docs/委派/D3-点要做就开工并回报.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/main/codingDispatch.ts:64`：Codex 检查只在 `kick` 中进行；已有自动任务执行时，新任务即使收到“没找到 Codex”回报，仍会被现有 `drain` 在上一任务结束后派发。应在每次自动派发前检查，确保缺失时保持已批准状态。
- 必须改｜`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:320、421`：仍未覆盖“取消正在执行的任务后，后继继续且不重叠执行”；前一个测试没有后继并绕过真实取消入口，后一个只取消排队项。需要人工确认：`coding.cancel`、`runningCount` 是否在执行器实际退出前释放执行名额，并补充对应验收。
- 必须改｜`docs/委派/交付/D3.md:40–42`：验收只有通过数量，verify 仍写“结果见下”，CI 仍是占位，全文没有对应输出和成功记录；后文宣称已补齐与实际不符，尚不满足交付及合并要求。
- 建议｜`apps/desktop/test/acceptance/d3-auto-dispatch-report.test.ts:457–463`：任务创建顺序和批准顺序完全相同，按任务创建顺序派发也能通过。应逆序批准，并在已有任务执行时积累两个等待项，验证真正按批准先后派发。
- 建议｜`apps/desktop/src/main/codingDispatch.ts:64–65`：派发拒绝后异常被吞掉，排空直接停止，已有后继任务没有恢复触发或错误提示；应保留错误并明确恢复方式，避免队列静默停住。

结论：需要修改
