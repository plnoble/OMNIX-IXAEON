# CF3b 交付说明：把直连模型接进聊天（第二支）

规格：`docs/委派/CF3-直连模型做聊天主引擎.md`。分支 `dev/CF3b`，基于 `dev/CF3`（`958be76`）。
本轮**未做完**：锁定验收条件 1–18 已全过、真机乙已跑，但门禁卡在「既有集成用例仍断言旧路径」，
真机甲未跑。下面按四分法写，未做的直说。

## 一、已实现

改动集中在 `apps/desktop/src/main/appRuntime.ts`（**+约 190 行源码**），加上上一轮那 6 处小改动：

| 位置                     | 做了什么                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ask()` 开头             | 三样齐（`chatLaunchOptions()` 的 chatModel / chatBaseUrl / chatApiKey）时**不问 Hermes 装没装**（原来无条件 `this.hermesFound()`，问一下就会把它拉起来），也不启动它                                                                                         |
| `ask()` 分叉             | 有直连配置 → `runDirectAnswer()`；缺一样 → 走原来的 `askSessions` / `newAskSession()` 路径，一个字未改                                                                                                                                                       |
| `runDirectAnswer()`      | 自己插 `runtime_runs` 行（`engine='direct'`、`status='running'`），结束按 succeeded/failed/cancelled 补状态；Key 只用来建客户端，**不进库、不进审计、不进日志**                                                                                              |
| `searchMemoryForModel()` | 从 `hermesTool('search_memory')` **抽出来的共用方法**，记忆桥与直连工具都调它——没有第二份实现；工具结果就是那个对象（带 `today` / `items`）JSON 序列化后交回模型                                                                                             |
| `directChatTools()`      | 五个工具：`search_memory`、`get_evidence`、`get_project_context`、`search_web`、`read_web`。`search_web` 没配执行器时返回 `ok:false` + 规格那句话；查询先过 `sanitizePublicQuery`。**不在清单里的名字（`propose_task` / `record_observation`）一律拒绝执行** |
| 取消                     | 每轮一个 `AbortController` 存 `directAskAborts`（懒初始化，因为测试用 `Object.create` 造实例），`cancelAsk()` 里按 runId abort；半截回答沿用既有 `flushDeltas` 保留                                                                                          |
| 失败                     | 失败时补一条 `tool:'model', ok:false` 步骤，让**既有的** `failedKind` / `explainModelFailure` / 半截保留收尾照旧生效——没有另造一套                                                                                                                           |
| 既有收尾                 | 存档、提炼、`meta.memoryUsed`、`setEngineSession` 全部复用原来的代码；直连没有引擎会话，只在 `session` 存在时才落引擎会话 id                                                                                                                                 |
| `setSourceId` 尽力而为   | 挂来源只用于显示，写不进去（来源行还没落库等）不再让存档与提炼一起失败（原来是外键错直接把整段跳过）                                                                                                                                                         |
| 6 处既有改动             | `engine` 并集加 `'direct'`（contracts zod、askStore、importService、AgentSessionResult）；`injectedMemoryByTurn` 把 `direct` 当 `hermes`；界面 `ENGINE_LABELS` 把 `direct` 显示成「直连」                                                                    |

没有改 `AgentSession`、Hermes 适配器、Core 有界循环；没有写迁移（迁移 42 已在 main）；没有加新的外部服务。

## 二、自动化通过

`node scripts/acceptance.mjs run CF3` —— **五个文件 28/28 全过（条件 1–18）**：

```
✓ apps/desktop/test/acceptance/cf3b-engine-label.test.ts (1 test)
✓ packages/core/test/acceptance/cf3-prompt.test.ts (7 tests)
✓ packages/core/test/acceptance/cf3-direct-chat.test.ts (5 tests)
✓ packages/core/test/acceptance/cf3-chat-stream.test.ts (5 tests)
✓ apps/desktop/test/acceptance/cf3b-direct-chat.test.ts (10 tests)
Tests  28 passed (28)
```

锁定测试**一行未改**。

## 三、门禁：**红**（不是我这支没写完，是既有用例断言旧路径）

`node scripts/verify.mjs` 卡在 `integration`，28 条失败全是 **ask 历史 / 失败收尾**那一类既有用例：

```
× 第二问能接住第一问：历史轮次真的进了交给模型的提示词
× 新对话拿不到别的对话的内容
× 历史轮次只取已完成的：取消的半截回答不进下一轮
× 本轮提问不会被当成「此前的内容」喂回去
× 两个对话交替提问不串台：各自只看到自己的历史
× 重启后重开旧对话能续：引擎会话清空，历史靠 priorTurns 重新喂
× 提问与回答都落进对话，重启后查得到
× 模型失败时对话里留下 failed 消息，不是发出去就没了
× 顺序连问：来源片段的节点号与消息 seq 一一对应
× 同一对话并发两问：两边的回答都完整留在来源里，谁也不覆盖谁
```

**原因**：这些用例都给 `config.model` 配了地址 + Key，然后断言「走替身会话（Hermes）拿回答」。
这正是本规格要改的行为——三样齐现在走直连，于是它们既拿不到替身会话的回答，又会去真的发网络请求。

**我没有自行改这些回归套件**：它们是仓库的既有资产，改法有两种（① 用例改成不配模型以继续测旧路径；
② 用例改成桩 `fetch` 以测新的直连路径），两种都会改变这些套件测的东西，属于该由整合方定的口径。
按 AGENTS「觉得测试本身有问题：停下，写进交付说明」处理。

## 四、真机通过

**乙：已跑（接线后重跑，真模型 + 合成数据，5 个合成问题）**：

```
Q1 状态=succeeded 工具=[]                                首字=3382ms 总计=3467ms
Q2 状态=succeeded 工具=[search_memory, search_memory]     首字=5928ms 总计=6308ms
     回答前 80 字：记忆里只有一条明确记录：你偏好简洁的回答，不喜欢长列表…
