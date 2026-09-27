# M1 Codex 审查

- 时间：2026-09-27T02:10:44.573Z
- 分支：grok/M1（27f9fc8），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:325`：正则仍会将 `unsupported schema property stream` 误判为拒绝流式：中间 17 个字符可由 `.{0,16}` 加前置边界匹配，导致普通 schema 错误触发重发并永久禁用流式。应识别被拒绝的参数，补充这一负例，不能靠字符距离判断。
- 建议｜`packages/core/test/acceptance/m1-streaming.test.ts:10`、`docs/委派/交付/M1.md:37`：需要人工确认：未提供的既有测试是否确实断言了 HTTP 429／5xx、网络错误的一次立即重试及次数上限；当前引用的 400 用例只验证“不重试”，队列重新排队也不能证明立即重试次数，交付说明应准确对应实际断言。

结论：需要修改
