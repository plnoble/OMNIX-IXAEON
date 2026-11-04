# CF3cb 交付说明：撞红的旧锁定测试（第二支，基于 dev/CF3c）

状态：**分类表待整合方看**（2026-11-04）。本轮只做逐条分类，**没有改任何测试**，也没接着改实现。

## 已回退

上一轮那版做法方向不对，已整体回退（`git revert`）：

- 不再给 runtime 挂测试专用的 `askSessions` Map（生产里没有它，断言 `.set/.get/.size` 等于测测试自己造的 Map，等于没测）；
- 不再让替身 `run()` 替用户建草案 / 取消在途任务（CF3c 之后聊天不建任务，不许让模型模拟这个能力）；
- 不再为让测试过而发明功能（比如「从回答正文抽待办」）。

## 分类口径

- **甲**：测的是别的（取消、对话/项目归属、文件夹拦截、撤销、删除、用户自写待办、模型失败的用户可见结果）。改成看生产里真实存在的东西：消息状态、库里记录、`chatStreamClient` 收到的 messages、`AbortSignal` 有没有触发。原断言一条不删不放宽。
- **乙**：测的是「项目文件夹 / 解绑 / 撤销 / 删除项目之后任务怎么样」。任务改由 `coding.create` / `createCodingTask` 在任务页直接建，来源断言改成「任务页新建」，后面的派发/回报/取消断言照旧。
- **丙**：测的就是 Hermes 会话本身 / 聊天建草案 / 聊天提议待办 / Hermes 专有的失败种类（steps、failedKind）。不改，列出来由整合方退役。

## 分类表（覆盖 run-done 红的 104 条 + 端到端 4 条，共 108 条）

统计：甲 14 · 乙 55 · 丙 34 · 非本单 1（relay l16）。