Q3 状态=succeeded 工具=[search_web, search_web]           首字=3446ms 总计=4914ms
     回答前 80 字：搜索服务没配置，设置里填搜索服务 Key 之前我查不了联网新闻…
Q4 状态=succeeded 工具=[search_memory, get_project_context] 首字=5521ms 总计=6240ms
Q5 状态=succeeded 工具=[search_memory, get_project_context] 首字=3226ms 总计=4336ms
     回答前 80 字：我查了记忆，里面没有任何消费记录；项目上下文接口也没有接入…
```

该触发的触发了（问偏好查记忆、问实时查网），不该编的没编（Q5 直说查不到，没有捏造金额）。

**甲：未跑。** 假网关脚本已写好并自检通过：`scripts/real/cf3-fake-gateway.mjs`
（监听 127.0.0.1 随机端口、`/v1/models` 给合成模型 `demo-a`、首次请求回 `search_memory` 工具调用、
之后分 3 段慢慢吐正文、只打印请求计数不打印正文）。
但「设 `IXAEON_DATA_DIR=<临时目录>` 启动应用 → 在设置『模型接入』里填地址/合成 Key/模型名 →
问一句 → 看流式出字、『直连 · demo-a』标签、用到的记忆、停止按钮」这一整套**应用内操作没做**：
需要 Playwright 驱动设置页选择器，本轮时间用在了接线与排错上。**甲未跑就是未跑，不冒充。**

## 五、用户接受

**待用户实测**（规格丙：用户自己连聊三轮）。

## 六、还剩什么（下一轮）

1. **门禁红的那 28 条既有集成用例**：等整合方定口径（改用例不配模型，还是改成桩 `fetch` 测直连），
   我照着改；改完 `node scripts/verify.mjs` 应恢复全绿。
2. **真机甲**：用现成的 `scripts/real/cf3-fake-gateway.mjs`，驱动应用走一遍并截图。
3. 队列第 151 行保持「窗口进行中（dev）」，等支二收口后再改「待复审（整合方）」。
