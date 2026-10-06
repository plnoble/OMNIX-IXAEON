# U3 Codex 审查

- 时间：2026-10-06T06:15:11.979Z
- 分支：prep/U3（421b2b4），对照 docs/委派/U3-任务页看改动.md
- Codex：0.160.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改 `packages/core/src/execution/taskChanges.ts:51`：`linkOnPath` 只检查根目录下面的路径段，不检查根目录本身；副本根或项目根是链接时仍会读取目标文件，违反“不跟链接、不读内容”的契约，需补根目录链接测试。
- 必须改 `packages/core/src/execution/taskChanges.ts:190`：授权拒绝发生在链接、普通文件检查之后；撤销授权时可能返回其他原因，并继续探查两边路径，未满足“每个文件统一提示没有授权、副本也不读”的要求。
- 必须改 `packages/core/src/execution/taskChanges.ts:270`：授权条件允许 `root_path` 是普通文件；项目目录被文件替代后仍可能通过授权判断，契约要求目录仍然存在，应仅接受目录。
- 必须改 `packages/core/src/execution/taskChanges.ts:228`：比较空行数组时未要求两边都存在，新增或删除空文件会被误报为 `same`，隐藏实际文件变更；需保留 `added`／`deleted` 并补测试。
- 必须改 `packages/core/src/execution/taskChanges.ts:22`：删除全部末尾空行会吞掉实际空白行改动，并让超过 2000 行的尾部空行绕过行数限制；应区分文件终止换行与实际空白行。
- 必须改 `packages/core/src/execution/taskChanges.ts:229`、`packages/core/test/acceptance/u3-task-changes.test.ts:262`：用归一化后的文本判断换行差异，使纯 CRLF／LF 差异提示“一样”；测试也明确接受了这个错误结果，放宽了条件 5。应比较原始内容识别换行差异，已锁定测试由整合方修正并重锁。
- 必须改 `packages/core/src/execution/taskChanges.ts:243`：`baseHashes[rel] ?? null` 混淆“没有这一项”和“明确记录为新文件”；报告缺少该路径指纹、项目文件存在时会误报基准漂移，必须先检查该项是否存在。
- 必须改 `packages/core/test/acceptance/u3-task-changes.test.ts:184`：仅断言第一段没有远处改动，不能验证“3 行以外的未改动行不出现”；输出 4 行上下文也能通过当前测试，需新增明确检查上下文边界及相接合段的测试。
- 必须改 `packages/core/test/acceptance/u3-task-changes.test.ts:312`：安全用例只检查返回内容，没有验证禁止读取的文件确实未被读取；先读取密钥、越界文件或超大文件再丢弃内容也能通过，需补充文件读取断言。
- 必须改 `docs/委派/交付/U3.md:44`：明确尚未执行规定的真机检查，也未提供四步原始输出；规格允许拆分界面，但没有免除“没跑不能合并”的门槛，合并前须补齐检查证据。
- 建议 `docs/委派/交付/U3.md:40`：需要人工确认：最新提交对应的 GitHub verify 是否通过；当前仍是占位说明，没有可核对的运行号或链接。

结论：需要修改
