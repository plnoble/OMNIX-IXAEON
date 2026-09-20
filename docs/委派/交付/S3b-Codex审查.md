# S3b Codex 审查

- 时间：2026-09-20T01:35:39.078Z
- 分支：grok/S3b（d110f82），对照 docs/委派/S3b-编码代理会话选择导入（界面）.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Sources.tsx:275`：估算响应没有校验是否仍对应当前勾选和清单；旧响应会覆盖新估算，全部取消后也会重新显示估算。须使过期响应失效，并补充乱序返回、请求未完成时取消的测试。
- 必须改｜`apps/desktop/src/renderer/src/pages/Sources.tsx:319`：导入期间仍可关闭清单并打开另一份清单，旧导入完成后会把结果显示在新清单下。须隔离不同清单的异步结果，或限制导入期间切换清单。
- 必须改｜`apps/desktop/test/acceptance/s3b-agent-sessions-page.test.ts:168`：顺序断言比较的是第一次已取消的 `pickFiles`，没有验证成功选择时的调用顺序，未真正覆盖验收条件 1。须另加正确的顺序检查；已有锁定测试不能由执行方直接修改。
- 必须改｜`docs/委派/交付/S3b.md:34`：仅记录了合成界面检查，缺少 AGENTS.md 规定会话导入改动必跑的 `scripts/real/agent-sessions.ts` 统计输出。需要人工确认：是否已执行；已执行须补贴输出，未执行须补跑后才能合并。
- 建议｜`scripts/real/s3b-agent-sessions-ui.ts:69`：启动后的操作没有 `try/finally`，任何一步失败都会跳过关闭应用和清理临时目录，残留实例可能阻碍后续检查；建议保证失败时也执行清理。

结论：需要修改
