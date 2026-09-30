# V2 Codex 审查

- 时间：2026-09-30T15:40:12.742Z
- 分支：prep/V2（98fd077），对照 docs/委派/V2-端到端测试补漏.md
- Codex：0.159.2；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`.github/workflows/verify.yml:62` 实际只运行 `test-e2e.mjs desktop`，排除了 extension、serial；规格步骤 4 要求运行完整命令，现有 CI 运行号不能证明验收完成。须补齐完整 CI，或由整合方先批准修改规格，不能自行移到后续任务。
- 必须改：`apps/extension/e2e/serial-real.cjs:157`、`docs/委派/交付/V2.md:31–35`：交付称 `apiBaseUrl` 接口可选，但省略会因直接调用 `trim()` 而崩溃；补空串绕过了疑似产品契约错误，不能直接认定测试过时。需要人工确认：该字段的正式契约及整合方对这个新发现问题的判定；若确实允许省略，应按规格第 3 条交整合方处理。

结论：需要修改
