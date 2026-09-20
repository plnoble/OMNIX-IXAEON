# U1 Codex 审查

- 时间：2026-09-20T03:33:57.045Z
- 分支：grok/U1（3b953b5），对照 docs/委派/U1-研究页忙状态.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`apps/desktop/src/renderer/src/pages/Research.tsx:195–196`：停止等待后，若同主题启动“加来源”等操作，旧检查返回时仍会清除该操作的 `topicBusy`，提前恢复按钮。`checkSeq` 只防住了再次检查；所有主题操作都需校验忙状态归属，并补充此并发回归测试。
建议：`scripts/real/u1-research-busy.ts:73–75`：检查会立即失败，点击后的采样可能已在检查结束之后，`CREATE_DURING false` 不能证明检查期间创建按钮可用。应捕获实际等待阶段的按钮状态，再据此报告“全程可点”。
结论：需要修改
