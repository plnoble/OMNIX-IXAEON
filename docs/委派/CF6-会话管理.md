# 规格 CF6：会话管理（搜索、看已归档的、恢复、重开后接着聊）

档位：**A**。只读本地库、只改界面和本地查询，不发任何东西给模型，也不改记忆。源码约 200 行，超过 300 行就拆成 CF6 / CF6b。

依赖：CF1（聊天做首页）、CF3c（聊天只走直连）已并入。

来源：用户 10-31 定的第 1 阶段先后（CF0 → CF1 → CF2 → CF3 → CF6 → CF4 → CF5），队列第 152 行。产品分工（用户 11-03）：聊天对标 ChatGPT，会话要能找、能收、能接着聊。

## 现在有什么

- `ConversationStore` 已有 `rename`、`archive`、`unarchive`、`list({ includeArchived })`；
- IPC 已有 `renameConversation`、`archiveConversation`、`unarchiveConversation`；
- 聊天页（`Ask.tsx`）的会话列表已经能改名、能归档。

## 要什么

1. **搜会话**：聊天页会话列表上面加一个搜索框。
   - 按标题和消息正文找，不分大小写。空格隔开的几个词要全部出现，在标题或任一条消息里都算。
   - 输入后列表只剩匹配的会话；清空搜索框回到原样。
   - 每个匹配的会话下面显示一小段命中的原文：命中词前后各约 20 个字，命中词加粗。只命中标题的不显示片段。
   - 已归档的会话不参与搜索，除非正在看「已归档」（第 2 条）。
   - 查询在主进程做：`ConversationStore.search(input: { query: string; archived: boolean; limit?: number })`，返回 `Array<ConversationSummary & { snippet: string | null }>`，默认最多 50 条，按最近更新排。IPC 是 `searchConversations(input)`。
   - 用 SQL 的 `LIKE`（转义 `%`、`_`、`\`）。不建索引表、不加迁移。
2. **看已归档的**：会话列表底部加一个「已归档（N）」的开关。
   - 打开后列表只显示已归档的会话，每项有「恢复」；点「恢复」就移回正常列表。
   - 一个都没有时不显示这个开关。
3. **重开后接着聊**：点开一个旧会话（含刚恢复的）再问，模型收到的上文包括这个会话之前的几轮。
   - 就是现在 `recentTurns` 那一套，不改它的轮数和截断规则。
   - 这一条主要是把行为锁住，现在要是已经对了，就不用改代码。
4. **数据安全**：搜索只读；片段只给界面看，不写日志、不进审计、不发给模型。

## 约束

- 不改 `recentTurns` 的规则、不改直连聊天发给模型的内容、不加迁移。
- 不碰记忆、待办、任务。
- 不新增网络访问。

## 验收条件

1. `search`：
   - 标题命中、正文命中都能找到；几个词要全部出现，缺一个就不算；
   - 不分大小写；
   - `%`、`_` 当普通字符，搜 `50%` 不会把所有会话都找出来；
   - 默认不含已归档的，`archived: true` 时只返回已归档的；
   - 按最近更新排、最多 `limit` 条。
2. 片段：
   - 正文命中时片段里含命中词，前后各不超过约 20 个字，太长用「…」截断；
   - 只命中标题时 `snippet` 为 `null`。
3. 界面：
   - 搜索框输入后列表只剩匹配的会话，片段里的命中词加粗；
   - 清空回到原样；
   - data-testid：`conversation-search`、`conversation-search-snippet`。
4. 已归档：
   - 「已归档（N）」开关的数字对；打开后只显示已归档的，「恢复」后它回到正常列表、N 减一；
   - 没有已归档的会话时不显示开关；
   - data-testid：`conversation-archived-toggle`、`conversation-restore-<id>`。
5. 重开后接着聊：
   - 用替身直连客户端（照 `mp3-chat.test.ts` 的办法），会话先聊两轮、归档、恢复，再问一句；
   - 这一次发给模型的消息里依次带着前两轮的问和答。
6. 搜索不写审计、不写日志：搜一次之后 `audit_events` 行数不变。

## 真机检查

设 `IXAEON_DATA_DIR=<临时目录>` 启动，用合成对话（建 4 个会话、归档 1 个）：

- 搜一个词，截图看到片段和加粗；
- 打开「已归档」，恢复那一个，截图；
- 在恢复的会话里接着问一句，看回答接得上前文（模型用本机 magpie 或假模型都行，写明用的哪个）。

## 交付

A 档：测试和实现一起交，测试放 `apps/desktop/test/acceptance/cf6-*.test.ts` 和 `packages/core/test/acceptance/cf6-*.test.ts`，`acceptance.mjs lock CF6 ...` 登记。Codex 审过、CI 绿，自己合并。交付说明 `docs/委派/交付/CF6.md`。
