# D1 Codex 审查

- 时间：2026-09-28T08:55:45.667Z
- 分支：grok/D1（247ec54），对照 docs/委派/D1-聊天里提编码任务.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:181`：成功用例未核对任务保存的目标；即使传入的 `goal` 被丢弃或替换，测试仍能通过。应断言任务目标与输入一致。
- 必须改：`apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:239`：缺少“没有正在回答或只有个人对话，但参数携带有效项目”的拒绝用例；实现若在这些情况下用参数中的项目兜底，仍能通过现有测试，违反“项目一律不由模型选”。
- 必须改：`apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:317`：路径越界仅测试 `../outside` 和 `C:\tmp`，未覆盖裸 `..`、Windows 的 `..\outside`、嵌套越界及 `/outside`；仅拦特定前缀的错误实现也能通过，应补齐这些边界。
- 必须改：`apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:465`：只检查 schema 键名，再直接调用处理函数，绕过了 MCP 参数校验；即使把 `scope` 声明为必填或把 `acceptance` 声明成字符串，测试仍通过。应通过注册的 schema 验证合法输入，包括省略 `scope` 和合法上限。
- 必须改：`docs/委派/交付/D1.md:36`：提供的是失败结果的人工概述，没有 Vitest 原始输出，第 58 行却称已补贴实际输出；应补贴原始结果，才能核对失败是否确实来自功能缺失，而非测试夹具错误。

结论：需要修改
