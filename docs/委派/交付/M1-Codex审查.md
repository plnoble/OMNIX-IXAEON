# M1 Codex 审查

- 时间：2026-09-27T02:55:46.822Z
- 分支：grok/M1（e60c57e），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`packages/core/src/extraction/model/openai.ts:358-363`，400 正文为 `Streaming is disabled for this model` 时不会回退：向后匹配未识别 `disabled`，最终直接报错，违反契约 2；需补充处理和验收用例。
- 建议：`packages/core/src/extraction/model/openai.ts:381`，媒体类型比较应忽略大小写；合法的 `Text/Event-Stream` 会被误判为普通 JSON，并永久禁用该实例的流式请求。
- 建议：`packages/core/src/extraction/model/openai.ts:415-418`，SSE 还允许单独用 CR 换行；当前只识别 LF、CRLF，这类合法流会被误判为截断并重复请求。

结论：需要修改
