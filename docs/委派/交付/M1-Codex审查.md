# M1 Codex 审查

- 时间：2026-09-27T01:28:10.014Z
- 分支：grok/M1（a475460），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:315`：判断式实际只检查正文是否出现独立的 `stream`；例如 `invalid schema property 'stream'` 也会触发重发并永久禁用流式。应确认错误确实拒绝流式参数，避免改变其他 400 的处理语义。
- 必须改｜`packages/core/src/extraction/model/openai.ts:329`：错误码直接调用 `toLowerCase()`，网关返回 JSON 数字 `429`、`500` 时会抛 `TypeError`，被误包装成网络错误；数字 `400` 还会被误判为可重试。应归一化错误码，并补数值类型测试。
- 必须改｜`packages/core/test/acceptance/m1-streaming.test.ts:58`：条件 1 的三块数据没有 `response.created`，遗漏规格明确要求的事件序列；应保留三次读取和跨块 delta，同时补入 created 事件。
- 建议｜`docs/委派/交付/M1.md:37`：需要人工确认：未提供的既有测试是否确实断言 429／5xx、网络错误的一次立即重试及次数上限；此处引用的「400 不重试」用例和队列重新排队不能证明这项验收条件。

结论：需要修改
