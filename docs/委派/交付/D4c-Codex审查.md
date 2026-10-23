# D4c Codex 审查

- 时间：2026-10-23T04:32:18.286Z
- 分支：dev/D4c（31508c5），对照 docs/委派/D4c-建分支失败带上git原话.md
- Codex：0.163.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改｜`packages/core/test/acceptance/d4c-git-stderr.test.ts:81、135`：接口要求返回必填的 `rawWhy`，实现却只返回 `taskId` 和 `error`，返回类型不匹配，TypeScript 类型检查会报错。

必须改｜`packages/core/test/acceptance/d4c-git-stderr.test.ts:190–195`、`docs/委派/交付/D4c.md:71`：无 stderr 用例仍只检查前缀和末尾不是冒号，即使错误追加了 `：多余内容` 也能通过，未验证“没有错误输出就照旧”；交付说明却声称已做完整相等断言，应补足断言并如实更新说明。

必须改｜`scripts/real/d4c-flaky-repro.mjs:42–57`：`shell: true` 下传给 `node -e` 的代码没有独立引号保护，空格和 `<` 会被 Windows shell 解析，无法按预期启动负载；代码还忽略启动结果，直接打印“已起”。应修正启动方式、确认负载与测试同时运行并重跑。需要人工确认：交付中“忙时 12 遍”的记录是否另有有效的负载启动证据。

结论：需要修改
