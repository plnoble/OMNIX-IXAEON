# D4 Codex 审查

- 时间：2026-09-28T08:49:35.814Z
- 分支：grok/D4（9d2e034），对照 docs/委派/D4-接受后在项目里建分支.md
- Codex：0.158.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`docs/委派/交付/D4.md:13、27`：送审说明声称已有两份、18 条补强测试，但完整 diff 仍只有旧版 9 条，桌面测试也未出现。需要人工确认：补强版本是否尚未提交或 diff 已过期；交付说明、测试结果与送审分支必须一致。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:309`：钩子没有设置执行权限，POSIX 上 Git 会跳过它，无法可靠触发提交失败，正确实现也会因此验收失败。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:168–179、206–223`：工作区保护只从干净仓库起测，指纹也不记录文件内容和完整暂存差异；无法发现已有暂存、未暂存或未跟踪内容被覆盖，未充分覆盖条件 1。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:250–256`：用户提交发生在 `dispatch` 之前，不是条件 3 要求的派发之后；只在派发时检查冲突、接受时不复查的实现仍能通过。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:284–294`：授权只测流程开始前撤销，未覆盖接受前撤销、有效授权不包含项目、父目录授权包含项目及项目缺少根目录，无法落实契约 2 的落地前授权核对。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:188–203、258–281`：把改动包全部文件拼成文本搜索路径，不能证明清单存在或正确区分修改、新增、删除及冲突；还漏验新增文件内容、删除落地和 `applied_ref` 精确指向包目录，契约 4、5 未覆盖完整。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:305–315`：清理仅测提交失败，未覆盖工作树建立后写入等中途失败，也未断言成功后的工作树清理，无法覆盖条件 8 和契约 4、7。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:148–150`：批准、派发后直接接受，没有检查此前尚未落地；提前创建分支或改动包的实现仍能通过，漏验“只在接受之后落地”。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:88–91、206–224`：仓库没有远端，也没有推送副作用断言；有远端时自动推送的实现可能通过全部测试，漏验明确的“不推送”约束。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:154–165、221–222`：从未读取或断言 `applied_at`，提交正文只检查任务 id，没有检查验证结果，漏验成功时间和提交正文契约。
- 必须改｜`packages/core/test/acceptance/d4-apply-branch.test.ts:239`：分支重名用例只检查数据库字符串，没有确认 `-2` 分支实际存在并包含改动；仅填写成功引用的实现也能通过条件 2。
- 必须改｜`docs/委派/交付/D4.md:13`、`packages/core/test/acceptance/d4-apply-branch.test.ts:206–224、317–332`：实际 diff 未包含对话回报或任务页展示测试，建分支、改动包、没有改动三种回报及追加语义均未验证，契约 6 缺失。

结论：需要修改
