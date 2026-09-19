# W1a 关注方向 交付

- 分支：grok/W1a，基于 main `cd7fad7`；档位 B（**先只交测试**）
- 执行方：Grok

## 已实现

未实现。本单按 v2 B 档先把规格 5 条验收条件写成测试。

测试假设的 IPC / runtime：

- `previewWatchDirections()` → `{ memoryCount }`（确认框条数，不发模型）
- `suggestWatchDirections()` → 用 `getProvider()` 提方向，过滤拒绝过的 / 已有主题
- `followWatchDirection(...)` → `createTopic` + `setEnabled(true)`
- `skipWatchDirection(...)` → `app_settings` 记拒绝过的方向

界面：研究页顶上 `research-suggest`，确认 `research-suggest-confirm` / `-ok` / `-cancel` / `-count`，卡片 `research-direction-<i>`。

## 验收测试（v2 规格任务）

| 文件                                                           | 条件    |
| -------------------------------------------------------------- | ------- |
| `apps/desktop/test/acceptance/w1a-suggest-topics-page.test.ts` | 1、3    |
| `apps/desktop/test/acceptance/w1a-suggest-topics.test.ts`      | 2、4、5 |

当前 5 条全红。未锁定。

## 自动化通过

- `node scripts/verify.mjs`：EXIT=0
- GitHub 上的 verify：没看

## 真机通过

规格要求的真模型提方向在实现阶段跑。本阶段没跑。

## Codex 审查（A 档）

B 档，不跑 Codex。

## 已知缺口

- 条件 2 用 `FakeProvider.structuredCalls`，实现需走 `chatStructured`。
- 条件 5 的「相似」按待办那套字符二元组 Jaccard ≥ 0.6；测试里两条人形机器人方向应被滤掉。
- `createAssistantSuggestion` 不能写 `goal`，测试用 `open_loop` 代表没采纳的 AI 建议。

## 用户接受

未发生。
