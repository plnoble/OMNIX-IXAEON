# D1 Codex 审查

- 时间：2026-09-28T07:41:18.596Z
- 分支：grok/D1（61a72ea），对照 docs/委派/D1-聊天里提编码任务.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改 `apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:270–285`：自行规定“项目对话与个人对话同时回答时仍建草案”，放宽了契约 3 的“恰好一个正在回答”限制，也可能把个人对话的工具调用归到项目对话；需整合方明确这一情形后再锁定测试。
- 必须改 `apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:303–315`：漏测 `acceptance: ['']`，接受空验收条件的实现仍能通过，违反每条条件至少 1 字的契约；应补充拒绝且不建任务的断言。
- 必须改 `apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:82、185–194`：执行器没有调用监测，草案状态也只在回答结束前检查，未覆盖“不批准、不派发、不跑命令”的约束；应监测执行及派发入口，并在回答结束后确认没有执行副作用。
- 必须改 `packages/core/test/acceptance/d1-convention.test.ts:144–146`：仅检查工具名和两个文字片段，未验证契约 6 要求的开发请求触发条件、写清目标及验收条件、点击「要做」才开工；缺少这些操作约定的提示词仍可通过。
- 必须改 `apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:170–192`：没有覆盖契约 4 要求的“还没有独立验收”回报，验证命令为空不能替代这项告知；需要人工确认：该说明由哪个现有回报字段或界面承载，再补对应断言。
- 建议 `apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:358–374`：注册替身丢弃工具处理函数，HTTP 测试又使用独立替身，因此 MCP 未正确转发名称或参数也能通过；建议调用实际注册的处理函数，核对转发参数和返回值。
- 必须改 `docs/委派/交付/D1.md:27`：已执行的测试和 eslint 只有结果概述，没有命令及原始输出，不符合交付证据要求；应补贴实际输出。本次为 B 档测试送审，尚未实现及未跑真机本身不属于问题。

结论：需要修改
