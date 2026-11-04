# CF3c 聊天只走直连：收掉 Hermes 路径和 Core 有界循环

队列第 162 行。档位：**B**（改变聊天时交给谁回答，没配模型时的行为也变）。依赖：第 151 行 CF3 / CF3b（已并入），第 163 行 MP2（聊天模型从 `resolveModelUse` 取）。按用户 11-03 定的先后，排在 MP3 后面。MP3 也改 `chatLaunchOptions()`，后做的那一单要合并对方的改动。

## 要什么、为什么

CF3 / CF3b 让聊天能走直连，但留了两条旧路：
- 没配聊天模型时找 Hermes；
- Hermes 没装时用 Core 有界循环兜底。

另外 CF3b 并入时加了一道门槛：只有在设置里单独选过聊天模型，才走直连。

结果是同一个问题可能由三套东西回答：直连、Hermes、Core 有界循环。三套的提示词、工具、失败说明各不一样，用户说不清楚到底是谁在答。这一单收成一条路：

- **配了模型就走直连**：聊天模型留空、跟着后台分析也算配了。CF3b 那道门槛去掉。
- **没配就明确说没配**，指去「模型」页（MP2b 之后的位置）。不再找 Hermes，也不再用 Core 有界循环兜底。
- **聊天不再建编码任务**（用户 11-03 定，见 CF2；直连本来就不给 `propose_task`）。在 CF4「讨论转任务」之前，编码任务从「任务」页新建（`createCodingTask`，已有）。用户在问题里写「待办：…」建待办（T2a 的 `parseUserTodo`）照旧。

Hermes 以后还用不用来「干活」，等 IXAEON 与 DSH 的分工定下来再说。**这一单不删 core 里的 `AgentSession`、Hermes 适配器、有界循环**（core 自己的测试还在用），只是桌面端的聊天不再调用它们。

## 改哪里

1. `AppRuntime.ask()`：
   - 只剩直连一条路；
   - `directChatLaunch()` 去掉「单独选过」那道门槛，改成 `chatLaunchOptions()` 三样齐就走（MP2 之后由 `resolveModelUse('chat')` 决定，跟着后台分析也算）；
   - 三样缺一样：抛 `IxaError(ErrorCodes.MODEL_NOT_CONFIGURED, …)`，文案指去「模型」页，不提 Hermes、不提 OpenAI API Key；
   - 抛错的时机跟现在一样，在落库任何消息之前。
2. 去掉聊天用的 Hermes 接线：
   - `newAskSession`、`adoptWarmSession`、`askSessions`、预热（`prewarmChat` 及其 IPC、preload、`Ask.tsx` 里的调用）；
   - T2b「这一轮新建的编码任务进待办」那一段：直连不会再建任务，成了死代码；
   - 跟这些一起成了死代码的，一并删。
   - `hermesFound()` 设置页还在显示状态，**保留**。
3. **测试接缝**（写死，不改名）：
   ```ts
   // AppRuntime 上的一个方法：直连用的客户端从这里拿，测试用 Object.assign 换掉它。
   chatStreamClient(launch: { model: string; baseUrl: string; apiKey: string }): StreamChatClient;
   ```
   - 生产实现返回 `OpenAIChatStreamClient`；
   - `process.env.IXAEON_FAKE_MODEL === '1'` 时（照 `getProvider()` 现在的做法），直连不看配置，返回 `FakeStreamChatClient`；
   - 剧本从 `IXAEON_FAKE_CHAT_SCRIPT`（JSON 文件路径，格式就是 `FakeStreamChatClient` 构造参数）读，没给就回一句固定的合成回答；
   - 这条只给端到端测试用。
4. 回答下面的说明不再写「本轮走直连模型（不是 Hermes）」：引擎标签已经说明了。顺带修掉 CF3b 复审记下的「。；」重复标点。

## 约束

- 不改 `runDirectChat`、系统提示词、工具清单（那是 CF3 的，提示词改动另开单）。
- 不改 core 的 `AgentSession` / Hermes 适配器 / 有界循环，也不改它们自己的测试。
- 不写迁移。
- 源码改动只算净新增，删除的行不算进 300，但要在交付说明里列出删了什么。超过 300 照规矩拆。
- 合成数据：模型 `demo-a`，地址 `http://127.0.0.1:<端口>`，Key `sk-synthetic`。

## 验收条件

1. 设置里单独选了聊天模型（三样齐）→ 这一问走直连：消息 `engine = 'direct'`、`modelName` 是选的那个；`newAskSession`、Hermes 定位都没被调用（替身断言调用次数为 0）。
2. 聊天模型留空、后台分析的模型 / 地址 / Key 齐 → 也走直连，`modelName` 是后台分析的模型。
3. 三样缺一样（分别造：没模型、没地址、没 Key）：
   - `ask()` 抛 `MODEL_NOT_CONFIGURED`，文案含「模型」页，不含「Hermes」；
   - 对话里没有新增消息；
   - Hermes 定位替身返回「已安装」时也一样：不去用它，调用次数为 0。
