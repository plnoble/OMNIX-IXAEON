# CF4 交付说明：讨论转任务（先只交测试）

分支 `dev/CF4`，B 档。规格 `docs/委派/CF4-讨论转任务.md`。

## 已实现（2026-11-07）

- `packages/core/src/execution/taskStore.ts`：`create` 多收 `originConversationId/FromSeq/ToSeq` 并写入新三列；`list`/`get` LEFT JOIN 出 `origin_conversation_title`。
- `packages/contracts/src/entities.ts`：`codingTaskSchema` 加三个可空来源列 + 只读的标题回退字段。
- `apps/desktop/src/main/appRuntime.ts`：新增 `createTaskFromConversation`（校验：消息同对话、开始不晚于结束、结束是 complete 助手、目标 1–2000、验收 1–8 条各 1–200、项目存在且绑了文件夹；项目以对话为准；origin_run_id 显式 null；allowedCommands 空；审计 `conversation.task_created` 只记 id 与条数）与 `listConversationTasks`。
- IPC：contracts / main / preload 两方法 `createTaskFromConversation`、`listConversationTasks`。
- 界面：`AskMessage.tsx` 每条 complete 助手消息下「转成任务」+ 展开表单（范围下拉、目标预填、验收条件、个人视角选项目），建完显示「已转成任务：<前 30 字>」与「到任务页看」；`Tasks.tsx` 卡片显示「来自对话「标题」第 a–b 条」或「来自已删除的对话」，点了打开对话（`onOpenConversation`）。
- 源码改动约 300 行（核心 + IPC 一支、界面一支都在这一分支，按规格未超 300 才不拆）。

## 自动化通过

```
$ node scripts/acceptance.mjs run CF4
Tests  37 passed (37)
```

（整合方锁定后扩到 37 条：条件 1–9 共 28 条 + 条件 10 界面 9 条。）`tsc`、`eslint` 干净。

### 测试覆盖

- `apps/desktop/test/acceptance/cf4-task-from-conversation.test.ts`：条件 1–9（28 条，整合方改严后）。
- `apps/desktop/test/acceptance/cf4-ui.test.ts`：条件 10（9 条，含任务页来源与个人视角选项目）。

## 真机通过（2026-11-07）

`node scripts/real/cf4-task-origin.mjs`：临时数据目录、本机假 OpenAI 网关（模型 demo-a）、项目「合成项目甲」绑临时文件夹；新对话问两句，在第二条回答下点「转成任务」，开始挪到第 1 句、填两条验收，建草案；到任务页看来源。

```
任务页显示「来自对话」： true
编码任务行数： 1 ｜有来源的： 1
范围： 1–4 ｜状态： draft
对话消息条数： 4 ｜审计 conversation.task_created： 1
```

脚本现在**在截图前断言页面文本里不含临时目录路径**（含就抛错不截图），并断言任务数 1、有来源 1、范围 1–4、draft、消息 4 条、审计 1 行——不符就以非 0 退出。

截图：`.logs/cf4-form.png`、`.logs/cf4-origin.png`。审查方看不到图片时，以脚本的「页面文本不含临时目录」断言作为遮蔽证据。

## 用户接受

未接受。

## 备注

- 核心测试放在 `apps/desktop/test/acceptance/`（要和 `AppRuntime` 一起跑，`packages/core` 下 import 不到 `apps/desktop/src/main`）。
- 迁移 43（`coding_tasks` 三列 + 索引）按规格由整合方写；执行方不动迁移。

## 替补整合方（DSH + group/ixaeon-integrator，2026-11-05）

用户在这次会话里直接交代：审测试、补条件 10 任务页一项、写迁移 43、锁定、改队列 153 行、推 main。

**越权说明，留给 Claude 抽查**：AGENTS.md 和《代审与替补整合》都写着「写迁移只由 Claude 做」。这次是用户在会话里明确要求替补整合方写迁移 43，我照做了。SQL 跟规格「迁移 43」一节逐字相同，没有加减。Claude 回来请先核这一条。

另外，执行方用的是什么模型我核不到（提交作者是 plnoble），没法确认跟我不是同一个模型。

### 迁移 43

