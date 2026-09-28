# D4 Codex 审查

- 时间：2026-09-28T11:56:11.032Z
- 分支：grok/D4（159b881），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:174–178`：所有用例都填写了项目根目录，遗漏契约 2 的“没有根目录”分支；需验证接受时根目录为空也不落地，并记录规定的授权错误。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:581–589`：授权反例只有完全无关的目录，错误的字符串 `startsWith` 判断也能通过；需补“授权 project、项目位于 project-other”的反例，验证文件夹授权边界。
- 必须改｜`apps/desktop/test/acceptance/d4-tasks-page.test.ts:90–95`：分支卡片只断言分支名和“没有推送”，遗漏契约 6 要求同样显示的工作区保护说明及 `git merge <分支>` 指引，页面缺少这些信息仍会通过。
- 建议｜`docs/委派/交付/D4.md:91–92`：需要人工确认：整合方是否认可测试写死的清单格式和 `AppRuntime.acceptCodingTask` 入口；这些尚未由规格确定，锁定后执行方不能自行改名或改字段。
- 建议｜`apps/desktop/test/acceptance/d4-landing-report.test.ts:83–90`：桌面测试未像核心测试那样隔离 Git 全局配置，本机的提交签名或全局钩子可能使合成仓库初始化失败；应采用相同的配置隔离。

结论：需要修改
