# M1 Codex 审查

- 时间：2026-09-27T02:38:37.314Z
- 分支：grok/M1（6a6c872），对照 docs/委派/M1-慢模型不再超时.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/extraction/model/openai.ts:315-317`：400 响应正文为合法 JSON `null` 时，访问 `root['error']` 会抛出 `TypeError`，绕过原有的 `API 错误 400`／`ModelError` 处理；应先检查根值非空且为对象，并补回归测试。
- 必须改｜`docs/委派/交付/M1.md:11-24`：源码改动为 257 行新增、8 行删除，超过 M1 规格的 ≤250 行限制；交付仅按仓库通用的 300 行上限判断并声称无差异，需缩减改动，或由整合方调整规格。
- 建议｜`packages/core/test/acceptance/m1-streaming.test.ts:469-472`：CRLF 用例的每块都是完整事件，没有将换行符或事件分隔符拆到两次读取，无法证明交付所称的“CRLF 跨块”；应补真正跨块的用例。
- 建议｜`docs/委派/交付/M1.md:40`：需要人工确认：绿色 CI 对应的 `7b517c0` 是否覆盖本次完整改动；材料未提供当前 HEAD，本机 verify 也未全部通过。

结论：需要修改
