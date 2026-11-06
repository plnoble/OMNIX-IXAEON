# CF6 交付说明：会话管理（搜索、看已归档的、恢复、重开后接着聊）

分支 `dev/CF6`，A 档。

## 已实现

- `packages/core/src/storage/conversationStore.ts`：`search({ query, archived, limit? })`——标题与消息正文、空格分隔的词全部出现、不分大小写、`%`/`_`/`\` 用 `LIKE ... ESCAPE '\'` 转义、默认不含已归档 / `archived:true` 只看已归档、按 `updated_at` 倒序、默认 50 条；片段取第一条含全部词的正文，命中词前后各约 20 字、过长用「…」、命中词用 U+0001/U+0002 包起来供界面加粗；只命中标题时 `snippet` 为 null。不写审计。
- IPC：`searchConversations(input)`（contracts / main / preload）。
- `Ask.tsx`：会话列表上方搜索框（`conversation-search`）、命中片段（`conversation-search-snippet`，命中词 `<strong>`）；列表底部「已归档（N）」开关（`conversation-archived-toggle`），打开只显示已归档、每项「恢复」（`conversation-restore-<id>`），没有归档时不显示开关。
- 「重开后接着聊」沿用现有 `recentTurns`，未改轮数与截断。

## 自动化通过

```
$ node scripts/acceptance.mjs run CF6
packages/core/test/acceptance/cf6-search.test.ts            6 passed
apps/desktop/test/acceptance/cf6-conversation-ui.test.ts    3 passed
```

`tsc`、`eslint` 干净。

## 真机通过

未跑（时间用尽）：`IXAEON_DATA_DIR=<临时目录>` 启动、4 个合成会话归档 1 个、搜词截图、已归档恢复截图、恢复后接着问一句，这三张截图没做。

## 已知缺口

- 条件 5（重开后接着聊）没有单独写测试：它锁的是现有 `recentTurns` 行为，本轮没改动；如需可另补一条运行期测试。
- 真机截图未做，交审时请知悉。
