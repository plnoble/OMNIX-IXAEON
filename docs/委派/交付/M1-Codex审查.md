# M1 Codex 审查

- 时间：2026-09-27T05:56:30.879Z
- 分支：grok/M1（b6316e3），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改｜`packages/core/src/extraction/model/openai.ts:204–207`：所有 `retriable` 的 `ModelError` 都会立即重试，导致正常完成但没有文字的流也多发一次请求；原非流式路径对此直接抛错，违反契约 4 的语义不变要求。应区分空文本与网络中断、限流及服务端错误，并补请求次数测试。
建议｜`packages/core/test/acceptance/m1-streaming.test.ts:485–494`：跨块 CRLF 用例的第一块已包含完整 JSON，即使错误地提前分隔事件也能通过；建议新增同一事件包含多条 `data:` 行、在第一条行末 CR 处拆块的用例，覆盖交付说明所述回归。
结论：需要修改
