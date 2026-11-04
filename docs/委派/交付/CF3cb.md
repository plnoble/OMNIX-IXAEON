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
