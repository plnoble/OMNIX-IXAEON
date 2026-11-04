# CF3cb 交付说明：撞红的旧锁定测试（第二支，基于 dev/CF3c）

状态：**按整合方定的分类开始改**（2026-11-04）。分类已按整合方改判更新：甲 24 · 乙 55 · 丙 23 · 甲+乙 1 · 非本单 1。

## 已回退（上一版做法）

- 不给 runtime 挂测试专用 `askSessions`；不替用户建草案/取消任务；不为过测试发明功能。

## 分类口径（按整合方 2026-11-04 改判）

- **甲**：直连照样走这些机制，改看生产真实存在的东西（消息状态、库记录、`chatStreamClient` 收到的 messages、AbortSignal），断言不删不放宽。**含整合方改回甲的四组**：t2a「AI 回答末尾列待办」（extractSuggestedTodos 对直连同样生效）、a5 条件 4/6/7/对照（failedKind 对 engine 'direct' 同样生效）、p5 条件 10 / p7 条件 12 / p8 条件 6 的上下文失效（隐私：下一问 messages 里不该有被撤销/解绑/删掉的内容）、g05-extra「这一轮 runId」（改成两轮并发只中断被取消那轮）。
- **乙**：任务改由 `coding.create` / `createCodingTask` 在任务页建，来源断言改「任务页新建」，后续断言照旧。
- **丙**：测的就是 Hermes 会话本身 / 聊天建草案 / 聊天提议待办 / Hermes 专有失败种类，列退役不改。

## 丙类清单与理由（列退役，不改）

- `d1-coding-task-draft` 全部 12 条：测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务。
- `g04-task-origin` 3 条：测聊天这一轮建的任务的 `origin_run_id` 归属，聊天已不建任务。
- `t2b-coding-todos` 全部 5 条：测聊天这一轮建的编码任务进待办，聊天已不建任务。
- `p6` 条件 1「propose_coding_task…」：测聊天里的 `propose_coding_task` 提议草案。
- `a5` 条件 8「Hermes 的结果没有 answer 步」：Hermes 专有。
- `cf3b` 条件 17「聊天模型没配 → 走现在的路径」：与 CF3c 条件 3 直接冲突。

## 分类表（run-done 红的 104 条 + 端到端 4 条 = 108 行）

