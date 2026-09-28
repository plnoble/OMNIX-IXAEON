# D4 Codex 审查

- 时间：2026-09-28T12:17:59.750Z
- 分支：grok/D4（f51f37e），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改｜`apps/desktop/test/acceptance/d4-tasks-page.test.ts:61`：`nothing` 夹具没有任何“零改动”的执行证据，却要求显示「没有改动」；旧版已完成但改动仍留在副本的任务也没有落地字段，错误地据此判断零改动仍能通过。应提供真实零改动夹具，并补有改动但未落地的反例；需要人工确认：现有执行报告中表示改动的字段。
建议｜`packages/core/test/acceptance/d4-apply-branch.test.ts:662、680`：两种 Git 失败只验证生成改动包，没有验证失败原因；桌面回报也只覆盖非 Git 仓库，遗漏契约 6 对建分支失败原因的回报要求。
建议｜`packages/core/test/acceptance/d4-apply-branch.test.ts:597`：新建的 `prefixDir` 是项目目录的兄弟目录，未登记到 `dirs`，`afterEach` 不会清理，每次运行都会遗留临时目录。
结论：需要修改