4. 进聊天页不预热 Hermes：IPC 上没有 `prewarmChat` 通道；渲染 `Ask` 页时 api 上的 `prewarmChat` 替身没被调用。
5. 一问之后编码任务的数量不变，即使替身模型回了一个叫 `propose_task` 的工具调用（按 CF3 的规则当未知工具拒掉）；问题里写「待办：合成事项」照旧建出一条待办。
6. `chatStreamClient` 接缝：
   - 换成 `FakeStreamChatClient` 后，回答就是剧本里的正文，`fetch` 替身一次都没被调用；
   - 设 `IXAEON_FAKE_MODEL=1` 和 `IXAEON_FAKE_CHAT_SCRIPT` 时，不配任何模型也走直连、用剧本回答。
7. 直连回答的 `meta.notice` 不含「不是 Hermes」，也不含「。；」。
8. CF3 / CF3b 的锁定验收除了第 9 条点名的那条，**一条不改**照样全过（取消、失败说明、工具、记忆标签、引擎标签）。
9. CF3b 条件 17「聊天模型没配 → 走现在的路径」跟本单条件 3 冲突：列进「改写的旧测试」，由整合方退役。

## 撞红的旧锁定测试（这一单最大的活）

大约 30 份锁定验收的夹具用 `newAskSession` / `hermesFound` / Core 有界循环当假模型通道。整合方 11-03 粗查过的名单：

- `a4-follow-live`、`a5-model-failure`、`cf0-chat-retry`、`cf3b-direct-chat`；
- `d1-coding-task-draft`、`d3-auto-dispatch-report`、`d4-landing-report`、`d7b-executor-selection`、`d7b-pages`；
- `g04-task-origin`、`g05-cancel-preparing`、`g05-cancel-preparing-extra`、`g06-conversation-project`、`g06-conversation-project-page`；
- `k3-cockpit-settings`、`k5-mobile-settings`、`k5-mobile-settings-ipc`；
- `p4-project-folder` 到 `p8-delete-project`；
- `t2a-ask-todos`、`t2b-coding-todos`；
- 端到端：`a4-follow-live-answer`、`d5a-acceptance-first`、`d6-chat-ui`、`d7b-model-executor`；
- `review-p1-action-loop-20260916`。

以实际跑红的为准。分三类改，**跟实现放在同一单里，但拆成第二支 `CF3cb`**：测试文件不算行数，分开好审。

- **甲类：只是借聊天当假模型通道，测的是别的**（取消、对话固定项目、项目文件夹、设置、待办…）：
  - 把替身换成 `chatStreamClient` 接缝加一份有聊天模型的配置，端到端用 `IXAEON_FAKE_CHAT_SCRIPT`；
  - 原来的断言一条不删、不放宽。
- **乙类：测的是聊天之后的事**（派发、落地报告、执行器选择）：
  - 任务改由 `coding.create` / `createCodingTask` 建，后面的断言照旧；
  - 任务来源从「聊天这一轮」变成「任务页新建」的，来源那一条断言改成新的来源，交付说明里逐条写清。
- **丙类：测的就是「聊天建任务 / 提议任务 / Hermes 自己的行为」**（大概是 `d1`、`g04`、`t2b` 里的一部分，`review-p1-action-loop` 里聊天建任务的那几条）：
  - 不改，列出来写清楚是哪条、为什么属于丙类；
  - 由整合方按「用户 11-03 定普通聊天不建任务」退役；CF4 做「讨论转任务」时再补来源追踪的验收。

规矩跟 MP2b 一样：
- 不重新登记这些旧任务的指纹；
- 分支上 `acceptance-lock` 这一步会因此不过，只许是这几个文件；
- 每个文件、每处改动、属于哪一类、为什么，写进 `docs/委派/交付/CF3cb.md`；
- 整合方复审后重新锁定或退役。

不锁定的集成测试（`apps/desktop/test/integration/`、`unit/`）跟着改：
- 测的东西删掉了（比如 `p1-prewarm`），整份删掉，交付说明里写一句。

## 真机检查

- **甲（合成）**：
  - 设 `IXAEON_DATA_DIR=<临时目录>` 启动应用，什么模型都不配，问一句：看到「没配模型、去「模型」页」，而且没有 Hermes 进程被拉起（任务管理器或进程列表里查 hermes，只打印有几个）；
  - 再用 `scripts/real/cf3-fake-gateway.mjs` 配一家、聊天模型留空，问一句：走直连，标签是后台分析的模型；
  - 截图遮掉临时目录。
- **乙（真模型、合成问题）**：用 `scripts/real/run-batch.mjs` 跑 CF3 的乙那套问题，确认收路之后照样全部 `succeeded`。
- **丙**：用户在自己的应用里连聊三轮，看是不是一直是「直连」；在「任务」页建一个编码任务能派发。交付说明里写「待用户实测」。