- `packages/core/src/db/migrations.ts` 追加 `{ id: 43, name: 'coding-tasks-origin-conversation' }`，SQL 照抄规格。已发布的迁移一行没改。
- 新增 `packages/core/test/integration/m43-coding-tasks-origin.test.ts`（照 m42 的写法）：先迁到 42 插一条旧任务，升级后这条除了三个新列是 null，其余字段都不变；seq 写 0 被 CHECK 拒；来源写不存在的对话被外键拒；删对话后来源置 null、两个 seq 留着；索引在。

### 审测试：发现的问题与改法（只改严、只补，没删条件）

dev 交来的测试有几处在实现正确时也过不了，有几处在实现错了时也会过：

1. **错误码比的是字面量**：`toMatchObject({ code: 'VALIDATION_FAILED' })`。真实的错误码是 `ErrorCodes.VALIDATION_FAILED`（`IXA0012`），照规格做对了也永远红。改成用 `ErrorCodes`。
2. **两轮对话把项目对话变成了个人视角**：`ask({ projectId: null })` 在空对话第一问时会把对话的项目改写成 null（G06）。所以条件 4「对话有项目时传项目乙也不认」根本没测到。改成传对话自己的项目，并断言聊完之后项目没变。
3. **条件 9 什么都没测**：调的 `approveAndRunTask?.()` 不存在（可选调用直接跳过），读的 `executor.calls` 也不存在（`?? []`）。结果什么都不派发也能过。改成真的走 `approveCodingTask` + `coding.dispatch`，包一层执行器记下每次 `run` 收到的任务与选项。断言执行器至少被调用 1 次、收到的内容里有目标和验收条件、没有四条消息里任何一条正文（含「蓝鲸七号」）。项目目录放了一个合成文件，派发要拿它做快照。
4. **条件 1 没查执行器 0 次**：补上。另外补查库里那一行（不只看返回值）和 `scope_json = ["."]`。`origin_run_id` 严格查库里那一行；`CodingTask` 类型里没有这个字段，所以返回值上只要求「有就得是 null」。
5. **条件 3 只写了 5 种**：补齐规格列的全部情况。消息属于另一个对话（开始、结束各一种）、消息不存在、结束是 failed / streaming 的助手消息、目标超过 2000 字、只有空白、验收条件 9 条、某条超过 200 字、某条是空白、个人视角没传项目、传了不存在的项目，再加「项目没绑文件夹：文案跟任务页批准时那句一样」（拿同一个没绑文件夹的项目先去 `approveCodingTask` 取那句话，再逐字比）。每种都断言任务行数不变、没有留痕。另补边界值照收：目标正好 2000 字、验收条件 8 条且每条 200 字。
6. **条件 6 断言太松**：原来只断言详情里不含字符串「目标」，而传入的目标就叫「目标」，这样测不出泄漏。改成详情 JSON 严格等于 `{ taskId, conversationId, messageCount: 4 }`，并逐条断言不含目标原文和四条消息正文。另补「范围只有一轮时 messageCount = 2」，防止把 4 写死。
7. **条件 7** 原来用裸 SQL 删对话，改走 `ConversationStore.delete`，并断言任务还在、状态仍是 draft。
8. **条件 8** 原来调 `runtime.createCodingTask`，这个方法不存在（任务页走的是 IPC `createCodingTask` → `coding.create`），实现做对了也红。改成取 `registerIpc` 注册的那个 IPC 处理器来调。
9. **IPC 名字写死**（规格「要什么」3、5）：补一条，断言 `createTaskFromConversation`、`listConversationTasks` 都注册了，同一段转两次多建一条，并且按对话分得开。
10. **界面：默认开始写反了**。原测试不挪开始就断言目标是第 1 轮的问题，跟规格「开始默认是它前面那条用户消息」相反。改成默认 m3、目标预填 m3 的正文，挪到 m1 后显示「第 1–4 条，共 4 条消息」，提交时 `fromMessageId = m1`。
11. **界面：个人视角提交不了**。原测试的对话是个人视角，又没选项目，照规格就提交不了。主用例改成项目对话；另加一条个人视角用例：没选项目 `message-to-task-project` 时不能提交，选了项目甲之后提交，参数里带上它。
12. **界面：补齐其他项**。按钮的位置（m3 用户消息没有按钮、streaming 的也没有）；表单就在这条消息里展开；下拉选项用 value 比消息 id，并加一条从 m2 打开、只有 m1 一个选项的用例（原来结束在最后一条，「之前的用户消息」和「全部用户消息」恰好一样，测不出区别）；目标超过 2000 字截断；空白行也算空；不点提交就不建；「已转成任务：<目标前 30 字>」；链接从 `listConversationTasks` 读，挂在 `origin_to_seq` 那条消息下；点链接调 `onOpenTask`。

