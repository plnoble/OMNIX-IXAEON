# CF6 Codex 审查

- 时间：2026-11-06T13:41:10.357Z
- 分支：dev/CF6（6dc8760），对照 docs/委派/CF6-会话管理.md
- Codex：0.167.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:525`：归档视图始终渲染 `archivedList`，忽略搜索结果，且第 582 行禁止显示归档搜索片段；因此在「已归档」中搜索不会过滤或加粗。需补对应界面测试。
- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:153`：搜索只随查询词和视图变化刷新；搜索后归档、删除或改名，`reloadList()` 不更新 `searchResults`，已归档或已删除的会话仍留在结果中。
- 必须改｜`packages/core/src/storage/conversationStore.ts:473`：片段要求所有词出现在同一条消息，严于搜索匹配条件；现有测试的「周报 三部分」能找到会话，却得到 `null` 片段，违反正文命中应显示片段的要求。
- 必须改｜`packages/core/src/storage/conversationStore.ts:479`：截取终点固定为首次命中位置加 60，三字命中词后会保留 57 字，超过约 20 字；`cf6-search.test.ts:115` 仅断言总长小于 120，放宽了验收条件，应分别检查前后文长度。
- 必须改｜`packages/core/src/storage/conversationStore.ts:482`：逐词替换会再次加工已标记文本；例如搜索 `JavaScript Java` 会产生嵌套标记，界面的 `split` 随后丢失部分原文。需处理重复、重叠关键词并补回归测试。
- 必须改｜`packages/core/test/acceptance/cf6-search.test.ts:64`：标为“不分大小写”的测试没有任何大小写不同的正向匹配断言；另外缺少反斜杠转义和默认最多 50 条的测试，尚未锁住这些契约。
- 必须改｜`scripts/real/cf6-ui-check.mjs:116`：仅等待消息元素增加、检查最后一个元素非空，加载或错误占位也可能通过，不能证明回答完成且接得上前文。需要人工确认：实际截图中的回答是否满足这一要求，并补充检查证据后再报告“真机通过”。
- 必须改｜`docs/委派/交付/CF6.md:38`：本机 `verify` 明确未通过，尚未满足 AGENTS.md 的合并要求；环境阻塞虽已如实记录，仍需解除阻塞、重跑并补通过记录，不能用 CI 绿替代。
- 建议｜`apps/desktop/src/renderer/src/pages/Ask.tsx:128`：需要人工确认：`list({ includeArchived: true })` 的默认上限；底层存在 `LIMIT`，若默认限量，过滤返回列表计算归档数量会漏掉较旧归档，甚至隐藏入口。
- 建议｜`packages/core/src/storage/conversationStore.ts:207`：每次搜索都同步读取每个匹配会话的全部正文，标题命中也如此；长会话配合逐字搜索会增加主进程阻塞和内存开销，建议在 SQL 中筛选生成片段所需的消息。

结论：需要修改
