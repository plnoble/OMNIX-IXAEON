# M1 Codex 审查

- 时间：2026-09-27T00:46:01.729Z
- 分支：grok/M1（422d8b6），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:333、349`：`response.completed` 只设置变量，`[DONE]` 只退出回调，都没有停止读取；服务端保持连接时请求仍会挂起。应在结束事件到达时结束读取并释放连接。
- 必须改｜`packages/core/src/extraction/model/openai.ts:341、361`：未收到完成标记就 EOF，只要已有文字便返回成功，会把截断答案当成完整结果；此外 `/responses` 收到 completed 却没有文字也会成功，改变了原有空文本报错语义。
- 必须改｜`packages/core/src/extraction/model/openai.ts:303–313`：仅用 `\n\n` 分隔事件，无法解析合法的 CRLF 换行（`\r\n\r\n`）；这类流会持续积压缓冲并最终报空文本，应补正确的行解析及跨读取测试。
- 必须改｜`packages/core/src/extraction/model/openai.ts:187、237、301`：流读取处于已有网络错误捕获之外，读取期间超时或断连会直接传播原始异常，没有沿用这里的一次重试及 `ModelError('网络错误: …', true)` 转换；应覆盖响应头到达后断连的场景。
- 必须改｜`packages/core/src/extraction/model/openai.ts:324–338`：Responses 的 `error` 事件可直接在顶层提供 `code`、`message`，当前只读取嵌套 `error`，会丢失错误原因并把限流误判为不可重试；验收测试第 145 行构造的嵌套格式掩盖了问题。
- 必须改｜`packages/core/src/extraction/model/openai.ts:338、357`：新增的 `流式错误` 前缀违反“错误信息格式不变”的契约，可能使队列和界面的前缀分类失效；应沿用既有错误格式。
- 必须改｜`packages/core/src/extraction/model/openai.ts:174–185、237–243`：收到普通 JSON 后没有设置 `streamingUnsupported`，同一实例后续仍会尝试流式，遗漏契约 2 的缓存要求；对应验收测试只调用一次，未验证后续请求。
- 必须改｜`packages/core/src/extraction/model/openai.ts:203、225–227`：Chat 路径回退仍携带 `stream: false`，没有按契约删除字段；若网关拒绝的是未知参数 `stream`，重发仍会失败。需补该端点的回退和缓存测试。
- 必须改｜`packages/core/src/extraction/model/openai.ts:162–165、225–228`：所有 HTTP 400 都被当成不支持流式，包括模型、输入或 schema 错误，会永久关闭该实例的流式能力；应仅对明确针对 `stream` 的拒绝执行回退。
- 必须改｜`packages/core/test/acceptance/m1-streaming.test.ts:56–60`：条件 1 实际构造了四次读取、仅一条 delta，没有覆盖规格要求的“三次读取、两段 delta、其中一段跨读取”，无法验证 Responses 的多段文字累加。
- 必须改｜`scripts/real/m1-slow-stream.ts:38、50`：`writeHead()` 不会立即刷新响应头，首次实际发送发生在 110 秒后的 `write()`；当前检查没有验证“先收到响应头，再等待 110 秒读取正文”。应调用 `flushHeaders()` 后重跑并更新交付证据。
- 必须改｜`docs/委派/交付/M1.md:38`：本机 verify 尚有失败，分支 CI 也未提供通过证据，不满足仓库合并条件；应在不干扰用户应用的环境补跑并更新结果。需要人工确认：最新分支提交的 GitHub verify 是否全绿。
- 建议｜`docs/委派/交付/M1.md:35`：需要人工确认：未提供的 `modelProvider.test.ts`、`a1-patient-retry.test.ts` 是否确实断言了条件 5 要求的重试次数，当前材料只能看到执行方的通过声明。

结论：需要修改
