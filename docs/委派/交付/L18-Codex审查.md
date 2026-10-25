# L18 Codex 审查

- 时间：2026-10-25T12:28:52.561Z
- 分支：dev2/L18（cb32f50），对照 docs/委派/L18-看门人换了代码自己重起.md
- Codex：0.164.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改：`packages/relay/bin/relay.mjs:52`：切换子进程 `cwd` 后仍原样传入相对路径的 `IXAEON_WORKTREES`、`IXAEON_RELAY_CODE`，看门人会相对于新目录再次解析，导致使用错误目录；应在切换前统一解析为绝对路径。
- 必须改：`scripts/real/l18-forever.mjs:171`：收到第一个看门人 PID 就推提交，没有按规格等第一棒完成；脚本可能在第一棒尚未执行时重启并判通过。需按规定时序检查并重新记录真机输出。
- 必须改：`scripts/real/l18-forever.mjs:193、199`：子进程输出直接写入 stdout/stderr，绕过 `mask`；发生 Git、依赖安装等错误时可能输出含账户名的临时路径，不满足临时目录遮蔽要求。
- 必须改：`packages/relay/test/acceptance/l18-forever.test.ts:152`：`forever: false` 时没有清除继承的 `IXAEON_RELAY_FOREVER`；在该变量为 `1` 的环境中运行验收，条件 4 实际仍启用自更新检查，会错误退出 75。
- 必须改：`packages/relay/test/acceptance/l18-forever.test.ts:276`：仅比较参数数组的前两项，额外参数也能通过，放宽了条件 5 的完整参数要求；应比较整个数组。
- 建议：`packages/relay/test/acceptance/l18-forever.test.ts:186`：需要人工确认：实际锁文件路径。测试检查 `relay.lock`，随附 README 写的是 `lock.json`；若实际使用后者，当前断言无法验证条件 2 的锁释放。

结论：需要修改
