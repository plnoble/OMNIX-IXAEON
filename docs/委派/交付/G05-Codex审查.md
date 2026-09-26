# G05 Codex 审查

- 时间：2026-09-26T12:30:06.794Z
- 分支：grok/G05（95471c2），对照 docs/委派/G05-准备阶段也能取消.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/test/acceptance/g05-cancel-preparing.test.ts:84`：所有用例都预置了会话，漏测首次提问尚无会话时的准备阶段取消；即使恢复原来的“无 session 就取消失败”，测试仍会通过。补充空 `askSessions` 场景，断言取消成功、不创建会话、不调用模型且回答为 `cancelled`。
- 必须改｜`apps/desktop/test/acceptance/g05-cancel-preparing.test.ts:138–140`：替身无条件返回取消提示，`cancel` 又是未检查的空函数；即使实现删掉 `session.cancel(runId)`，此用例仍可通过，无法证明“回答中取消行为不变”。应明确等待回答开始，并断言会话收到对应 `runId` 的取消通知。
- 建议｜`apps/desktop/src/main/appRuntime.ts:1141`：需要人工确认：`AgentSession.run/cancel` 是否保证内部异步准备、Hermes 启动及 Core 模型调用之间的取消仍能阻止后续外发；当前仅展示进入 `session.run()` 前的检查，替身未覆盖内部外发边界。
- 建议｜`apps/desktop/src/main/appRuntime.ts:1622`：需要人工确认：界面收到 `cancelled: false` 时不会显示「已停止」；提供的改动和测试均未展示这项契约的界面处理。
- 建议｜`docs/委派/交付/G05.md:29–31`：验收与 verify 只有通过摘要，未附仓库交付规则要求的命令输出，应补充对应运行记录。
结论：需要修改