| 文件                       | it 标题                                                                                | 甲/乙/丙 | 打算怎么改                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 1：模型调用失败 → failed +                      | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它                                                                        |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 1（半截）：失败前已经答出的内容照常保留         | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它                                                                        |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 2：失败轮不存档、不排提炼、回报没有「问         | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它                                                                        |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 3：下一轮的上下文里没有这一轮                   | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它                                                                        |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 4：工具失败但模型最后正常回答 → co              | 甲       | 假客户端先来一次工具调用失败、再来一次正常回答；断言消息 complete、正文是正常回答（不看 steps）                                                                  |
| a5-model-failure           | A5 模型出错的轮记成失败（后端） > 条件 6：正常回答的内容里恰好含「模型动作失败         | 甲       | 正文里写「模型动作失败」但实际是正常回答 → 断言消息 complete、不误判                                                                                             |
| a5-model-failure           | A5（整合方补）：真的工具循环出错，ask 怎么收尾 > 模型调用失败（假模型没有响应          | 甲       | 替身改成客户端抛错；断言消息状态 failed、errorMessage、失败轮不存档、下一轮上下文里没有它                                                                        |
| a5-model-failure           | A5（整合方补）：真的工具循环出错，ask 怎么收尾 > 条件 7：到了轮次上限还没形            | 甲       | 直连也有轮次上限：假客户端造到超上限，断言消息 failed、说明含「已达轮次上限」                                                                                    |
| a5-model-failure           | A5（整合方补）：真的工具循环出错，ask 怎么收尾 > 对照：真的工具循环正常回答（          | 甲       | 假客户端正常回答；断言消息 complete、正文正确                                                                                                                    |
| a5-model-failure           | A5（整合方补）条件 8：Hermes 的结果没有 answer 步，不许误判 > 引                       | 丙       | Hermes 没有 answer 步这条是 Hermes 专有，随本单退役                                                                                                              |
| cf3b-direct-chat           | CF3b 条件 10–17：聊天走直连模型 > 条件 17：聊天模型没配 → 走现在的                     | 丙       | 条件 17「聊天模型没配 → 走现在的路径」与 CF3c 条件 3 冲突，退役                                                                                                  |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 1：项目对话正在回答时提草案 → 建出任务挂在                 | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 1/契约 2：显式 scope 存项目内相对路                        | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 2/契约 3：只有个人对话在回答时，参数里带了                 | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 2：正在回答的对话不属于项目 → 报错，不建任                 | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 3：两个项目对话同时在回答 → 报错，不建任务                 | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 3（整合方定）：项目对话和个人对话同时在回答                | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 4：参数不合法 → VALIDATION_FA                              | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 4 对照：合法上限都能建出草案（目标 2000                    | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 条件 5：参数里写了别的项目 → 不认，照正在回答的                 | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 约束：草案不批准、不派发、不跑任何命令（回答结束后也            | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 契约 4：验证命令留空的草案，验收回报里如实写「还没              | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d1-coding-task-draft       | 聊天里提编码任务草案 > 整合方补：没写 scope 的草案派发后，改项目里的                   | 丙       | 测的就是「聊天里提编码任务草案」，CF3c 之后聊天不建任务                                                                                                          |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 1：点「要做」就派发，点击立即返回不等                    | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 2：第二个等第一个结束后才开始，顺序按                    | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：做完验证通过 → 对话里回报含目标                       | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：没有验收条件时回报不列验收条件，没                    | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：改动超过十个文件时只列十个并写总数                    | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：验证没跑时写原因                                      | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 3：两个对话各有一个任务，回报只写进各                    | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 4：验证失败 → 回报含原因                                 | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 4：执行失败 → 回报含原因                                 | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 4：取消正在执行的任务 → 一句话回报                       | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 5：找不到 Codex → 不派发，任                             | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 条件 5：已有任务在执行时才发现没有 Cod                        | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 任务页手动派发的任务还在执行时点「要做」：那                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 排队中的任务被取消：对话里有一句话回报，下一                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 两个同时排队的任务按批准先后派发，同时间戳也                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 正在执行的任务失败后，排队的下一个照常开始                    | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 手动派发的任务执行中点「要做」，再取消手动任                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 点击时空闲，派发前有任务抢先执行：那个任务结                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 手动任务已取消但执行器还没退出时点「要做」：                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 派发被拒的任务不卡住后面的：跳过它继续派下一                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 手动任务结束后队首派发被拒：跳过它继续派后面                  | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d3-auto-dispatch-report    | 点「要做」就开工并回报 > 取消后执行器立即结束：后继照常开始                            | 乙       | 任务改由 coding.create 在任务页建；派发/顺序/回报/取消断言照旧                                                                                                   |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 建了分支：追加一条回报，说清分支名、没推送、怎么      | 乙       | 任务改由 createCodingTask 建；「接受之后回报」断言照旧                                                                                                           |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 没能建分支（不是 git 仓库）：回报原因和改动           | 乙       | 任务改由 createCodingTask 建；「接受之后回报」断言照旧                                                                                                           |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 没能建分支（你先一步提交了同一个文件）：回报点名      | 乙       | 任务改由 createCodingTask 建；「接受之后回报」断言照旧                                                                                                           |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 没有改动：回报里如实写「没有改动」，追加不改写        | 乙       | 任务改由 createCodingTask 建；「接受之后回报」断言照旧                                                                                                           |
| d4-landing-report          | 接受之后把落地结果回报给原对话 > 真实 IPC 入口：点「接受」走的那条通道也触发           | 乙       | 任务改由 createCodingTask 建；「接受之后回报」断言照旧                                                                                                           |
| d7b-executor-selection     | 条件 1：默认交给 Codex——与现在一模一样 > 没有 coding                                   | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 1：默认交给 Codex——与现在一模一样 > 选的是 Codex（                                | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 1：默认交给 Codex——与现在一模一样 > 选的是 Codex                                  | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 4：选了「我的模型」——点「要做」到建出分支 > 网关执行器做完 →                      | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 5：模型要改范围外的文件 > 任务失败，回报里有那个路径和「我的模型                  | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 12（整合方复审实现时补）：模型自己说做不到——回报里有它说的原因                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 12（整合方复审实现时补）：模型自己说做不到——回报里有它说的原因                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 没选模                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 选的模                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 没配                      | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么 > 补好设                    | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 7、8：按派发那一刻的设置走 > 改了设置不用重启：同一个运行时里先                   | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| d7b-executor-selection     | 条件 7、8：按派发那一刻的设置走 > 跑到一半改了设置：这个任务记的还是                   | 乙       | 任务改由 coding.create 建；执行器选择与派发快照断言照旧                                                                                                          |
| g04-task-origin            | G04 编码任务按运行归属 > 条件 1 与 4：别人运行建的任务和没有归属的旧任务都不           | 丙       | 测聊天这一轮建的任务的 origin_run_id 归属，聊天已不建任务                                                                                                        |
| g04-task-origin            | G04 编码任务按运行归属 > 条件 1：那个任务出现在它自己的运行（对话 B）的回答里          | 丙       | 测聊天这一轮建的任务的 origin_run_id 归属，聊天已不建任务                                                                                                        |
| g04-task-origin            | G04 编码任务按运行归属 > 条件 2：同一项目两轮并发，各自的任务各归各的回答              | 丙       | 测聊天这一轮建的任务的 origin_run_id 归属，聊天已不建任务                                                                                                        |
| g05-cancel-preparing-extra | 第一次提问还没有会话时，准备阶段取消：不建会话、不调用模型、回答是                     | 甲       | 准备阶段取消：不建任何东西、chatStreamClient 没被调用、回答 cancelled                                                                                            |
| g05-cancel-preparing-extra | 回答进行中取消时，会话收到的是这一轮的 runId                                           | 甲       | 改成两轮并发、取消其中一轮：断言只有那一轮的请求被中断（AbortSignal），另一轮照常完成                                                                            |
| g05-cancel-preparing       | G05 准备阶段也能取消 > 条件 1：补齐还没结束时取消，返回成功；放行后不                  | 甲       | 看真实的东西：准备阶段取消后不落消息、chatStreamClient 没被调用、消息 cancelled                                                                                  |
| g05-cancel-preparing       | G05 准备阶段也能取消 > 条件 2：不取消时照常调用模型，回答是 comp                       | 甲       | 看真实的东西：准备阶段取消后不落消息、chatStreamClient 没被调用、消息 cancelled                                                                                  |
| g05-cancel-preparing       | G05 准备阶段也能取消 > 条件 3：回答进行中取消，返回成功，取消之后的内                  | 甲       | 看真实的东西：准备阶段取消后不落消息、chatStreamClient 没被调用、消息 cancelled                                                                                  |
| g06-conversation-project   | G06 对话的项目固定（后端） > 条件 2：在 A 的对话里提问，派                             | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪段项目近况）；不一致时拒绝、模型一次没被调用                                                                      |
| g06-conversation-project   | G06 对话的项目固定（后端） > 条件 3：传来与对话不一致的 pr                             | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪段项目近况）；不一致时拒绝、模型一次没被调用                                                                      |
| g06-conversation-project   | G06 对话的项目固定（后端） > 整合方补：「全部项目」和某个项目之                        | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪段项目近况）；不一致时拒绝、模型一次没被调用                                                                      |
| g06-conversation-project   | G06 对话的项目固定（后端） > 整合方补：刚点「新对话」还没发第一                        | 甲       | 改看 chatStreamClient 收到的 messages（带的是哪段项目近况）；不一致时拒绝、模型一次没被调用                                                                      |
| p4-project-folder          | P4 验收条件 4：D1 聊天里提编码任务——没绑文件夹拦，绑好放行 > 没绑文件夹                | 乙       | 任务改由 coding.create 建（不经聊天）；断言没绑文件夹时拦下（P4 文案）、绑好后能建。若 coding.create 没有文件夹拦截＝功能缺口，报整合方                          |
| p5-unbind-folder           | 条件 2：解除之后这个项目派不了编码任务 > 聊天里提、点「要做」、任务页批准，都报        | 乙       | 任务改由 coding.create 建；断言解绑后三个入口报 P4、在途任务取消并回报                                                                                           |
| p5-unbind-folder           | 条件 3：解除时在途的任务被取消，别的不动 > 执行中的、排队的取消并在各自的对话里回      | 乙       | 任务改由 coding.create 建；断言解绑后三个入口报 P4、在途任务取消并回报                                                                                           |
| p5-unbind-folder           | 条件 3：解除时在途的任务被取消，别的不动 > 验证中的任务也取消                          | 乙       | 任务改由 coding.create 建；断言解绑后三个入口报 P4、在途任务取消并回报                                                                                           |
| p5-unbind-folder           | 条件 7：预览 > 不改任何东西；要取消的、等接受的、资料数、授权怎么处理都对              | 乙       | 任务改由 coding.create 建；断言解绑后三个入口报 P4、在途任务取消并回报                                                                                           |
| p5-unbind-folder           | 条件 10：解除绑定让对话上下文失效 > 正在用的会话被作废（照 revokeSour                  | 甲       | 隐私：解绑后下一问 chatStreamClient 收到的 messages 里没有那个文件夹的内容                                                                                       |
| p6-revoked-folder          | 条件 1：绑着文件夹、授权撤销了 > propose_coding_task：授权还                           | 丙       | 测的就是聊天里的 propose_coding_task 提议草案                                                                                                                    |
| p6-revoked-folder          | 条件 5：上级文件夹的授权还有效 > 算有授权：聊天里提、点「要做」自动派发，任务页        | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                                                                       |
| p6-revoked-folder          | 条件 7：没绑文件夹的项目 > 三个入口报的还是 P4 那一句，不是这一句                      | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                                                                       |
| p6-revoked-folder          | 条件 3、4：自动派发 > 轮到它：跳过、留在排队、对话里一条 folder_mis                    | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                                                                       |
| p6-revoked-folder          | 条件 3、4：自动派发 > 排着队的任务、项目后来没了文件夹：走同一条路，回报里是           | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                                                                       |
| p6-revoked-folder          | 条件 3、4：自动派发 > 宿主的 folderGap 回调：给了就照它说的拦、话原                    | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                                                                       |
| p6-revoked-folder          | 条件 8：已经在执行的任务 > 执行途中授权撤销：任务照常跑完，不被拦下、不被取消，        | 乙       | 任务改由 coding.create 建；断言撤销后自动派发跳过、folder_missing 回报、执行途中撤销不被拦                                                                       |
| p7-preview-revoke          | 条件 12：照界面那条路撤销之后（预览 → revokeSourceReading）                            | 甲       | 隐私：撤销后下一问 chatStreamClient 收到的 messages 里没有被撤销来源的内容                                                                                       |
| p8-delete-project          | 条件 4：没绑文件夹的项目 > 照原来那样删掉；不撤销什么、不取消什么；审计里没有          | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                                                                            |
| p8-delete-project          | 条件 4：没绑文件夹的项目 > 没绑文件夹、却还有排着队的任务（老数据）：照样先取消        | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                                                                            |
| p8-delete-project          | 条件 4：没绑文件夹的项目 > 没绑文件夹、却还有验证中的任务（老数据）：也算在途，        | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                                                                            |
| p8-delete-project          | 条件 5：删除时有排队、执行中的任务 > 先取消（那一刻项目还在、授权还有效）并回报        | 乙       | 任务改由 createCodingTask 建；断言删项目时在途任务先取消并回报、审计无 folder_unbound                                                                            |
| p8-delete-project          | 条件 6：拒绝；上下文失效 > 项目不存在：拒绝，什么都不变；删除成功让正在用的对话        | 甲+乙    | 拆开：任务先取消并回报按乙（createCodingTask 建）；「上下文失效」按甲（下一问 messages 里没有删掉项目的内容）                                                    |
| t2a-ask-todos              | AI 在回答末尾列的待办 > 落成等你拍板的待办，记着来自哪次对话、哪条回答；回答里去掉那一 | 甲       | 假模型回答末尾带「建议待办」段；extractSuggestedTodos 对直连回答同样生效——断言建出待办、记得来自哪次对话哪条回答、正文去掉那一段、拒绝过的不再提、没有那一段不建 |
| t2a-ask-todos              | AI 在回答末尾列的待办 > 你拒绝过的同一件事不再提，也不出现在这条回答上                 | 甲       | 假模型回答末尾带「建议待办」段；extractSuggestedTodos 对直连回答同样生效——断言建出待办、记得来自哪次对话哪条回答、正文去掉那一段、拒绝过的不再提、没有那一段不建 |
| t2a-ask-todos              | AI 在回答末尾列的待办 > 回答里没有这一段：不建待办，也不记 proposedTodos               | 甲       | 假模型回答末尾带「建议待办」段；extractSuggestedTodos 对直连回答同样生效——断言建出待办、记得来自哪次对话哪条回答、正文去掉那一段、拒绝过的不再提、没有那一段不建 |
| t2a-ask-todos              | 你在消息开头写「待办：」 > 直接加成要做的待办，记着是你哪条消息；回答上注明已加        | 甲       | 用户自己写「待办：…」走 parseUserTodo；断言库里待办与消息 meta                                                                                                   |
| t2b-coding-todos           | 编码任务进待办 > 这一轮提出的编码任务成了等你拍板的待办，标题取任务第一行，记在这条    | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                                                                             |
| t2b-coding-todos           | 编码任务进待办 > 拍板「要做」= 批准编码任务并排队                                      | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                                                                             |
| t2b-coding-todos           | 编码任务进待办 > 「不做」= 取消还没开始的编码任务                                      | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                                                                             |
| t2b-coding-todos           | 编码任务进待办 > 编码任务完成了，待办跟着算做完                                        | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                                                                             |
| t2b-coding-todos           | 编码任务进待办 > 你拒绝过的同样的事又被提出来：不进待办，起草的编码任务自动取消        | 丙       | 测的就是聊天这一轮建的编码任务进待办，聊天已不建任务                                                                                                             |
| l16-watchdog               | 条件 6：看门人管收听 > 整合方补：--exit-when-idle 退出前停掉还挂着的                   | —        | 不是本单验收（packages/relay）；单独重跑确认是否计时偶发                                                                                                         |
| e2e/a4-follow-live-answer  | 端到端：跟真回答（聊天）                                                               | 甲       | IXAEON_FAKE_MODEL=1 + IXAEON_FAKE_CHAT_SCRIPT 供剧本；断言照旧                                                                                                   |
| e2e/d5a-acceptance-first   | 端到端：首屏验收含聊天                                                                 | 甲       | 同上，聊天段用假剧本                                                                                                                                             |
| e2e/d6                     | 端到端：会话/问答主流程                                                                | 甲       | 同上                                                                                                                                                             |
| e2e/d7b                    | 端到端：执行器选择                                                                     | 甲       | 模型段走假剧本；任务段照旧                                                                                                                                       |

