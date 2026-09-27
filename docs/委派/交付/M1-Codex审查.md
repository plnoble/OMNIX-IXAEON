# M1 Codex 审查

- 时间：2026-09-27T06:13:51.663Z
- 分支：grok/M1（da07e12），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`packages/core/src/extraction/model/openai.ts:385–391`：错误分类完全忽略 message；收到 `{"type":"error","code":null,"message":"Rate limit exceeded"}` 时会返回 `API 错误 400`、`retriable=false`，使明确的限流错误无法重试，违反契约 1。应处理错误码缺失但消息明确表示限流或服务端错误的情况，并补充测试。

结论：需要修改
