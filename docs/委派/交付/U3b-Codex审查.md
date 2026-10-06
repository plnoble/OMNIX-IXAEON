# U3b Codex 审查

- 时间：2026-10-06T07:38:16.645Z
- 分支：prep/U3b（eb8fe52），对照 docs/委派/U3b-任务页看改动-界面.md
- Codex：0.160.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`docs/委派/交付/U3b.md:3、15`、`docs/委派/交付/U3.md:50`：当前完整 diff 仍包含 U3，源码改动合计 453 行，且 U3 的违规改测、重锁仍待整合方复核；须先完成该关卡并合入 U3，再更新 U3b 基线，不能借 U3b 的 A 档合并绕过复核。
- 必须改｜`packages/core/src/execution/taskChanges.ts:63–66、205–219`：链接检查与打开文件仍然分离；检查后、`openSync` 前替换文件或父目录为链接，`fstat` 仍会允许读取越界的普通文件；文件在大小检查后增长也没有限量读取保护，fd 方案尚未消除这些并发漏洞。
- 必须改｜`packages/core/test/acceptance/u3-task-changes.test.ts:42–44、372–380`：实现改用 `readFileSync(fd)` 后，读取记录保存的是描述符数字，后续按文件路径排查禁止读取的断言失效；须由整合方修正读取追踪并复核锁定测试。
- 必须改｜`apps/desktop/src/renderer/src/pages/Tasks.tsx:124–133`：请求未完成时可收起再展开，两次请求共用状态；旧请求失败会覆盖新请求的状态，而新请求成功只更新 `data`，可能一直显示旧错误；需要隔离过期请求的回调。
- 必须改｜`docs/委派/交付/U3b.md:31–33`：验收与 verify 只有“全过／全绿”的结论，缺少仓库要求的实际输出；需要人工确认：当前提交的 GitHub verify 是否通过，并补充对应运行证据。
- 建议｜`apps/desktop/src/main/ipc.ts:625`、`packages/core/src/execution/taskChanges.ts:90–98`：`async` handler 内仍同步计算 LCS，50 个各 2000 行的文件最多执行约两亿次单元计算，期间阻塞 Electron 主进程；应优化或移出主进程，并验证该规模的响应情况。
- 建议｜`packages/core/src/execution/taskChanges.ts:258–264`、`packages/core/test/acceptance/u3-task-changes.test.ts:499–501`：当前先输出整份差异再扣预算，单个合法大小的文件即可让返回差异超过 200000 字符，测试也允许越界；需要人工确认：规格要求硬上限，还是允许最后一个文件超出预算。
- 建议｜`docs/委派/交付/U3b.md:25–27、37`：需要人工确认：被引用的《U3-任务页看改动.md》条件 11、12 及真机检查原文未提供，无法确认现有测试和四步脚本是否完整覆盖原始要求。

结论：需要修改