| 文件                       | it 标题                                                                                | 甲/乙/丙 | 打算怎么改                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 1：模型调用失败 → failed +                      | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它（都看库里真实记录） |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 1（半截）：失败前已经答出的内容照常保留         | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它（都看库里真实记录） |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 2：失败轮不存档、不排提炼、回报没有「问         | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它（都看库里真实记录） |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 3：下一轮的上下文里没有这一轮                   | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它（都看库里真实记录） |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 4：工具失败但模型最后正常回答 → co              | 丙       | 断的是 Hermes / core-bounded 的 steps、failedKind（直连没有这些种类）；用户可见结果那几条才改甲               |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 6：正常回答的内容里恰好含「模型动作失败         | 丙       | 断的是 Hermes / core-bounded 的 steps、failedKind（直连没有这些种类）；用户可见结果那几条才改甲               |
| a5-model-failure           | A5（整合方补）：真的工具循环出错，ask 怎么收尾 > 模型调用失败（假模型没有响应          | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它（都看库里真实记录） |
| a5-model-failure           | A5（整合方补）：真的工具循环出错，ask 怎么收尾 > 条件 7：到了轮次上限还没形            | 丙       | 断的是 Hermes / core-bounded 的 steps、failedKind（直连没有这些种类）；用户可见结果那几条才改甲               |
| a5-model-failure           | A5（整合方补）：真的工具循环出错，ask 怎么收尾 > 对照：真的工具循环正常回答（          | 丙       | 断的是 Hermes / core-bounded 的 steps、failedKind（直连没有这些种类）；用户可见结果那几条才改甲               |
| a5-model-failure           | A5（整合方补）条件 8：Hermes 的结果没有 answer 步，不许误判 > 引                       | 丙       | 断的是 Hermes / core-bounded 的 steps、failedKind（直连没有这些种类）；用户可见结果那几条才改甲               |
| cf3b-direct-chat           | CF3b 条件 10–17：聊天走直连模型 > 条件 17：聊天模型没配 → 走现在的                     | 丙       | 条件 17「聊天模型没配 → 走现在的路径」与 CF3c 条件 3 直接冲突，随本单退役                                     |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 1：项目对话正在回答时提草案 → 建出任务挂在                 | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 1/契约 2：显式 scope 存项目内相对路                        | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 2/契约 3：只有个人对话在回答时，参数里带了                 | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 2：正在回答的对话不属于项目 → 报错，不建任                 | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 3：两个项目对话同时在回答 → 报错，不建任务                 | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 3（整合方定）：项目对话和个人对话同时在回答                | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 4：参数不合法 → VALIDATION_FA                              | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 4 对照：合法上限都能建出草案（目标 2000                    | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 5：参数里写了别的项目 → 不认，照正在回答的                 | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 约束：草案不批准、不派发、不跑任何命令（回答结束后也            | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 契约 4：验证命令留空的草案，验收回报里如实写「还没              | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 整合方补：没写 scope 的草案派发后，改项目里的                   | 丙       | 测的就是「聊天里提编码任务草案」这个能力，CF3c 之后聊天不建任务                                               |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 1：点「要做」就派发，点击立即返回不等                    | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 2：第二个等第一个结束后才开始，顺序按                    | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：做完验证通过 → 对话里回报含目标                       | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：没有验收条件时回报不列验收条件，没                    | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：改动超过十个文件时只列十个并写总数                    | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：验证没跑时写原因                                      | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：两个对话各有一个任务，回报只写进各                    | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 4：验证失败 → 回报含原因                                 | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 4：执行失败 → 回报含原因                                 | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 4：取消正在执行的任务 → 一句话回报                       | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 5：找不到 Codex → 不派发，任                             | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 5：已有任务在执行时才发现没有 Cod                        | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 任务页手动派发的任务还在执行时点「要做」：那                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 排队中的任务被取消：对话里有一句话回报，下一                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 两个同时排队的任务按批准先后派发，同时间戳也                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 正在执行的任务失败后，排队的下一个照常开始                    | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 手动派发的任务执行中点「要做」，再取消手动任                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 点击时空闲，派发前有任务抢先执行：那个任务结                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 手动任务已取消但执行器还没退出时点「要做」：                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 派发被拒的任务不卡住后面的：跳过它继续派下一                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 手动任务结束后队首派发被拒：跳过它继续派后面                  | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 取消后执行器立即结束：后继照常开始                            | 乙       | 任务改由 coding.create 在任务页建；「点要做就派发 / 顺序 / 回报 / 取消 / 找不到 Codex」等断言照旧             |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 建了分支：追加一条回报，说清分支名、没推送、怎么      | 乙       | 任务改由 createCodingTask 建；「接受之后回报」那几条断言照旧                                                  |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 没能建分支（不是 git 仓库）：回报原因和改动           | 乙       | 任务改由 createCodingTask 建；「接受之后回报」那几条断言照旧                                                  |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 没能建分支（你先一步提交了同一个文件）：回报点名      | 乙       | 任务改由 createCodingTask 建；「接受之后回报」那几条断言照旧                                                  |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 没有改动：回报里如实写「没有改动」，追加不改写        | 乙       | 任务改由 createCodingTask 建；「接受之后回报」那几条断言照旧                                                  |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 真实 IPC 入口：点「接受」走的那条通道也触发           | 乙       | 任务改由 createCodingTask 建；「接受之后回报」那几条断言照旧                                                  |
| d7b-executor-selection     | 条件 1：默认交给 Codex——与现在一模一样 > 没有 coding                                   | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 1：默认交给 Codex——与现在一模一样 > 选的是 Codex（                                | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 1：默认交给 Codex——与现在一模一样 > 选的是 Codex                                  | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 4：选了「我的模型」——点「要做」到建出分支 > 网关执行器做完 →                      | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 5：模型要改范围外的文件 > 任务失败，回报里有那个路径和「我的模型                  | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 12（整合方复审实现时补）：模型自己说做不到——回报里有它说的原因                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 12（整合方复审实现时补）：模型自己说做不到——回报里有它说的原因                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 没选模                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 选的模                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 没配                      | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 补好设                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 7、8：按派发那一刻的设置走 > 改了设置不用重启：同一个运行时里先                   | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| d7b-executor-selection     | 条件 7、8：按派发那一刻的设置走 > 跑到一半改了设置：这个任务记的还是                   | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                       |
| g04-task-origin            | G04 编码任务按运行归属 > 条件 1 与 4：别人运行建的任务和没有归属的旧任务都不           | 丙       | 测的是聊天这一轮建的任务的 origin_run_id 归属，聊天已不建任务                                                 |
| g04-task-origin            | G04 编码任务按运行归属 > 条件 1：那个任务出现在它自己的运行（对话 B）的回答里          | 丙       | 测的是聊天这一轮建的任务的 origin_run_id 归属，聊天已不建任务                                                 |
| g04-task-origin            | G04 编码任务按运行归属 > 条件 2：同一项目两轮并发，各自的任务各归各的回答              | 丙       | 测的是聊天这一轮建的任务的 origin_run_id 归属，聊天已不建任务                                                 |
| g05-cancel-preparing-extra | 第一次提问还没有会话时，准备阶段取消：不建会话、不调用模型、回答是                     | 甲       | 准备阶段取消：不建任何东西、chatStreamClient 没被调用、回答 cancelled                                         |
| g05-cancel-preparing-extra | 回答进行中取消时，会话收到的是这一轮的 runId                                           | 丙       | 断言 Hermes 会话收到的 runId（会话不存在了）                                                                  |
| g05-cancel-preparing       | G05 准备阶段也能取消 > 条件 1：补齐还没结束时取消，返回成功；放行后不                  | 甲       | 看真实的东西：准备阶段取消后不落消息、不发给模型（chatStreamClient 没被调用）、消息状态 cancelled             |
| g05-cancel-preparing       | G05 准备阶段也能取消 > 条件 2：不取消时照常调用模型，回答是 comp                       | 甲       | 看真实的东西：准备阶段取消后不落消息、不发给模型（chatStreamClient 没被调用）、消息状态 cancelled             |
| g05-cancel-preparing       | G05 准备阶段也能取消 > 条件 3：回答进行中取消，返回成功，取消之后的内                  | 甲       | 看真实的东西：准备阶段取消后不落消息、不发给模型（chatStreamClient 没被调用）、消息状态 cancelled             |
| g06-conversation-project   | G06 对话的项目固定（后端） > 条件 2：在 A 的对话里提问，派                             | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪一段项目近况）；不一致时拒绝、模型一次没被调用                 |
| g06-conversation-project   | G06 对话的项目固定（后端） > 条件 3：传来与对话不一致的 pr                             | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪一段项目近况）；不一致时拒绝、模型一次没被调用                 |
| g06-conversation-project   | G06 对话的项目固定（后端） > 整合方补：「全部项目」和某个项目之                        | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪一段项目近况）；不一致时拒绝、模型一次没被调用                 |
| g06-conversation-project   | G06 对话的项目固定（后端） > 整合方补：刚点「新对话」还没发第一                        | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪一段项目近况）；不一致时拒绝、模型一次没被调用                 |
| p4-project-folder          | P4 验收条件 4：D1 聊天里提编码任务——没绑文件夹拦，绑好放行 > 没绑文件夹                | 乙       | 任务改由 coding.create 建（不经聊天），断言没绑文件夹时拦下（P4 文案）、绑好后能建                            |
| p5-unbind-folder           | 条件 2：解除之后这个项目派不了编码任务 > 聊天里提、点「要做」、任务页批准，都报        | 乙       | 任务改由 coding.create 建；断言解绑后三个入口都报 P4、在途任务取消并回报                                      |
| p5-unbind-folder           | 条件 3：解除时在途的任务被取消，别的不动 > 执行中的、排队的取消并在各自的对话里回      | 乙       | 任务改由 coding.create 建；断言解绑后三个入口都报 P4、在途任务取消并回报                                      |
| p5-unbind-folder           | 条件 3：解除时在途的任务被取消，别的不动 > 验证中的任务也取消                          | 乙       | 任务改由 coding.create 建；断言解绑后三个入口都报 P4、在途任务取消并回报                                      |
| p5-unbind-folder           | 条件 7：预览 > 不改任何东西；要取消的、等接受的、资料数、授权怎么处理都对              | 乙       | 任务改由 coding.create 建；断言解绑后三个入口都报 P4、在途任务取消并回报                                      |
| p5-unbind-folder           | 条件 10：解除绑定让对话上下文失效 > 正在用的会话被作废（照 revokeSour                  | 丙       | 断言 Hermes 会话被 invalidateContext（会话已不存在）                                                          |
| p6-revoked-folder          | 条件 1：绑着文件夹、授权撤销了 > propose_coding_task：授权还                           | 丙       | 测的就是聊天里的 propose_coding_task 提议草案                                                                 |
| p6-revoked-folder          | 条件 5：上级文件夹的授权还有效 > 算有授权：聊天里提、点「要做」自动派发，任务页        | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                    |
| p6-revoked-folder          | 条件 7：没绑文件夹的项目 > 三个入口报的还是 P4 那一句，不是这一句                      | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                    |
| p6-revoked-folder          | 条件 3、4：自动派发 > 轮到它：跳过、留在排队、对话里一条 folder_mis                    | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                    |
| p6-revoked-folder          | 条件 3、4：自动派发 > 排着队的任务、项目后来没了文件夹：走同一条路，回报里是           | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                    |
| p6-revoked-folder          | 条件 3、4：自动派发 > 宿主的 folderGap 回调：给了就照它说的拦、话原                    | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                    |
| p6-revoked-folder          | 条件 8：已经在执行的任务 > 执行途中授权撤销：任务照常跑完，不被拦下、不被取消，        | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                    |
| p7-preview-revoke          | 条件 12：照界面那条路撤销之后（预览 → revokeSourceReading）                            | 丙       | 断言撤销后「正在用的会话作废」（invalidateContext），会话已不存在                                             |
| p8-delete-project          | 条件 4：没绑文件夹的项目 > 照原来那样删掉；不撤销什么、不取消什么；审计里没有          | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                         |
| p8-delete-project          | 条件 4：没绑文件夹的项目 > 没绑文件夹、却还有排着队的任务（老数据）：照样先取消        | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                         |
| p8-delete-project          | 条件 4：没绑文件夹的项目 > 没绑文件夹、却还有验证中的任务（老数据）：也算在途，        | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                         |
| p8-delete-project          | 条件 5：删除时有排队、执行中的任务 > 先取消（那一刻项目还在、授权还有效）并回报        | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                         |
| p8-delete-project          | 条件 6：拒绝；上下文失效 > 项目不存在：拒绝，什么都不变；删除成功让正在用的对话        | 丙       | 其中「正在用的对话上下文失效」靠 invalidateContext，会话已不存在                                              |
| t2a-ask-todos              | AI 在回答末尾列的待办 > 落成等你拍板的待办，记着来自哪次对话、哪条回答；回答里去掉那一 | 丙       | 测的是「AI 在回答末尾列待办 → 落成待办」这个机制，直连不提供提议待办的通道，不新造                            |
| t2a-ask-todos              | AI 在回答末尾列的待办 > 你拒绝过的同一件事不再提，也不出现在这条回答上                 | 丙       | 测的是「AI 在回答末尾列待办 → 落成待办」这个机制，直连不提供提议待办的通道，不新造                            |
| t2a-ask-todos              | AI 在回答末尾列的待办 > 回答里没有这一段：不建待办，也不记 proposedTodos               | 丙       | 测的是「AI 在回答末尾列待办 → 落成待办」这个机制，直连不提供提议待办的通道，不新造                            |
| t2a-ask-todos              | 你在消息开头写「待办：」 > 直接加成要做的待办，记着是你哪条消息；回答上注明已加        | 甲       | 用户自己写「待办：…」是 parseUserTodo，走真实机制；断言看库里待办与消息 meta                                  |
| t2b-coding-todos           | 编码任务进待办 > 这一轮提出的编码任务成了等你拍板的待办，标题取任务第一行，记在这条    | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                          |
| t2b-coding-todos           | 编码任务进待办 > 拍板「要做」= 批准编码任务并排队                                      | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                          |
| t2b-coding-todos           | 编码任务进待办 > 「不做」= 取消还没开始的编码任务                                      | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                          |
| t2b-coding-todos           | 编码任务进待办 > 编码任务完成了，待办跟着算做完                                        | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                          |
| t2b-coding-todos           | 编码任务进待办 > 你拒绝过的同样的事又被提出来：不进待办，起草的编码任务自动取消        | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                          |
| l16-watchdog               | 条件 6：看门人管收听 > 整合方补：--exit-when-idle 退出前停掉还挂着的                   | —        | 不是本单的验收（packages/relay 看门人），单独重跑确认是否计时偶发                                             |
| e2e/a4-follow-live-answer  | 端到端：跟真回答（聊天）                                                               | 甲       | IXAEON_FAKE_MODEL=1 + IXAEON_FAKE_CHAT_SCRIPT 供剧本回答；断言照旧                                            |
| e2e/d5a-acceptance-first   | 端到端：首屏验收含聊天                                                                 | 甲       | 同上，聊天段用假剧本                                                                                          |
| e2e/d6                     | 端到端：会话/问答主流程                                                                | 甲       | 同上                                                                                                          |
| e2e/d7b                    | 端到端：执行器选择                                                                     | 甲       | 同上（模型段走假剧本；任务段照旧）                                                                            |

