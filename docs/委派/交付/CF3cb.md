# CF3cb 交付说明：撞红的旧锁定测试（第二支，基于 dev/CF3c）

## 进度

- [x] 1. 基于 `dev/CF3c`（已并入 `09dbdf7`）
- [x] 2. 跑 `acceptance.mjs run-done` 拿到实际红单（见下）
- [ ] 3. 按甲 / 乙 / 丙逐份改（**未完成**）
- [ ] 4. 端到端 `a4-follow-live-answer` / `d5a` / `d6` / `d7b` 按甲类改（**未完成**）
- [ ] 5. 本机四条命令全跑、推分支、等 CI

## 实际红单（`node scripts/acceptance.mjs run-done`，2026-11-04）

`Test Files 18 failed | 176 passed (194)`、`Tests 104 failed | 1345 passed (1449)`。红的是：

`a5-model-failure`、`cf3b-direct-chat`、`d1-coding-task-draft`、`d3-auto-dispatch-report`、`d4-landing-report`、
`d7b-executor-selection`、`g04-task-origin`、`g05-cancel-preparing`、`g05-cancel-preparing-extra`、
`g06-conversation-project`、`p4-project-folder`、`p5-unbind-folder`、`p6-revoked-folder`、`p7-preview-revoke`、
`p8-delete-project`、`t2a-ask-todos`、`t2b-coding-todos`，外加 `packages/relay` 的 `l16-watchdog`（疑计时偶发，另行单独重跑确认）。

## 分类（按规格：甲 换成 chatStreamClient 接缝 / IXAEON_FAKE_CHAT_SCRIPT；乙 改由任务页建任务；丙 不改，列退役）

### 甲类：只是借聊天当假模型通道，测的是别的（改接缝，断言一条不删不放宽）

`a5-model-failure`、`g05-cancel-preparing`、`g05-cancel-preparing-extra`、`g06-conversation-project`、
`p4-project-folder`、`p5-unbind-folder`、`p6-revoked-folder`、`p7-preview-revoke`、`p8-delete-project`、
`t2a-ask-todos`，以及 `cf3b-direct-chat` 里**除条件 17 以外**的各条。
做法：把「往 `askSessions` 塞一个 `{run: async()=>({answer…})}` 替身」换成
`chatStreamClient: () => 假客户端`（吐对应回答的 deltas）+ 一份有模型/地址/Key 的 config；
断言不变（取消、对话固定项目、项目文件夹、待办、工具、记忆标签、引擎标签）。

### 乙类：测的是聊天之后的事（派发 / 落地报告 / 执行器选择）

`d3-auto-dispatch-report`、`d4-landing-report`、`d7b-executor-selection`。
做法：任务改由 `coding.create` / `createCodingTask` 在任务页建，后面断言照旧；来源断言从「聊天这一轮」改成「任务页新建」，
逐条写明。

### 丙类：测的就是「聊天建任务 / 提议任务 / Hermes 自己的行为」（不改，列出来由整合方退役）

`d1-coding-task-draft`、`g04-task-origin`、`t2b-coding-todos`、
`cf3b-direct-chat` 的**条件 17**（「聊天模型没配 → 走现在的路径」，与 CF3c 条件 3 直接冲突）。

## 已实现

**尚无**（这一轮只拿到红单、分了类，没有开始改文件）。不重新登记任何旧任务指纹。

## 自动化通过

**未跑**（改完才谈得上）。CF3c 那支：`acceptance run CF3c` 12/12、integration 全绿、`tsc`/`eslint` 干净。

## 真机通过

**没跑**（属整单交付，等 CF3cb 改完一起做）。

## 用户接受

**待用户实测**。

## 下一轮从这里接

按上面三类逐份改（先甲类，11 份夹具形状接近，可套一个共用假客户端 helper），再乙类，再端到端四条；
然后 `run CF3c` / `run-done` / `verify` / `build + test-e2e desktop` 全跑，真机甲/乙，最后两支推、CI、队列 162 改「待复审（整合方）」。

## 本轮进度（2026-11-04 晚，未完成）

### 共用的假模型客户端

新建 `apps/desktop/test/acceptance/cf3cb-fake-chat.ts`（不是 `.test.ts`），导出 `installFakeChat(runtime)`：
给 `Object.create(AppRuntime.prototype)` 造的 runtime 挂一个测试专用 `askSessions`（普通 Map，旧的
`runtime.askSessions.set/get/size` 照旧能用）+ `chatStreamClient`（每次 stream 取「插入顺序里没用过的那个替身」，
调它的 `run()`，把 `answer` 当正文吐出）+ 一份三样齐的 `config.model`。

**引用它的测试**：`p5-unbind-folder`、`p4-project-folder`、`p7-preview-revoke`、`p8-delete-project`、
`a5-model-failure`、`g06-conversation-project`、`p6-revoked-folder`、`t2a-ask-todos`（均已加 import + 在 harness 里调用）。

### 各文件当前实测（只挂接缝、没有逐条改断言）

| 文件                       | 结果  | 说明                                                                                          |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `p5-unbind-folder`         | 13/18 | 5 条还红：靠替身 `run()` 里建草案/取消的副作用与 `invalidateContext` 观察，直连路径不产生     |
| `p4-project-folder`        | 9/10  | 1 条红：同上传导 P4 错误的方式变了（替身里抛错 → 直连把消息置 failed，断言看的是别处）        |
| `p7-preview-revoke`        | 10/11 | 1 条红：`invalidateContext` 观察                                                              |
| `p8-delete-project`        | 10/15 | 5 条红：取消在途任务并回报，依赖替身的副作用                                                  |
| `a5-model-failure`         | 0/10  | 全红：靠替身返回 `failedKind`/`steps` 判定模型失败，直连的失败来自客户端抛错，结构不同        |
| `g06-conversation-project` | 0/4   | 全红：断言「派给引擎的上下文」，名字里就写着引擎，需改成看 `chatStreamClient` 收到的 messages |
| `p6-revoked-folder`        | 3/10  | 7 条红：`propose_coding_task` 在替身里建草案的副作用 + 撤销后报错口径                         |
| `t2a-ask-todos`            | 0/4   | 全红：`建议待办`/`proposedTodos` 来自替身返回的 steps，直连下要从回答正文里抽                 |

### 未开始

- `g05-cancel-preparing` / `g05-cancel-preparing-extra`（harness 不是 `Object.assign(runtime,…)`，还没挂）
- `cf3b-direct-chat`（有 6 处 `hermesFound` + 条件 17，要按条拆甲/丙）
- 乙类 3 份、端到端 4 条、四条命令全跑、真机甲/乙——**都没做**

结论：接缝能整体过一部分文件的多数用例（p4 9/10、p7 10/11、p5 13/18），但剩下每一条要按原断言逐条改成看
`chatStreamClient` 收到的 messages / 从回答正文抽待办 / 用客户端抛错模拟失败，工作量还很大。状态保持
「窗口进行中（dev）」，队列 162 不改。
