# M1 Codex 审查

- 时间：2026-09-27T02:25:41.933Z
- 分支：grok/M1（a13e68e），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:317`：400 正文为 `{"error":{"code":"unsupported_parameter","param":"stream","message":"Unsupported parameter"}}` 时，拆词匹配返回 false；错误已明确指向 stream，却不会回退或缓存，违反契约 2。应识别结构化错误中的参数与错误码，并补充回归。
- 必须改｜`packages/core/src/extraction/model/openai.ts:342–348`：`schema property stream is not supported` 会命中向后匹配，把 schema 错误误判成不支持流式，触发重发并永久关闭该实例的流式请求；现有反例只覆盖拒绝词在前面的写法，应补上此类上下文判断。
- 建议｜`docs/委派/交付/M1.md:8`：“慢模型思考超过 100 秒不再被……掐断”超出了本机假服务验证的结论；应表述为已实现流式传输，真实网关是否消除 524 待用户验证。

结论：需要修改