### 补的：条件 10 任务页来源

- testid 定为 `task-origin-<taskId>`，必须在任务卡片 `task-<taskId>` 里面。这张卡片是 `Tasks.tsx` 现有的 `<Card testId={`task-${t.id}`}>`。
- 来源对话还在：文字含「来自对话「<标题>」第 a–b 条」；点它（里面有 button 或 a 就点那个，没有就点它本身）调 `onOpenConversation(conversationId)`。
- 对话删了（`origin_conversation_id` 为 null、seq 还在）：显示「来自已删除的对话」，不出标题。
- 手建的任务（三列都是 null）：没有 `task-origin-<taskId>`。
- 接口：`TasksPage` 加一个可选属性 `onOpenConversation?: (conversationId: string) => void`。App 里接 `setOpenConversationId(id); setPage('ask')`，跟 `TodosPage` 的同名属性一样。标题从现有的 `listConversations` 拿（替身里给了），实现也可以换别的现有 IPC，测试不限定。

### 变异检查

我临时写了一个最小的假实现（主进程方法 + IPC + `CodingTaskStore.create` 三个参数 + schema/toTask + 聊天页、任务页的界面），确认两份测试全绿：主进程 28/28，界面 9/9。然后逐个改坏一处，每次都看到对应的测试变红：

- 主进程：跳过文件夹检查、传入的项目优先于对话的项目、不查 `complete`、审计里带上目标、目标里拼进对话原文、建完就批准、改结束那条的 `meta_json`、9 条也收、messageCount 写死 4、不记 from seq。10 处全红。
- 界面：默认开始取第一条、failed 的也显示按钮、不去空行、个人视角不拦、链接挂到每条消息下、下拉含全部用户消息（补用例之后才变红）、删了的对话也显示「来自对话」、点来源不打开对话、不截断 2000 字。9 处全红。

假实现已经全部撤掉（`git checkout` 加删掉临时文件），没有提交。撤掉之后：`37 条里 35 红、2 绿`。绿的两条是「任务页手建的三列为 null」和「streaming 的助手消息下没有按钮」，这两条本来就该在没有实现时成立，作用是防回退。

### 锁定

`node scripts/acceptance.mjs lock CF4 "讨论转任务" apps/desktop/test/acceptance/cf4-task-from-conversation.test.ts apps/desktop/test/acceptance/cf4-ui.test.ts`，状态 queued。队列 153 行改成「待写实现（dev）」。

### 给写实现的 dev

- 测试已锁，不许改。觉得哪条有错，写进交付说明，等整合方处理。
- `codingTaskSchema` 加三个可空字段（规格写了），`toTask` 也要映射这三列，不然返回值上没有。
- 派发那一步不许把对话原文加进 `goal`、`taskBackground`、`readScope`（条件 9 看的是执行器收到的全部入参）。

### 留给 Claude

- 迁移 43 是替补整合方写的（见上面的越权说明）。
- CF2 遗留没做：退役 `t2a-suggested-todos`、删 `extractSuggestedTodos`。

## 拆分（2026-11-07，照代审与 AGENTS 300 行规矩）

源码改动约 353 行，超过 300，按规格拆成两支：

- **本支 `dev/CF4`（core + IPC）**：`taskStore.ts` 三列读写 + 标题 join、`entities.ts` / `ipc.ts` 契约、`ipc.ts`/`preload` 两个方法、`appRuntime.ts` 的 `createTaskFromConversation`（类型守卫、项目校验、建任务与审计同事务）与 `listConversationTasks`。验收测试：`apps/desktop/test/acceptance/cf4-task-from-conversation.test.ts`（条件 1–9，28 条）。
- **`dev/CF4b`（界面，基于本支）**：`AskMessage.tsx` 的「转成任务」表单、`Tasks.tsx` 的来源显示、`App.tsx` 的 `onOpenConversation`、`Ask.tsx` 传参；验收测试 `cf4-ui.test.ts`（条件 10，9 条）。交付说明见 `docs/委派/交付/CF4b.md`。

锁定：本支只锁核心那份测试，CF4b 锁界面那份。
