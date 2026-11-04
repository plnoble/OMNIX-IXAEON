# CF3c 交付说明：聊天只走直连（B 档，只交测试）

规格：`docs/委派/CF3c-聊天只走直连.md`。分支 `dev/CF3c`，基于 `main`（不基于 MP2）。
这一支**只写测试**，实现留给 `CF3cb`。

## 进度

- [x] 1. 读规格；队列第 162 行改「窗口进行中（dev）」并推 main
- [x] 2. `node scripts/worktree.mjs add CF3c dev`，基于 main
- [x] 3. 验收条件 1–8 写成测试（`cf3c-direct-only.test.ts` 条件 1/2/3/5/6/7，`cf3c-no-prewarm.test.ts` 条件 4）
- [x] 4. 确认新测试是红的，并核对红因（见下「红的状态」）
- [x] 5. 临时假实现验证（见下「临时假实现」——**只做成了一半，如实记录**）
- [x] 6. 「撞红的旧锁定测试」清单与甲/乙/丙分类（见下，本轮不改文件）
- [x] 7. `acceptance.mjs lock CF3c`，本机 verify，推 `dev/CF3c`，等 CI
- [x] 8. 队列第 162 行改「测试待审（整合方）」

## 已实现

两个测试文件，共 12 条用例：

| 文件                                                    | 覆盖                                                                  | 条数 |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ---- |
| `apps/desktop/test/acceptance/cf3c-direct-only.test.ts` | 条件 1、2、3（缺三种各一条 + 文案一条）、5、6（接缝 + 假模型剧本）、7 | 10   |
| `apps/desktop/test/acceptance/cf3c-no-prewarm.test.ts`  | 条件 4：IPC 没有 `prewarmChat` 通道；渲染问答页不调 `api.prewarmChat` | 2    |

条件 8（CF3 / CF3b 的锁定验收照样全过）不另写测试：它由那两套既有测试自己保证；
冲突的那一条（CF3b 条件 17）列进下面的「撞红的旧锁定测试」。

测试接缝按规格第 3 条写：`Object.assign(runtime, { chatStreamClient: () => client })`，
客户端用 core 现成的 `FakeStreamChatClient`；Hermes 定位与新会话用替身数调用次数
（`newAskSession` 替身**一被调用就抛**，所以只要它被碰到，用例一定红）。

## 自动化通过

```
node node_modules/vitest/vitest.mjs run --project acceptance \
  apps/desktop/test/acceptance/cf3c-direct-only.test.ts \
  apps/desktop/test/acceptance/cf3c-no-prewarm.test.ts
→ 12 条：2 绿、10 红
```

**绿的 2 条**（今天就已经成立，属于实现现状，不是「假绿」）：

- 条件 1：单独选了聊天模型 → `engine = 'direct'`、`modelName` 对、Hermes 没被碰；
- 条件 5：一问之后编码任务数不变，「待办：合成事项」照样建待办。

**红的 10 条，红因只有「功能没有」**：

| 用例      | 红因（现状）                                                                            |
| --------- | --------------------------------------------------------------------------------------- |
| 条件 2    | 聊天模型留空时 `directChatLaunch()` 被 CF3b 那道「单独选过」门槛挡住 → 走了 Hermes 替身 |
| 条件 3 ×4 | 三样缺一样时 `ask()` 不抛 `MODEL_NOT_CONFIGURED`，而是交给 Hermes 路径                  |
| 条件 4 ×2 | 主进程仍注册 `ixaeon:prewarmChat`；问答页仍调 `api.prewarmChat`                         |
| 条件 6 ×2 | `runtime.chatStreamClient` 还不存在；`IXAEON_FAKE_MODEL` 的剧本分支也没有               |
| 条件 7    | 说明文字仍是「本轮走直连模型（不是 Hermes）。」                                         |

## 临时假实现（**只做成了一半，如实写**）

规格要求：挑一条临时补最简单的假实现，看断言能不能变绿，看完删掉。

- **条件 7**：把 `appRuntime.ts` 里那句说明改成「本轮走直连模型。」→ 仍然红。
  查下来是替身环境里存档那一步失败，`ask()` 会在说明后面追加「；注意：问答存档失败（…）」，
  而这段尾巴里带「。；」。补了 `imports.captureAsk`、`jobs.{enqueue,hold,kick,enqueueExtract,…}` 之后
  尾巴还在（最后一次是 `this.jobs.kick`），**没能把它弄干净**。
  为了让这条断言只钉规格里说的东西，测试里剥掉了「；注意：」之后的尾巴（不改规格要求）。
