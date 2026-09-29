# D4 Codex 审查

- 时间：2026-09-28T18:22:18.554Z
- 分支：grok/D4（1a9fde2），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/execution/landing.ts:198-202`：项目位于仓库子目录时，复制目标仍是 `wt/rel`，暂存目标却是 `wt/gitRel(rel)`；文件写错位置，正常修改也会因没有可提交内容而回退改动包。
- 必须改｜`packages/core/src/execution/landing.ts:137`：直接比较工作区字节与 Git blob 的哈希；启用 `core.autocrlf` 或 `eol=crlf` 时，干净文件的 CRLF 与 blob 的 LF 也会被判为冲突。需统一比较表示并补充用例。
- 必须改｜`packages/core/src/execution/patchPack.ts:58-67`：同时修改 `manifest.json` 和 `manifest.json.project` 时，两份内容写入同一路径，必有一份被覆盖；自定改名也违反按原路径保存的契约，须退回整合方明确撞名方案。
- 必须改｜`packages/core/src/execution/executor.ts:615-622`：异步落地期间任务可以被删除；即使 `landTask` 已发现记录消失并记审计，此处仍调用 `setLanding`，失败后再次调用，最终抛错且无法正常回报。需协调删除与落地，完整处理记录不存在的情况。
- 必须改｜`apps/desktop/src/renderer/src/pages/Tasks.tsx:48`：分支存在时直接返回成功文案，忽略 `apply_error`，工作树清理失败等警告不会显示在任务页；交付说明声称此处已同步修复，与代码不符。
- 必须改｜`docs/委派/交付/D4.md:23`：仅两个新增源码模块就有 354 行，超过每任务 300 行的硬上限；拆文件不等于拆任务。须由整合方拆单，并修正仍使用旧版本行数的交付统计。
- 建议｜`packages/core/src/execution/patchPack.ts:32`、`packages/core/src/execution/landing.ts:170`：同步复制和递归删除仍会阻塞桌面主进程，大文件或大型工作树下会卡住界面；应改用异步文件操作或后台执行。
- 建议｜`docs/委派/交付/D4.md:27`：需要人工确认：本次材料未包含三份锁定验收测试源码及锁定指纹，无法仅凭交付摘要核实实际断言是否完整覆盖条件、是否存在放宽。

结论：需要修改
