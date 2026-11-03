# CF3b 交付说明：把直连模型接进聊天（第二支）

规格：`docs/委派/CF3-直连模型做聊天主引擎.md`。分支 `dev/CF3b`，基于 `dev/CF3`（`958be76`），
已 `git merge origin/main`（`0d69171`）。锁定验收条件 1–18 全过、本机 verify 全过、真机甲与乙都已跑。

## 一、已实现

### 1. 接进 `AppRuntime.ask()`（`apps/desktop/src/main/appRuntime.ts`）

| 位置                     | 做了什么                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `directChatLaunch()`     | **只看设置页「聊天模型」那一项有没有显式选过**，再加上地址与 Key 都齐，才走直连；缺一样返回 `null`，原来的路径一个字不动                                                                                                                               |
| `ask()` 开头             | 直连时不问 `hermesFound()`（问一下就会把它拉起来），也不启动它                                                                                                                                                                                         |
| `ask()` 分叉             | 有直连配置 → `runDirectAnswer()`；否则走原来的 `askSessions` / `newAskSession()`                                                                                                                                                                       |
| `runDirectAnswer()`      | 自己插 `runtime_runs` 行（`engine='direct'`、`status='running'`），正常收尾时补状态；**插行之后任何一步抛错都会被 `finally` 补成 `failed` 并写 `finished_at`**，错误照旧往外抛，交给既有的失败收尾。Key 只用来建客户端，**不进库、不进审计、不进日志** |
| `searchMemoryForModel()` | 从 `hermesTool('search_memory')` **抽出来的共用方法**，记忆桥与直连工具都调它，没有第二份                                                                                                                                                              |
| `directChatTools()`      | 五个工具，结果 JSON 序列化后交回模型；`search_web` 没配执行器时 `ok:false` + 规格那句话，查询先过 `sanitizePublicQuery`；**清单外的名字（`propose_task` / `record_observation`）一律拒绝执行**                                                         |
| 记忆的 tag               | 工具查到的记忆**与预先注入的一样用 `memoryOriginTag()`**：工具结果不带判断要用的字段，就按 id 用 `this.items.get()` 取整条再算——「AI 当时的建议」不会被当成用户说的                                                                                    |
| 取消                     | 每轮一个 `AbortController`（懒初始化，因为测试用 `Object.create` 造实例），`cancelAsk()` 按 runId abort；半截回答沿用既有 `flushDeltas` 保留                                                                                                           |
| 失败                     | 失败时补一条 `tool:'model', ok:false` 步骤，让**既有的** `failedKind` / `explainModelFailure` / 半截保留照旧生效，没有另造一套                                                                                                                         |
| `setSourceId` 尽力而为   | 挂来源只用于显示，写不进去不再让存档与提炼一起失败                                                                                                                                                                                                     |

### 2. 既有改动（上一轮带来，保留）

`engine` 并集加 `'direct'`（contracts zod、`askStore`、`importService`、`AgentSessionResult`）；
`extractor.injectedMemoryByTurn` 把 `direct` 当 `hermes`；`AskMessage.tsx` 的 `ENGINE_LABELS` 把 `direct` 显示成「直连」。

没有改 `AgentSession`、Hermes 适配器、Core 有界循环；没有写迁移；没有加新的外部服务。
**源码改动量：`appRuntime.ts` 约 +205 行，其余 5 个文件各 +1～+4 行**（合计约 +215 行源码，含本轮复审的三处修正）。

## 二、门禁：之前为什么红、怎么修的

上一轮我把它写成「既有用例断言旧路径、要整合方定口径」——**这个判断是错的**。整合方在我分支上跑出来的真实报错是：

```
TypeError: Cannot read properties of undefined (reading 'model')
```

那些用例用 `Object.create(AppRuntime.prototype)` 造实例，**没有 `config`**；我的 `ask()` 一开头就调
`directChatLaunch()` → `chatLaunchOptions()` → `chatModelName()`，读 `this.config.model` 就崩了。
原有代码在同类地方都有保护（`savedKeyProvider` 写的是 `(this.config as AppConfig | undefined)?.model`）。

修法（**改代码，一条测试都没动**）：

