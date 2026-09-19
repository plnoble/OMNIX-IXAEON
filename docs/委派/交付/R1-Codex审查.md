# R1 Codex 审查

- 时间：2026-09-19T13:12:18.549Z
- 分支：grok/R1（7152f2e），对照 docs/委派/R1-恢复失败后重建聊天.md
- Codex：0.155.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改｜`apps/desktop/src/main/appRuntime.ts:1803`、`apps/desktop/test/acceptance/r1-rebuild-conversations-semantic.test.ts:225`：清空 Promise 引用不会停止旧 `backfill`，结果回调中的守卫也不会取消正在执行的工作；测试只塞入一个裸 Promise，没有启动旧索引的补向量，无法验证“先停旧后台工作再替换”和验收条件 3。

必须改｜`apps/desktop/test/acceptance/r1-rebuild-conversations-semantic.test.ts:188`：用零待补记录的 `backfill()` 代替检索，漏测验收条件 2 的“检索不抛错”。可以模拟嵌入计算并实际执行检索，无须依赖在线 Ollama，不能因此放宽条件。

必须改｜`docs/委派/交付/R1.md:10`：完整 diff 共新增 341 行、删除 9 行，超过 AGENTS.md 的 300 行硬上限，须精简或按规则拆分。

建议｜`docs/委派/交付/R1.md:53`、`apps/desktop/src/main/appRuntime.ts:1808`：需要人工确认：恢复入口是否保证在途提问已经取消或结束；清空 `askSessions` 不会终止已持有旧会话的执行，“提问界面应已停”不足以证明不会继续访问旧连接。

结论：需要修改
