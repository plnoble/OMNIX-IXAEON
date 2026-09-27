# M1 Codex 审查

- 时间：2026-09-27T01:37:38.405Z
- 分支：grok/M1（577a7c6），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:205`：流内限流或服务端错误被转换为 `ModelError` 后直接抛出，跳过一次立即重试；应保持契约 4 的重试语义，并验证首次失败后恢复及连续失败时的请求次数。
- 必须改｜`packages/core/src/extraction/model/openai.ts:317`：只检查正文同时出现 `stream` 和拒绝词，无法确认拒绝的是流式参数；例如 `unsupported schema property 'stream'` 会误触发重发并永久关闭流式，而 `stream must be false` 又不会回退。需准确识别针对 `stream` 参数的拒绝，并覆盖这些反例。
- 必须改｜`packages/core/src/extraction/model/openai.ts:396`：错误分类只传入 `code`，忽略明确的错误类别；例如 `error.type="server_error"`、`code=null` 会被归为不可重试的 400，违反“能看出是限流或服务端错误的算暂时性”。应保留并识别结构化错误类别。
- 建议｜`docs/委派/交付/M1.md:35`：需要人工确认：未提供的既有测试是否确实断言 HTTP 429／5xx 和网络错误的一次立即重试；文中引用的当前文件“模型或输入的 400”用例只测不重试，队列重新排队也不能证明 provider 的立即重试次数。
- 建议｜`docs/委派/交付/M1.md:45`：真机日志是摘录，缺少脚本必然输出的 `FAKE_SERVER` 和 `HEADERS_FLUSHED`；应按仓库要求补贴完整原始输出。

结论：需要修改
