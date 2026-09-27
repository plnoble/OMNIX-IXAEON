# M1 Codex 审查

- 时间：2026-09-27T01:14:07.317Z
- 分支：grok/M1（6106eac），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`packages/core/src/extraction/model/openai.ts:203、396、419`：缺少完成标记时抛出的 `ModelError` 被直接重抛，跳过一次网络重试，错误前缀也变成“空文本”；与交付声明的“截断按网络错误重试”不符。
- 必须改：`packages/core/src/extraction/model/openai.ts:329`：仍从消息正文匹配三位数字，`invalid_prompt` 配合“超过 512 tokens”会被误判为可重试的 500。`m1-streaming.test.ts:249` 的对应测试实际使用“出错了”，没有验证所声称的数字场景。
- 必须改：`packages/core/src/extraction/model/openai.ts:312`：第二个正则没有词边界，`unsupported upstream model` 仍会命中，导致普通模型错误触发回退并永久关闭该实例的流式请求。
- 必须改：`packages/core/test/acceptance/m1-streaming.test.ts:56–60`：三块数据只包含一个 delta 事件，只是该事件跨块；没有覆盖规格要求的“两段非空 delta，其中一段跨读取”，注释与交付说明均不实，需补充验收覆盖。
- 建议：`packages/core/test/acceptance/m1-streaming.test.ts:271`：排除探测的判断是 `input === undefined`，与第 193 行判断空数组不同。需要人工确认：实际探测请求体；若为 `input: []`，探测会消耗首次截断响应，使 `streams === 2` 在没有重试时也能通过。
- 建议：`docs/委派/交付/M1.md:37`：“模型或输入的 400”用例没有覆盖 429 / 5xx，队列重试也不能证明 provider 的一次立即重试。需要人工确认：未提供的既有测试是否确实断言这些重试次数，并修正覆盖说明。
- 建议：`docs/委派/交付/M1.md:11`：源码统计仍写“新增 53、删除 33”，本次完整 diff 实际为新增 168、删除 8，应更新交付记录。

结论：需要修改
