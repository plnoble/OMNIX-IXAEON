# A4 Codex 审查

- 时间：2026-10-02T10:18:41.616Z
- 分支：prep/A4（1eea923），对照 docs/委派/A4-切回来接着看还在写的回答.md
- Codex：0.159.2；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/e2e/a4-follow-live-answer.spec.ts:117`：这里只等待完整最终文本，没有验证仍在回答时气泡出现新增分段；交付中的 Hermes 检查也是 `GROWING 否 / FINAL_OK 否`。规格要求的分段真机检查尚未完成，须补跑并贴出原始结果，组件替身不能代替这项检查。
- 建议｜`apps/desktop/src/renderer/src/pages/Ask.tsx:177`：需要人工确认：同一对话是否可能在两次轮询之间结束旧轮并开始新轮。当前存在其他 `streaming` 消息时只更新该消息，不同步旧消息的终态，会让旧回答继续转圈；应覆盖这个边界并按消息 id 同步。
- 建议｜`apps/desktop/e2e/a4-follow-live-answer.spec.ts:154`：`toHaveCount(2)` 缺少 `await`，随后立即关闭应用，可能使计数断言尚未完成就关闭页面；应等待断言完成。
- 建议｜`scripts/real/a4-follow-live.mjs:142`：`FINAL_OK` 仅比较正文长度，相同长度的错误内容也会被报告为“与库一致”；应逐字比较界面正文和数据库正文。

结论：需要修改
