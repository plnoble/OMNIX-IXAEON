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
恢复后列表里有「旧的周报」： false（当时停在已归档视图；切回正常列表后出现）
续聊这一轮的消息条数（含前文轮次）： 4
最后一轮有回答正文： true
模型：IXAEON_FAKE_MODEL=1（fake-direct，走直连链路）
截图: .logs/cf6-search.png / .logs/cf6-archived.png / .logs/cf6-continue.png
```

## 本地 verify 的一处环境限制

本机 `node scripts/verify.mjs` 跑到 integration 一步固定红：

```
FAIL  |integration| apps/desktop/test/integration/localServer.test.ts
Error: listen EADDRINUSE: address already in use 127.0.0.1:43991
✗ integration（Vitest 集成测试） 失败（55.2s）
```

原因是这个端口被 Windows 保留：**没有任何进程监听**、单独丢一个 `net.createServer().listen(43991)` 探针也照样 `EADDRINUSE`（与 T1 记录同一处；`net stop winnat` 需要管理员，本会话拿不到）。其余步骤（lint / format / typecheck / build / unit / acceptance）都是绿的。这一条与本单改动无关，CI（windows-latest）已绿；本机这一项如实记为「环境阻塞、未通过」，不冒充通过。

## 已知缺口

## Codex 审查（三轮到上限，转整合方）

- 第 1 轮（退出码 1）：补条件 5 测试、补真机与 verify 记录。已做：`cf6-continue.test.ts`（10/10）、三张截图与输出、verify 原始输出。
- 第 2 轮（退出码 1）：要求加强搜索契约（大小写交叉命中、通配符干扰项、默认 50 条）、界面（清空搜索、归档视图排除正常会话、恢复后回正常列表与计数）、续聊检查不许吞错。已做：两处测试都加强并重锁；续聊改成「等消息条数 +2，否则抛错」，并打印条数与非空。
- 第 3 轮（退出码 1）：仍要求「续聊证据更强（如何证明接得上前文）」与「本机 verify 必须解除阻塞」。续聊那条已用 e2e/test-id 层能拿到的证据（4 条消息：前两轮问答 + 新问答，最后一轮正文非空），本机 verify 的阻塞是 Windows 保留端口 43991（无监听、探针也 EADDRINUSE、`net stop winnat` 需管理员），本会话无法解除。

按 AGENTS.md「最多三轮，第三轮仍是需要修改就停下、转整合方」，本分支**不合并**，队列第 152 行改「待复审（整合方）」，请整合方决定：续聊证据要补到什么程度、以及本机 verify 的端口阻塞怎么处理（或接受 CI 作为门禁口径）。

## 整合方复审（2026-11-06）

**结论：通过，并入 main。** Codex 第三轮还是「需要修改」，按三轮上限转整合方。两条意见整合方这样定：

1. **续聊证据**：认开发方补的 `cf6-continue.test.ts`——两轮问答、归档、恢复、再问一遍，断言这一次发给模型的上下文里前两轮按顺序都在。「重开后接着聊」要证明的就是上下文接得上，这条测试正是在这一层证明的；真模型答得对不对，交给用户实际用（用户接受）。
2. **本机门禁卡在 43991 端口**：不是 CF6 的问题。`apps/desktop/test/integration/localServer.test.ts` 写死了 43991，本机这个端口落在 Windows 保留的范围里，`listen` 直接 EADDRINUSE。这个测试的请求全走 `app.inject`，用不到固定端口——改成 `port: 0`（系统给空闲端口），本机 9/9 过。

### 自动化通过

`acceptance run CF6`：10/10；`localServer` 集成测试（改端口后）：9/9。分支 CI 见并入提交。

### 真机通过

开发方的 `scripts/real/cf6-ui-check.mjs`（替身模型）：搜索、归档视图、恢复后续聊三张截图，续聊那一轮带上了前两轮。真模型续聊没跑。

### 用户接受

未发生：要重新打安装包装上，用户自己搜一次、归档恢复一次、接着聊一次。
