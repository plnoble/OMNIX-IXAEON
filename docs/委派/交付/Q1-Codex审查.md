# Q1 Codex 审查

- 时间：2026-10-20T00:56:32.883Z
- 分支：grok/Q1（1b337db），对照 docs/委派/Q1-真机脚本体检.md
- Codex：0.163.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`docs/委派/交付/Q1.md:76`、`scripts/real/run-batch.mjs:79–93`：交付说明声称跑批器启动前会读取脚本源码、核对 `IXAEON_DATA_DIR`，实际代码直接启动子进程，没有这项检查；需更正说明并补充实际核对依据。需要人工确认：本轮逐脚本的临时数据目录核对究竟如何完成。
- 必须改｜`scripts/real/run-batch.mjs:51–52、88`：找到 `.bin/jiti.cmd` 时，会把这个批处理包装脚本交给 Node 解析，导致 `.ts` 脚本启动失败；应解析到真正的 JavaScript CLI 入口。
- 必须改｜`scripts/real/run-batch.mjs:106–115`：子进程 `exit` 时输出管道可能尚未读完，`out.end()` 也不会同步完成落盘；立即读取日志可能漏掉最后的 `RESULT`，甚至发生结束后继续写入。应等待子进程 `close` 和日志流 `finish` 后再生成摘要。
- 必须改｜`scripts/real/m3-address-scope.mjs:125`、`scripts/real/u1-research-busy.ts:122`、`scripts/real/v1-verify-electron.mjs:213`：异常信息仍未经遮罩直接打印；Electron 启动失败、临时文件访问失败时，错误信息可能包含带本机账户名的绝对路径，未满足规格的输出隐私要求。
- 建议｜`scripts/real/run-batch.mjs:71–76`：写摘要前应创建 `.logs/`；目录不存在时会直接报 `ENOENT`。需要人工确认：工作目录初始化流程是否保证预建该目录。

结论：需要修改
