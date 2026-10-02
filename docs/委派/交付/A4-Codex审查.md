# A4 Codex 审查

- 时间：2026-10-02T09:25:36.976Z
- 分支：prep/A4（300a92e），对照 docs/委派/A4-切回来接着看还在写的回答.md
- Codex：0.159.2；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`apps/desktop/e2e/a4-follow-live-answer.spec.ts:118`、`apps/desktop/test/acceptance/a4-follow-live.test.ts:158`——条件 2 未被真实验证：e2e 只等待完整答案，组件测试直接替换库内容，均未验证新分段到达时气泡仍在回答中并持续增长。需要人工确认：真实回答是否逐段写库；否则当前只轮询、不接分段的实现无法满足契约。须补充分段检查及最终气泡正文与库内容的精确比较。
- 必须改：`apps/desktop/src/renderer/src/pages/Ask.tsx:168`、`:214`——清理 effect 只停止定时器，没有使在途请求失效；快速 A→B→A 后，旧 A 请求仍能通过 ID 校验。若旧的 streaming 快照晚于新轮询的最终结果返回，会恢复转圈，而新定时器已经停止。应加入 effect 失效标记或请求代次，并补充乱序回包测试。
- 必须改：`apps/desktop/test/acceptance/a4-follow-live.test.ts:184`——失败用例实际构造的是 `complete` 加错误正文，未覆盖条件 3 的 `failed`／`errorMessage` 显示路径；契约要求的取消收尾也未覆盖。应追加这些终态的界面测试，不能用成功状态下显示错误文字代替。
- 必须改：`apps/desktop/e2e/a4-follow-live-answer.spec.ts:222`、`apps/desktop/test/acceptance/a4-follow-live.test.ts:195`——隔离测试没有在另一对话打开期间实际交付原轮分段：e2e 的否定断言立即通过后就切回原对话，组件测试的原对话已完成。须在另一对话保持打开时发送原轮分段并验证内容不变，同时覆盖同一对话中其他消息的分段隔离。

结论：需要修改
