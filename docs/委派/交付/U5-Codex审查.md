# U5 Codex 审查

- 时间：2026-10-06T15:07:07.759Z
- 分支：grok/U5（3760fab），对照 docs/委派/U5-任务卡片说人话.md
- Codex：0.160.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`packages/contracts/src/entities.ts:389`：报告为 JSON `null` 或 `summary` 不是字符串时会在 `try` 外抛错，违反“其余返回 null”的契约；需检查解析后的结构并补测试。
- 必须改：`packages/contracts/test/acceptance/u5-card-words.test.ts:1`、`apps/desktop/test/acceptance/u5-tasks-card.test.ts:3`：共用函数测试未放在规格指定的 desktop 目录，U5 测试也未覆盖条件 2、4 的回报逐字一致性；需按规格补齐并重新锁定。需要人工确认：交付中引用的旧套件实际覆盖哪些逐字断言。
- 建议：`apps/desktop/src/main/taskReport.ts:59`：`failed` 的返回值从“还没有独立验收”变成“验证没通过”。需要人工确认：真实回报调用是否可能传入该状态；若可达，须恢复原文。
- 必须改：`docs/委派/交付/U5.md:18`：统计与所附 diff 不一致；`Tasks.tsx` 实际新增 148、删除 96 行，全部源码新增 180、删除 106 行，超过规格的 ≤100 行。需收敛大段重排并更正交付统计。
- 必须改：`docs/委派/交付/U5.md:31`、`docs/委派/交付/U5.md:37`：D5a 端到端、完整 verify 和分支 CI 仍是待跑或待补结果，尚不能证明条件 10 与合并门槛成立。需要人工确认：当前提交的实际运行结果，并补入交付说明。

结论：需要修改