## 拿不准（请整合方定）

1. `a5-model-failure`「条件 4：工具失败但模型最后正常回答」「条件 6：正常回答正好含「模型动作失败」」——直连也有工具循环，但断言抓到的是 `steps`/结构化 `failedKind`。我暂归**丙**；如果整合方认为「模型失败但最后正常回答 → complete」这条用户可见结论要保留，可归甲、改成看最终消息状态。
2. `p8-delete-project`「条件 6：删除成功让正在用的对话上下文失效」——「任务先取消并回报」是乙，但「上下文失效」靠 `invalidateContext`（会话已不存在）。我暂整条归**丙**；若要把「任务部分」拆出来按乙测，请示意。
3. `p4-project-folder`「没绑文件夹…绑好再提能建出草案」——既有「聊天里提」又有「文件夹拦截」。按「文件夹之后任务怎么样」归**乙**（任务改用 `coding.create` 建）；若整合方认为「聊天里提」这一层仍要保留，则归丙。
4. `l16-watchdog`（`packages/relay`）不属于 CF3c 验收，疑负载计时偶发；我会单独重跑，单独能过就写「跟本单无关」。

## 端到端四条（甲）

`a4-follow-live-answer` / `d5a-acceptance-first` / `d6` / `d7b` 用 `IXAEON_FAKE_MODEL=1` + `IXAEON_FAKE_CHAT_SCRIPT` 供剧本回答，断言照旧（`d7b` 的任务段照旧）。

## 下一步（等整合方看表后再动）

按表逐条改：先甲（看真实东西），再乙（任务改 `coding.create` 建），丙只登记不改；然后端到端、四条命令、真机甲/乙。全部通过才把队列 162 改「待复审（整合方）」。当前 162 保持「窗口进行中（dev）」。
