# M1 Codex 审查

- 时间：2026-09-27T01:03:10.504Z
- 分支：grok/M1（979b51e），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:346`：只按 `\n\n` 分隔事件，合法的 CRLF（`\r\n\r\n`）流无法解析，会持续积累缓冲并最终报空文本；需支持跨读取边界的 CRLF，并补测试。
- 必须改｜`packages/core/src/extraction/model/openai.ts:377、392`：`response.completed` 仅设置标志，`[DONE]` 仅退出回调，都没有结束读取；服务端保持连接时仍会等待甚至超时重试。应在完成标记处停止读取并清理 reader。
- 必须改｜`packages/core/src/extraction/model/openai.ts:384、400`：流结束时只要已有文字，即使没收到完成标记也返回成功，会把截断结果交给调用方；此外，只有 `response.completed` 而没有文字时竟返回空字符串，改变了原有空文本报错行为。需校验完成状态和非空结果。
- 必须改｜`packages/core/src/extraction/model/openai.ts:307`：`includes('stream')` 也会匹配 `upstream`；例如普通的 `upstream: invalid schema` 400 会被误判为不支持流式，触发重发并永久关闭该实例的流式能力。需识别明确针对 `stream` 参数的拒绝。
- 必须改｜`packages/core/src/extraction/model/openai.ts:320、332`：错误分类会把 `invalid_prompt` 配合“超过 512 tokens”的消息误判为服务端错误，却把明确的 `code: "429"`、`message: "Too Many Requests"` 判成不可重试的 400；需避免匹配任意消息数字，并识别明确的限流码。
- 必须改｜`packages/core/test/acceptance/m1-streaming.test.ts:57–60`：条件 1 实际提供四个读取块，第二段 delta 为空，没有落实“三次读取、两段文字”的验收条件；应改为三块、两段非空文字且其中一段跨块，并更正 `docs/委派/交付/M1.md:34` 的对应声明。
- 建议｜`packages/core/test/acceptance/m1-streaming.test.ts:192`：需要人工确认：端点探测是否发送 `input: []`（第 177 行按此识别）。本用例只排除 `input === undefined`；若实际为 `[]`，探测会占用第一个失败流，业务请求直接成功也满足 `streams === 2`，无法证明读取中断后发生了重试。
- 建议｜`docs/委派/交付/M1.md:36`：需要人工确认：引用的既有测试是否确实断言 HTTP 429／5xx 的一次立即重试及第二次失败后停止；提供的说明仅明确描述网络错误、端点探测与解析，无法据此确认验收条件 5 全部覆盖。

结论：需要修改
