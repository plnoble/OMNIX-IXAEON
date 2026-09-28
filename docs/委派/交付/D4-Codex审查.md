# D4 Codex 审查

- 时间：2026-09-28T16:49:49.287Z
- 分支：grok/D4（6fbaf6a），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`packages/core/src/execution/landing.ts:169–172`：目标路径的父目录可能是 HEAD 中的符号链接，`mkdirSync/cpSync` 会沿链接写到临时工作树之外，甚至修改用户当前工作区；必须检查真实路径边界。
- 必须改｜`packages/core/src/execution/landing.ts:143–147、169`：忽略了 `--show-toplevel` 返回的仓库根目录。项目位于仓库子目录时，冲突检查和写入都使用了错误的相对路径，新文件会被提交到仓库根目录。
- 必须改｜`packages/core/src/execution/landing.ts:147–166`：冲突检查与建工作树分别读取可变的 `HEAD`；用户在两步之间提交同一文件时，会绕过冲突检查。应将比对和建树绑定到同一个提交。
- 必须改｜`packages/core/src/execution/landing.ts:58–69`：读取 HEAD 文件的任何错误都被当成“不存在”；超过 `execFileSync` 默认缓冲上限的大文件也会返回 `null`，可能漏掉“派发后用户新增同名文件”的冲突。须区分文件不存在与读取失败，并支持大文件。
- 必须改｜`packages/core/src/execution/landing.ts:173–176`：`--` 不会关闭 Git 路径通配规则；删除 `[a].txt` 等文件时可能同时删除匹配的其他文件。应按字面路径执行 `add/rm`。
- 必须改｜`packages/core/src/execution/landing.ts:129–140`：项目自身的 `manifest.json` 会先被复制、再被补丁清单覆盖，导致改动包丢失内容；固定清单位置与原路径保存要求存在冲突，须交整合方明确无损处理方案。
- 必须改｜`packages/core/src/execution/landing.ts:154–162`：分支预检后若其他进程创建同名分支，`worktree add -b` 会失败，清理却无条件执行 `branch -D`，可能删除他人的分支；只能删除确认由本次操作创建的分支。
- 必须改｜`packages/core/src/execution/landing.ts:187–194、197`：成功路径吞掉清理错误后仍报告成功；失败路径的清理一旦抛错，又会跳过改动包生成。未满足“任何一步失败后无残留工作树”的要求，必须检查清理结果并如实记录失败。
- 必须改｜`packages/core/src/execution/landing.ts:48–59、166、185`：落地经 IPC 在主进程同步执行 Git，逐文件启动进程且没有超时；大项目或阻塞的钩子会冻结应用。应使用异步执行并设置超时。
- 必须改｜`packages/core/src/execution/landing.ts:180–182`：兜底身份只检查邮箱；配置了邮箱但缺少姓名、且启用 `user.useConfigOnly` 时仍会提交失败。须检查完整身份并应用兜底配置。
- 必须改｜`docs/委派/交付/D4.md:23`：实际涉及 10 个源码文件，新增 336 行、删除 3 行，共 339 行；超过 300 行硬限制，也与“8 个文件、约 260 行”的交付声明不符，须拆分并更正统计。
- 必须改｜`docs/委派/交付/D4.md:73`：`verify` 只有“全绿”的声明，没有按 AGENTS.md 贴出运行输出；须补齐实际验证证据，包括锁定验收核对结果。
- 建议｜`docs/委派/交付/D4.md:27`：需要人工确认：输入未包含三份锁定测试正文及指纹，无法据交付摘要核实断言是否覆盖全部条件、是否存在放宽，须由整合方核对。

结论：需要修改
