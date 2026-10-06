# U5 Codex 审查

- 时间：2026-10-06T20:35:35.485Z
- 分支：grok/U5（304c401），对照 docs/委派/U5-任务卡片说人话.md
- Codex：0.160.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`apps/desktop/src/renderer/src/pages/Tasks.tsx:435–436`：`TaskWords` 在错误原因之前渲染，导致「它的说明」出现在原因上方，违反契约要求的“在原因下面显示”；调整顺序并补充位置断言。
- 必须改：`apps/desktop/test/acceptance/u5-tasks-card.test.ts:243–247`：条件 2 使用 `toContain`，即使回报改成「独立验证通过」也能通过，未锁住“逐字不变”；应对完整验证行使用精确相等断言。
- 必须改：`packages/contracts/test/acceptance/u5-card-words.test.ts:10–54`：条件 1、3 的完整验收仍放在 contracts；规格明确要求两句共用函数也在 desktop 的验收文件中测试。条件 2、4 的回报测试不能替代这些契约用例，应按指定位置落实并重新锁定。
- 必须改：`docs/委派/交付/U5.md:32、38–39、59`：D5a 端到端仅写计划随 CI 运行，本轮 verify 仍写“结果补在下面”，实际未附结果，却宣称已补齐、没有缺口；须补齐当前实现的验证输出及 D5a 通过记录。
- 建议：`apps/desktop/src/main/taskReport.ts:59–60`：`verify_status='failed'` 的返回文字确实发生变化。需要人工确认：交付说明所称该状态不可能进入 `verifyLine` 的约束在所有调用路径上成立；所给 diff 未包含相应状态流转代码。

结论：需要修改