## 拿不准（已按整合方意见落定，留档）

- a5 条件 4/6/7/对照 → 甲（failedKind 对 direct 生效）。
- p8 条件 6 → 拆「甲（上下文）+ 乙（任务取消）」。
- p4 → 乙；**若任务页 `coding.create` 根本没有文件夹拦截（拦截只在聊天工具里），那是功能缺口，停下报整合方，不在 coding.create 里补**。
- l16-watchdog → 单独重跑定性。

## 进度（2026-11-04 晚）

- [x] 1. 甲类余 11 条：a5 8 条已改（1 条「轮次上限」功能缺口 skip，1 条 Hermes 条件 8 留丙）；p5 条件 10 / p7 条件 12 / p8 条件 6 上下文 = 同一功能缺口（解绑/撤销/删项目后条目仍进上下文）→ skip + 拿不准
- [x] 2. g06 补一层：新增「交给模型的内容里有本项目条目、没有别的项目/个人条目」（5/5 过）
- [x] 3. p4：文件夹拦截在 appRuntime（聊天入口 / 待办「要做」/ 任务页批准与派发），coding.create 本身不拦（符合 P4 三入口口径）。p4 条件 4「聊天里提」随工具删除 → skip + 拿不准；该文件 10 条过、1 条 skip
- [x] 4. 乙类全部改完：d3 23/23、d4 5/5、d7b 23/23、p5 17/18（1 skip 缺口）、p6 9/10（1 skip 丙）、p8 15/16（1 skip 缺口）、p4 10/11（1 skip 丙）——任务改 coding.create/任务页建 + 一条来源消息（messages.run_id）保住回报与待办归属
- [x] 5. 端到端：a4 3/3、d6-chat-ui 1/1、d5a 通过（假聊天剧本 + 延时）；d7b-model-executor 依赖「聊天里起草任务」（已删能力）→ 拿不准，保持红、断言不改
- [ ] 6. relay l16 单独重跑
- [ ] 7. 四条命令全跑
- [ ] 8. 真机甲 / 乙
- [ ] 9. 同步 main + 推两支 + 等 CI
- [ ] 10. 交付说明收尾

## 拿不准（请整合方定）

1. **上下文隐私过滤没实现**（p5 条件 10 / p7 条件 12 / p8 条件 6 上下文）：实测解绑文件夹、撤销来源授权、删项目之后，从那里提炼的条目**仍会被选进**下一问交给模型的内容。三条改成 messages 断言后仍红，已 `it.skip` 保留原断言，没删没放宽。
2. **条件 7 轮次上限**（a5）：直连 `runDirectChat` 到 `maxToolRounds` 时按正常结束返回，不产生 round_limit 失败。测试已 `it.skip` 保留原断言。
3. **a5 条件 8**（Hermes 没有 answer 步）：丙类，原样保留（红）。
4. **端到端 d7b-model-executor**：这条从「聊天里提任务 → 待办卡 → 点要做 → 派发到我的模型」一路断言。CF3c 删掉聊天建任务之后，前半段没有入口；用建议待办（parseUserTodo/建议待办）不会生成编码任务，派发链路因此起不来。断言没删没放宽，保持红。
5. **端到端需要假客户端跨多问连续走剧本**（同一运行时复用同一个假客户端），已在 `chatStreamClient` 里缓存实例；延时用 `IXAEON_TEST_MODEL_DELAY_MS`。
