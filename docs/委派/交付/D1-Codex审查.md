# D1 Codex 审查

- 时间：2026-09-28T11:25:24.542Z
- 分支：grok/D1（7f52e54），对照 docs/委派/D1-聊天里提编码任务.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:351`，真实建任务路径缺少必填参数缺失、参数类型错误及合法上限（目标 2000 字、8 条条件、单条 200 字）的用例；后面的 MCP schema 检查不能代替运行时验证，实际拒绝合法参数或对非法参数抛出普通异常的实现仍可能通过。

必须改：`apps/desktop/test/acceptance/d1-coding-task-draft.test.ts:177、245`，返回 note 和项目归属错误只检查片段，漏掉契约明确要求的「用户在这条回答下面点『要做』才会开工」及「先选项目、开新对话」；应核对完整约定文案，避免缺失开工前提和操作指引仍通过验收。

结论：需要修改
