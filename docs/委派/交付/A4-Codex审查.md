# A4 Codex 审查

- 时间：2026-10-02T03:18:38.109Z
- 分支：prep/A4（9fd5af0），对照 docs/委派/A4-切回来接着看还在写的回答.md
- Codex：0.159.2；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/main/appRuntime.ts:1268`：新增失败判定并清空回答、改变最终状态，超出 A4「只改显示与刷新、不改主进程回答逻辑」的范围；还会影响仅取 complete 的后续上下文，应移出本任务，交整合方按 B 档处理。
- 必须改｜`apps/desktop/e2e/a4-follow-live-answer.spec.ts:118`：只等待完整回答，未证明回答仍在进行时新分段进入气泡；组件测试也将 `onAskDelta` 置空、用手工更新数据库替代分段。需要人工确认：真实 `getConversation` 是否持续返回未完成的分段，并补上实际分段出现的界面验证。
- 必须改｜`apps/desktop/e2e/a4-follow-live-answer.spec.ts:134`、`docs/委派/交付/A4.md:84`：读取的 `db.content` 没有参与断言，界面仅检查包含固定文本及其出现次数，不能证明与数据库精确一致，也不能排除重复的部分片段；交付说明声称已有相等断言，与代码不符。
- 必须改｜`apps/desktop/e2e/a4-follow-live-answer.spec.ts:168`、`apps/desktop/test/acceptance/a4-follow-live.test.ts:177`：失败断言可被提问里的“失败”满足，没有检查界面错误信息；组件测试则从已失败状态开始，没有验证 streaming→failed 后自动刷新。需覆盖这一转换并断言具体错误和等待状态消失。
- 必须改｜`apps/desktop/e2e/a4-follow-live-answer.spec.ts:211`、`apps/desktop/test/acceptance/a4-follow-live.test.ts:194`：隔离测试在原回答完成后才切换对话，组件测试也未在切换后触发分段或轮询，未覆盖条件 4 要求的“另一对话打开期间原轮继续产生分段”。
- 建议｜`apps/desktop/src/renderer/src/pages/Ask.tsx:154`：异步轮询没有防重入或请求失效标记，仅校验对话 ID；慢请求乱序返回或 A→B→A 切换时，旧快照可能覆盖新状态，建议串行执行并丢弃旧 effect 的响应。
- 建议｜`apps/desktop/src/renderer/src/pages/Ask.tsx:205`：没有回答中的消息时仍永久每两秒读取完整对话，长对话会持续产生无用查询和传输；建议只在跟进回答期间轮询，收尾后停止。

结论：需要修改
