# U4 Codex 审查

- 时间：2026-10-06T14:23:42.674Z
- 分支：grok/U4（ccd05a7），对照 docs/委派/U4-回报一点就到那条任务.md
- Codex：0.160.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`apps/desktop/src/renderer/src/pages/Tasks.tsx:263–267`：同一任务已展开时收到新的 `focus`，再次加入集合不会改变 `open`，第 149 行的读取 effect 不会重跑，违反契约“新 focus 再执行一次、读一次改动”；需修复并补充未收起时重复定位的测试。
- 必须改：`apps/desktop/test/acceptance/u4-open-task-from-report.test.ts:160–162、256–261`：测试直接注入 `focus`，把传入 `null` 当作侧栏导航，没有验证 `App → AskPage → AskMessage` 的点击跳转及旧焦点清除；即使删掉实际导航接线，这些测试仍通过，未完整覆盖验收条件 2、5、6，需补充真实导航链路测试并重新锁定。
- 必须改：`docs/委派/交付/U4.md:23–25`：规格限定 ≤100 行源码，本次新增 111 行、删除 15 行，不能用仓库的 300 行上限替代；需收敛改动，并更正“和规格不一样的地方：没有”。

结论：需要修改