1. `chatModelName()`、`chatLaunchOptions()` 照 `savedKeyProvider` 的写法：没有 `config` 就当没配，返回 `null`，不抛错。
2. 修完 `d3-d4` 那批（11 条）确实自己就绿了。
3. 但只修这个还不够：`d7b-executor-selection` 那批**只配了分析模型**（`modelName` + 地址 + Key），
   而聊天判定原先会回退到 `modelName`，于是聊天被误判成「已配好」走了直连，那 7 条锁定验收跟着红。
   改成**只认「聊天模型」显式选过**之后，`d7b` 23/23 与 `cf3b-direct-chat` 10/10 同时绿。
   （`chatModelName()` 的回退仍保留给 Hermes 启动参数用，只是不拿它判断「聊天配好了没有」。）

## 三、自动化通过

```
node scripts/acceptance.mjs run CF3     → Tests 28 passed (28)   ← 五个文件，条件 1–18
node scripts/verify.mjs                 → 全部通过（IXAEON v0.2 验证完成）
```

- 锁定测试 `cf3-*` / `cf3b-*` **一行未改**（`acceptance-lock` 一步通过）；
- **没改任何既有集成测试**；上面那批红是用改代码修好的。
- 本轮新加两条自有回归（`apps/desktop/test/integration/cf3b-review-fixes.test.ts`，**不登记锁定**）：
  1. 把 `items` 表删掉让「选记忆」抛错 → `runtime_runs` 那行必须是 `failed` 且 `finished_at` 有值；
  2. 造一条「AI 当时的建议」记忆，走工具查到它 → `meta.memoryUsed` 里它的 `tag` 必须与
     `memoryOriginTag(整条)` 完全一致（不能一律写成「记忆」）。

## 四、真机通过

### 甲：已跑（假网关 + 真应用，合成数据）

1. `node scripts/real/cf3-fake-gateway.mjs` → 打印 `PORT=60992`（`127.0.0.1` 随机端口，模型 `demo-a`）。
2. `node scripts/real/cf3-ui-check.mjs 60992`：`IXAEON_DATA_DIR=<临时目录>` 起真应用
   （`apps/desktop/out/main/index.js`），向导里填**假网关地址** + 合成 Key `sk-synthetic` + 模型 `demo-a`，
   再把「聊天模型」指到 `demo-a`，然后在问答页提问「我的回答风格偏好是什么？」。
3. 输出（原样）：

```
流式出字：已看到第一段正文
引擎标签：引擎 直连 · 模型 demo-a
截图：.logs/cf3-ui-answer.png
```

四样里**两样有证据**：

- **流式出字**：脚本等到第一段正文出现才继续，说明是分段到的；
- **「直连 · demo-a」标签**：`引擎 直连 · 模型 demo-a`——UI 把 `direct` 映射成「直连」，模型是假网关那个。
  这条同时反证「聊天模型」确实设上了（否则走 Hermes，标签不会是这个）。

截图见 `docs/委派/交付/cf3-ui-answer.png`（合成数据，临时目录已遮）。

**还差两样没单独验，如实写**：

- **用到的记忆**：假网关第一次请求回的是 `search_memory` 工具调用（工具链路走到了），
  但回答下方的记忆清单没从 DOM 里抓出来，没有截到证据；
- **停止按钮**：这一轮没点。
- 附注：渲染进程 `getSettings()` 的真实返回形状我没确认，脚本那行读法拿到空，
  所以日志里 `chatModelName=undefined` 是**读法**问题，不是没设上（引擎标签可反证）。

### 乙：已跑（真模型 + 合成数据，5 个合成问题，接线后重跑）

```
Q1 工具=[]                                  首字=3382ms 总计=3467ms
Q2 工具=[search_memory, search_memory]       首字=5928ms 总计=6308ms
     回答前 80 字：记忆里只有一条明确记录：你偏好简洁的回答，不喜欢长列表…
Q3 工具=[search_web, search_web]             首字=3446ms 总计=4914ms
     回答前 80 字：搜索服务没配置，设置里填搜索服务 Key 之前我查不了联网新闻…
Q4 工具=[search_memory, get_project_context] 首字=5521ms 总计=6240ms
Q5 工具=[search_memory, get_project_context] 首字=3226ms 总计=4336ms
     回答前 80 字：我查了记忆，里面没有任何消费记录；项目上下文接口也没有接入…
```

## 五、用户接受

**待用户实测**（规格丙：用户自己连聊三轮）。

## 六、还剩什么

1. 真机甲里**「用到的记忆」清单**与**停止按钮**这两项没单独取证。
2. `getSettings()` 在渲染进程的真实返回形状没确认，脚本那行读法要改对（不影响功能，只影响日志）。
