# D3 Codex 审查

- 时间：2026-09-28T01:16:16.792Z
- 分支：grok/D3（bf36ce1），对照 docs/委派/D3-点要做就开工并回报.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

必须改：`apps/desktop/src/main/codingDispatch.ts:39、43、54–67`：存在丢失续派唤醒的竞态：取消后的手动任务若在互斥拒绝的 catch 与 await 续体之间结束，`onTaskSettled` 调用的 `drain()` 会被 `draining` 拦掉，原排空随后直接退出，后继任务一直排队；需保留排空期间收到的唤醒，并补取消后执行器立即结束的测试。

建议：`apps/desktop/src/main/taskReport.ts:29–35`：回报去重未限定已经查到的来源对话，对全库消息执行 JSON 条件检索；建议按对话缩小范围，减少长聊天历史下的主进程同步查询开销。

建议：`apps/desktop/src/main/taskReport.ts:70–75`：取前八行之前先拆分、整理整份验证输出，大日志会增加内存占用并阻塞主进程；应只处理需要的前缀。

结论：需要修改
