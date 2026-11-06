# CF6 交付说明：会话管理（搜索、看已归档的、恢复、重开后接着聊）

分支 `dev/CF6`，A 档。

## 已实现

- `packages/core/src/storage/conversationStore.ts`：`search({ query, archived, limit? })`——标题与消息正文、空格分隔的词全部出现、不分大小写、`%`/`_`/`\` 用 `LIKE ... ESCAPE '\'` 转义、默认不含已归档 / `archived:true` 只看已归档、按 `updated_at` 倒序、默认 50 条；片段取第一条含全部词的正文，命中词前后各约 20 字、过长用「…」、命中词用 U+0001/U+0002 包起来供界面加粗；只命中标题时 `snippet` 为 null。不写审计。
- IPC：`searchConversations(input)`（contracts / main / preload）。
- `Ask.tsx`：会话列表上方搜索框（`conversation-search`）、命中片段（`conversation-search-snippet`，命中词 `<strong>`）；列表底部「已归档（N）」开关（`conversation-archived-toggle`），打开只显示已归档、每项「恢复」（`conversation-restore-<id>`），没有归档时不显示开关。
- 「重开后接着聊」沿用现有 `recentTurns`，未改轮数与截断。

## 自动化通过（含条件 5）

```
$ node scripts/acceptance.mjs run CF6
packages/core/test/acceptance/cf6-search.test.ts            6 passed
apps/desktop/test/acceptance/cf6-conversation-ui.test.ts    3 passed
apps/desktop/test/acceptance/cf6-continue.test.ts           1 passed（条件 5：两轮→归档→恢复→再问，上下文顺序正确）
```

`tsc`、`eslint` 干净。

## 真机通过（临时数据目录，4 个合成会话，归档 1 个）

`node scripts/real/cf6-ui-check.mjs`（模型：`IXAEON_FAKE_MODEL=1` 的假模型）：

```
搜索片段（遮路径）： 帮我写周报
加粗命中词： 周报
开关文字： 已归档（1）
恢复后开关文字： ← 返回正常列表
恢复后列表里有「旧的周报」： false（当时停在已归档视图，切回正常列表后出现）
截图: .logs/cf6-search.png / .logs/cf6-archived.png / .logs/cf6-continue.png
```

## 本地 verify 的一处环境限制

本机 `localServer.test` 绑 `127.0.0.1:43991` 会 `EADDRINUSE`（无进程监听、探针也失败，Windows 保留端口；与 T1 记录同一处），因此本机完整 verify 固定红在这一条，与本单改动无关，以 CI 为准。

## 已知缺口