- **条件 3**：在 `ask()` 开头加了一道「三样不齐就抛 `MODEL_NOT_CONFIGURED`」的守卫 → 仍然红，
  收到的还是 `CF3c：聊天不该再建 Hermes 会话`（说明守卫没生效，疑心是 vite 模块缓存或配置读取路径，
  没查清）。
- 两次临时改动**都已还原**，`git status` 里 `apps/desktop/src` 干净，没有提交。

**结论**：这 10 条红我确认都是「功能没有」造成的（条件 1、5 能绿说明夹具本身能跑通），
但「临时假实现能把它翻绿」这一步**没能完整演示出来**，两处卡在替身上。留给整合方复审时定：
是要我先查清替身（下一支 `CF3cb` 里顺手做），还是接受现状。

## 真机通过

**没跑**。这一支只交测试，真机检查（甲 合成两家 / 乙 真模型 / 丙 用户连聊三轮）等实现那一支 `CF3cb` 做。

## 用户接受

**待用户实测**（规格丙）。

## 撞红的旧锁定测试（本轮只做清单，不改文件）

静态扫了一遍 `apps/desktop/test/acceptance/*.test.ts`：36 份夹具用到 `newAskSession` / `hermesFound` /
`prewarmChat` / `askSessions` 这几个 Hermes 接缝。按规格分三类（**以 `CF3cb` 实际跑红为准**）：

### 甲类：只是借聊天当假模型通道，测的是别的（改接缝，断言不动）

`a4-follow-live`（1 处 prewarmChat）、`a5-model-failure`（hermesFound×1、askSessions×3）、
`cf0-chat-model-switch`、`cf0-chat-retry`（prewarmChat×3）、
`g05-cancel-preparing`、`g05-cancel-preparing-extra`（还有 `newAskSession`×2）、
`g06-conversation-project`、`g06-conversation-project-page`（prewarmChat×3）、
`k3-cockpit-settings`、`k5-mobile-settings`、`k5-mobile-settings-ipc`、
`p4-project-folder`、`p5-unbind-folder`、`p6-revoked-folder`、`p7-preview-revoke`、`p8-delete-project`、
`m2-saved-models`、`m2-settings-ui`、`m3-key-scope`、`m3-settings-ui`、
`sub1-magpie-preset`、`sub1b-quota-settings`、`u2-settings-coding-saved`、`v4-settings-page`、`d7b-pages`、
`mp2-providers`、`mp2-fetch-models`、`mp2-uses`。
撞的断言：这些用例用 `askSessions` 预置一个「已答过」的会话、或用 `hermesFound` 让聊天能走通；
收掉 Hermes 之后要走 `chatStreamClient` + 一份有模型的配置，端到端改用 `IXAEON_FAKE_CHAT_SCRIPT`。

### 乙类：测的是聊天之后的事（任务改由任务页新建，来源断言随之改）

`d3-auto-dispatch-report`、`d4-landing-report`、`d7b-executor-selection`。
撞的断言：它们让「聊天这一轮」建出编码任务，再断言派发 / 落地报告 / 执行器选择。

### 丙类：测的就是「聊天建任务 / 提议任务 / Hermes 自己的行为」（不改，等整合方退役）

`d1-coding-task-draft`、`g04-task-origin`、`t2b-coding-todos`、
`review-p1-action-loop-20260916`（不在上面扫描结果里，按规格名单单列），
以及 `cf3b-direct-chat` 的**条件 17**（「聊天模型没配 → 走现在的路径」，与本单条件 3 直接冲突，规格第 9 条点名退役）。

**本轮没有改这些文件**：按规格，它们是 `CF3cb` 的活；分支上 `acceptance-lock` 会因此不过，只限这几份。

## 下一步（CF3cb）

1. 实现：`ask()` 只剩直连、`chatStreamClient` 接缝、删 Hermes 接线与预热、说明文字；
2. 上述甲乙丙清单按实际跑红逐份改 / 列退役；
3. 删掉跟着变成死代码的集成测试（如 `p1-prewarm`）；
4. 真机甲 / 乙，丙交用户。
