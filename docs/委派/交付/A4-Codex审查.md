# A4 Codex 审查

- 时间：2026-10-02T10:57:53.631Z
- 分支：prep/A4（057330f），对照 docs/委派/A4-切回来接着看还在写的回答.md
- Codex：0.159.2；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`apps/desktop/src/renderer/src/pages/Ask.tsx:200`、`apps/desktop/test/acceptance/a4-follow-live.test.ts:181`：跟进页首次轮询后会设置 `askPhase='answering'`，但“无阶段、无秒数”的断言只在轮询前执行。需要人工确认：未提供的标签及计时逻辑是否因此显示阶段或秒数；须补充轮询期间的标签断言，覆盖契约 3。
- 建议：`docs/委派/交付/A4.md:186`：最终汇总仍写验收“4/4”，与当前 6 条测试及前文输出不一致，应更正，避免混淆验证版本。

结论：需要修改
