# CF6 Codex 审查

- 时间：2026-11-06T12:58:17.576Z
- 分支：dev/CF6（7981342），对照 docs/委派/CF6-会话管理.md
- Codex：0.167.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:525、582`：归档视图始终渲染 `archivedList`，忽略搜索结果且禁止显示片段；因此查看已归档时搜索无效。
- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:125、153`：搜索结果只随搜索词和归档视图变化刷新；搜索期间归档、删除或改名后，`reloadList` 不更新搜索结果，会继续显示已归档、已删除或不再匹配的会话。
- 必须改｜`packages/core/src/storage/conversationStore.ts:474`：片段要求同一条消息包含全部搜索词，与查询允许词分布在标题及不同消息中的行为不一致；已有用例“周报 三部分”会找到会话却返回空片段。
- 必须改｜`packages/core/src/storage/conversationStore.ts:480`、`packages/core/test/acceptance/cf6-search.test.ts:112`：截取终点固定为首命中位置加 60，三字命中词后会保留 57 字，超过约 20 字；测试仅断言总长度小于 120，放宽了验收条件。
- 必须改｜`packages/core/src/storage/conversationStore.ts:483`、`apps/desktop/src/renderer/src/pages/Ask.tsx:588`：逐词替换会生成嵌套标记，例如搜索 `OpenAI AI`；界面拆分时只保留前两个部分，会丢失命中词后的原文。
- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:652`：恢复最后一个归档会话后，`archivedView` 仍为真，开关继续显示；不符合“没有已归档会话时不显示开关”的条件，应退出空归档视图并隐藏开关。
- 必须改｜`packages/core/test/acceptance/cf6-search.test.ts:61、73`：没有大小写不同但应匹配的正向用例；通配符测试也缺少 `50abc`、`aXb` 等干扰数据，未转义的实现同样能通过，不能锁住大小写和字面字符匹配契约。
- 必须改｜`apps/desktop/test/acceptance/cf6-conversation-ui.test.ts:149、168`：测试没有清空搜索，也没有验证归档列表排除正常会话、恢复后回到正常列表及 N 减一；恢复替身仅删除归档项，没有移入正常列表，实际断言只检查了调用记录。
- 必须改｜`docs/委派/交付/CF6.md:28`：明确遗漏验收条件 5；沿用旧实现不能免除锁定测试，必须使用替身直连客户端验证两轮聊天、归档、恢复后再次提问携带完整且顺序正确的历史。
- 必须改｜`docs/委派/交付/CF6.md:20、24`：真机检查明确未跑，完整 `verify.mjs` 通过输出也未提供；仓库明确规定真机未跑不能合并，须完成规定检查并补齐验证证据。
- 建议｜`packages/core/src/storage/conversationStore.ts:206`：每次搜索都会同步读取每个匹配会话的全部消息正文，最多涉及 50 个完整会话；建议只读取生成片段所需的消息，降低连续输入时阻塞主进程的风险。
- 建议｜`apps/desktop/src/renderer/src/pages/Ask.tsx:128`：需要人工确认：`list({ includeArchived: true })` 的默认条数上限；若返回结果被截断，再筛选归档会导致 N 偏小，甚至隐藏仍有归档会话的入口。

结论：需要修改
