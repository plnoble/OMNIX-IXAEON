# CF6 Codex 审查

- 时间：2026-11-06T13:30:09.453Z
- 分支：dev/CF6（3a386ae），对照 docs/委派/CF6-会话管理.md
- Codex：0.167.0；上下文由脚本喂入（不让 Codex 跑命令）

- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:525–528,582`：归档视图始终渲染 `archivedList`，忽略搜索结果，并禁止显示片段；在「已归档」中输入关键词不会筛选或显示加粗片段。
- 必须改｜`apps/desktop/src/renderer/src/pages/Ask.tsx:125–153`：搜索仅随关键词和归档视图变化刷新；搜索期间归档、删除或改名后，`reloadList` 不更新 `searchResults`，列表会保留已归档、已删除或不再匹配的会话。
- 必须改｜`packages/core/src/storage/conversationStore.ts:473`：要求单条正文包含全部词才生成片段，与搜索允许各词分布在标题和不同消息中的规则不一致；现有测试中的「周报 三部分」会命中正文却返回 `null`。
- 必须改｜`packages/core/src/storage/conversationStore.ts:478–479`：片段终点固定为首次命中位置加 60；三字关键词后会保留 57 字，违反前后各约 20 字的条件。`cf6-search.test.ts:112` 的总长小于 120 断言未锁住该条件。
- 必须改｜`packages/core/src/storage/conversationStore.ts:481–482`、`apps/desktop/src/renderer/src/pages/Ask.tsx:585–592`：逐词替换会产生嵌套标记，例如搜索「周报模板 周报」；界面拆分后只取前两段，会丢掉原文后续内容，需避免重复标记并覆盖重叠关键词。
- 必须改｜`packages/core/test/acceptance/cf6-search.test.ts:61–95`：没有大小写交叉命中的正例；通配符测试缺少 `50abc`、`axb` 等干扰项，不转义也能通过；亦未验证默认最多 50 条。需补齐契约测试并重新锁定。
- 必须改｜`apps/desktop/test/acceptance/cf6-conversation-ui.test.ts:156–172`：测试未执行清空搜索；归档测试未断言正常会话被排除、恢复后回到正常列表及数量减少。恢复替身只从归档集合删除，也未移入正常集合，无法验证所声称的恢复行为。
- 必须改｜`scripts/real/cf6-ui-check.mjs:110–119`、`docs/委派/交付/CF6.md:23–33`：续聊检查允许跳过输入或吞掉发送失败，固定等待后截图，未核对回答是否承接前文。需要人工确认：所列截图的实际回答及假模型是否用于当前直连链路；补齐观察结果后才能标为「真机通过」。
- 必须改｜`docs/委派/交付/CF6.md:36–38`：明确记录完整本地 verify 未通过，却自行以 CI 替代，不符合仓库要求；需处理环境阻塞、完成验证并附原始输出。
- 建议｜`apps/desktop/src/renderer/src/pages/Ask.tsx:128–129`：需要人工确认：`list({ includeArchived: true })` 的默认上限；当前从带 `LIMIT` 的列表筛选归档并计算 N，若默认限量，较旧归档会遗漏且计数偏小。
- 建议｜`packages/core/src/storage/conversationStore.ts:206–213`：每次输入触发搜索后，又同步载入每个匹配会话的全部正文来找一个片段；长会话会增加主进程阻塞和内存占用，宜只读取所需命中正文并减少连续输入的重复查询。

结论：需要修改
