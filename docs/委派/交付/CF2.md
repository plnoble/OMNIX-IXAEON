# CF2 交付说明：聊天行为基线（先只交测试）

分支 `dev/CF2`，B 档。固定合成问题集 8 句原文写死在 `apps/desktop/test/acceptance/cf2-chat-baseline.test.ts`。

## 测试对应条件

| 条件 | 内容                                                                                               | 现在                                 |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1    | 问题 1–7：待办/编码任务行数不变、meta 无 `proposedTodos`、正文里「建议待办：」原样在               | 红（现在会拆成待办、正文被摘掉）     |
| 2    | 问题 8 建且只建一条用户待办（标题「周五前把发票寄出去」、来源 user），编码任务不变                 | 红（现在正文段也变成待办，多出几条） |
| 3    | 工具清单正好五个                                                                                   | 绿（现状已对）                       |
| 4    | `propose_coding_task` / `git_commit` 被拒、不建东西、不起子进程（`vi.mock` 盯 `spawn`/`execFile`） | 绿（现状已拒）                       |
| 5    | 已有 AI `proposed` 旧待办问完 8 句不动                                                             | 红（现在被改写/状态被动过）          |
| 6    | 问题 1 照常存档、存的正文带「建议待办：」                                                          | 红（现在存档前被拆掉）               |

运行：`6 tests | 4 failed | 2 passed`（1/2/5/6 红，3/4 绿），符合「实现还没改」的预期。已 `lock CF2`。

## 要退役 / 改写的旧断言（T2a，整合方处理，我没改）

1. `apps/desktop/test/acceptance/t2a-ask-todos.test.ts`
   - `it('落成等你拍板的待办，记着来自哪次对话、哪条回答；回答里去掉那一段')`：要求把回答末尾「建议待办」拆出来建待办、并从回答里删掉——与条件 1、6 冲突。
   - `it('你拒绝过的同一件事不再提，也不出现在这条回答上')`：依赖上一条建出的待办与 `meta.proposedTodos`——冲突。
   - 同文件里对 `meta['proposedTodos']` 的断言（L106、L118）——冲突（这一单后不再有该字段）。
   - `it('回答里没有这一段：不建待办，也不记 proposedTodos')` 与 `it('直接加成要做的待办…')`：不冲突（前者断言「没有就不建」，后者是用户发起的待办）。
2. `packages/core/test/acceptance/t2a-suggested-todos.test.ts`
   - 若条件 1 把 `extractSuggestedTodos` 删掉（`suggestedTodos.ts` 只在提问路径用），这份文件整份要退役；里面的 `describe('回答末尾的「建议待办」')` 5 条都是解析函数本身。
   - 其中 `describe('你自己在消息开头写「待办：」')` 是用户发起待办的行为，建议保留（可搬到别处），不冲突。
   - `describe('告诉 Hermes 怎么列')` 与 Hermes 约定有关，本单不改，可留。
3. `apps/desktop/test/acceptance/g04-task-origin.test.ts`
   - 条件 3 的断言点是回答消息 `meta.proposedTodos`（文件头注释与断言）：与「不再有 proposedTodos」冲突，需改写为看 `propose_task` 的 runId 来源。
4. `apps/desktop/test/acceptance/t2a-todo-cards.test.ts`
   - 核对结论：它用固定的 `meta.proposedTodos` 夹具画卡片；旧待办（含「建议」状态）还会显示，**行为上不冲突**，但若 `proposedTodos` 类型被删，**编译层面会红**，需改成直接按 todos 行构造。请整合方定。
5. `packages/core/test/acceptance/t2a-hermes-instruction.test.ts`、`packages/core/test/acceptance/cf3-prompt.test.ts`
   - 都断言「Hermes 约定 / 提示词里有『建议待办』约定或不含某段」，本单明确「不改系统提示、不改 Hermes 约定」，**不冲突**。

## 真机检查

未跑（先只交测试）：`scripts/real/cf2-baseline-counts.mjs` 与 8 句真实提问留到实现后一起做。

四项：已实现=无（只测试）；自动化通过=2/6（3、4）；真机通过=未跑；用户接受=未接受。

## 整合方锁定（2026-11-06）

改了测试的地方：

- **待办表记来源的列叫 `origin`（`agent` / `user`），没有 `source`**。条件 2 和条件 5 原来查、写的是 `source`，正确的实现也会报 SQL 错，条件 5 现在就红在这里。已改成 `origin`。条件 5 补了一句：问完 8 句，除旧待办外库里只有一条用户的待办。
- **条件 4** 补「拒绝之后这一轮照常完成」：最后一条消息状态 `complete`、正文是替身的普通回答。
- **条件 6** 补「交给存档的内容里带着那段」：查 `captureAsk` 收到的参数，不只查消息。

一次性原型（不提交）：把提问路径里 `extractSuggestedTodos` 那两行换成「原样不拆」，CF2 六条全过。改之前，条件 1、2、5、6 都红在「还在把回答变成待办」，红得对。

退役（跟 CF2 冲突，用户 11-03 定）：

- `t2a-ask-todos.test.ts` 两条：「落成等你拍板的待办…回答里去掉那一段」「你拒绝过的同一件事不再提…」。T2a 重锁。
- `integration/t2a-followups.test.ts` 一条：「问答存档与返回值里都没有『建议待办』那一段」（集成测试，不在锁定清单里）。
- 原型下这三份照旧全过。dev 列的其它几份核过：`g04-task-origin` 原型下没红，不用改；`t2a-todo-cards`、`t2a-hermes-instruction`、`cf3-prompt` 不冲突；`t2a-suggested-todos` 只测解析函数，实现时要是删了解析函数，再来找整合方退役。

可以写实现了。

## 实现（2026-11-06）

- 改了 `apps/desktop/src/main/appRuntime.ts` 的提问路径：删掉 `extractSuggestedTodos` 的调用与 `proposedTodos` 的建待办循环、`finishMessage` 的 `meta.proposedTodos`；正文、存档、返回值都用原样的回答。`parseUserTodo`（用户自己写「待办：」）一字未动；系统提示、Hermes 约定、工具清单都没改。
- `suggestedTodos.ts` 没删：`SUGGESTED_TODOS_INSTRUCTION` 等仍被 `cf3-prompt` 引用，删了会红；`extractSuggestedTodos` 已无生产调用，但它的解析测试 `t2a-suggested-todos` 还锁着，删函数会让那份锁定测试红。按规格「没有别处在用就删」与「不改锁定测试」的冲突，这一步留给整合方：退役那份解析测试后再删函数与导出（审查意见也是这么定的）。

## 自动化通过

```
$ node scripts/acceptance.mjs run CF2
Tests  6 passed (6)
```

`tsc`、`eslint` 干净。

## 真机通过（2026-11-07 补跑，过了）

`node scripts/real/cf2-baseline-counts.mjs`：临时数据目录、本机 magpie、8 句固定问题按顺序问：

```
聊天模型（保存后）： magpie
uses.chat： {"providerId":"p-…","model":"antigravity/claude-opus-5-5"}
用的模型： antigravity/claude-opus-5-5
待办行数： 1 ｜其中来源用户： 1
编码任务行数： 0
完成的助手消息数（应为 8）： 8 ｜助手消息总数： 8
8 轮里回答正文含「建议待办」的轮数： 0
```

脚本现在：每轮等按钮重新可用；关应用前轮询到 8 条助手消息全部 `complete`，不到 8 条直接失败；超时只报「第 N 句没有完成」，不打印任何回答原文。聊天模型按规格走 UI：在「用途」卡片里把后台分析和聊天都选成勾选过的那个 magpie 模型，再点保存（`uses.chat` 已核对非空）。

上一轮没跑通的原因：用途卡的「聊天」下拉没真的存上（`uses.chat` 为 null），点提问按钮一直是 disabled，8 句一句都没发送。这次按规格走 UI：把「后台分析」和「聊天」都选成勾选过的那个 magpie 模型再保存，`uses.chat` 已核对非空。

## 整合方复审（2026-11-07，由 DSH + group/ixaeon-integrator 代做）

替补整合方（Claude 登录过期）。执行方用的不是这个模型。复审的是 `dev/CF2`（`abd381e`）合进最新 main 之后的 `integrate/CF2`，整合提交是 `1b86cae`。

**代审「必须改」逐条核实**

1. **条件 1、6 的「原样保留」断言不够严**：核实属实。原来的测试只查正文里有「建议待办：」这个标题。做了变异检查：在提问收尾里加一行「删掉 `- ` 开头的列表行、只留标题」，原测试 6/6 照样通过。我把测试改严了，改的是 `cf2-chat-baseline.test.ts`，只加断言、不删不放宽：
   - 条件 1：每一轮的助手消息正文 `toBe(SUGGEST)`，也就是整段替身回答，「- 甲」「- 乙」都在；
   - 条件 6：`captureAsk` 收到的 `question` 等于问题 1，`answer` 和消息正文都 `toBe(SUGGEST)`；
   - 条件 4（代审第 3 轮也提了，执行方已把拒绝文案改成「没有这个工具：…」）：回给模型的内容必须同时含「没有这个工具」和那个工具名；
   - 文件头那句已经过时的「现在实现还没改，本文件应当红」改成了改严说明。

   改严后的变异检查：用上面那个「删列表留标题」的变异，条件 1、6 都红；把拒绝文案改回旧的「工具 X 不在…清单里」，条件 4 红。还原后 6/6 通过。用原标题重锁：`node scripts/acceptance.mjs lock CF2 聊天行为基线 apps/desktop/test/acceptance/cf2-chat-baseline.test.ts`。
2. **`extractSuggestedTodos` 已没有生产调用**：核实属实。`git grep` 的结果是，除了 `packages/core/src/index.ts` 的导出，只有锁定测试 `t2a-suggested-todos.test.ts` 在用它。**这次没删函数，也没动那份测试。**理由：那份测试在 main 上，属于已并入的 T2a 锁定测试。按 [代审与替补整合](../代审与替补整合.md)，「让锁定的旧测试退役」只能由 Claude 做，替补整合方不能做。只删函数不退役测试，门禁会红。留给 Claude 回来做两件事：①退役 `t2a-suggested-todos` 里「回答末尾的『建议待办』」那组只测解析函数的用例，并重锁 T2a；②删掉 `extractSuggestedTodos` 和它的导出。「你自己在消息开头写『待办：』」和「告诉 Hermes 怎么列」两组照规格保留，`SUGGESTED_TODOS_INSTRUCTION` 还有人在用。
3. **真机脚本与证据**：开发方已改成在 UI 里选用途、等 8 条 complete、超时不打印正文，这三点核实属实。我复跑时又发现并修了四处，都在 `scripts/real/cf2-baseline-counts.mjs`：
   - 问题 6 跟规格原文对不上：脚本写的是「修 bug」加「」，规格和锁定测试是『修 bug』。已改成规格原文。
   - 计数前加了校验：新临时库里助手消息必须恰好 8 条、而且全部 complete，否则失败。代审的建议项也提了这一点。
   - 交付说明说「超时只报第 N 句」，原脚本其实不报 N。现在报「第 N 句没答完」；没答完时只报各状态的条数，以及错误里的 HTTP 码或「超时」字样，不输出正文和错误全文。
   - 加了可选的 `CF2_REAL_MODEL=<模型 id>`，指定在 UI 里勾哪个模型，默认还是第一个。原因：第一个模型 `antigravity/claude-opus-5-5` 复跑时 8 句全部 429（网关限流），换一家才跑得通。每一轮的超时也改成先等消息出现、再等发送按钮重新可用（最长 300 秒）。

**真机复跑**（临时数据目录，本机 magpie，在 UI 里勾 `opencode-go/deepseek-v4.1-flash` 并在用途里选它，同一个新对话按顺序问 8 句）：

```
聊天模型（保存后）： magpie
uses.chat： {"providerId":"p-…","model":"opencode-go/deepseek-v4.1-flash"}
用的模型： opencode-go/deepseek-v4.1-flash
待办行数： 1 ｜其中来源用户： 1
编码任务行数： 0
完成的助手消息数（应为 8）： 8 ｜助手消息总数： 8
8 轮里回答正文含「建议待办」的轮数： 0
（临时目录已遮：<临时目录>）
```

结果符合预期：待办 1（来源用户 1），编码任务 0。没贴回答原文。前几次没跑通的记录：用 `antigravity/claude-opus-5-5` 时，一次 7 句失败、一次 8 句全失败，失败类别全是 429；用 deepseek 第一次在第 1 句之后超时，原因是按钮等待只有 60 秒。

**代码抽查**：看了 `apps/desktop/src/main/appRuntime.ts` 的提问收尾。`result.answer` 原样传给 `captureAsk`、`finishMessage.content` 和返回值。建待办的循环和 `meta.proposedTodos` 都删了。`userTodo`（消息开头写「待办：」）那一套没动。直连工具清单和系统提示没改。拒绝分支只改了文案。没有迁移，没有删数据。

**自动化**：`node scripts/acceptance.mjs run CF2` 6/6 通过（改严之后）。本机 `node scripts/verify.mjs` 全部通过，含 acceptance-lock、acceptance、local-user。GitHub CI 在 `integrate/CF2`（`1b86cae`）上的 verify 是 success。

**合并**：用 `git merge --no-ff origin/integrate/CF2` 并入 main，跑了 `node scripts/acceptance.mjs done CF2`，队列第 150 行改成「已完成（2026-11-07）」。

**四项**：已实现 = 是；自动化通过 = 是（CF2 6/6，verify 全过，CI 绿）；真机通过 = 是（上面的计数）；用户接受 = 未接受。

**留给 Claude**：①退役 `t2a-suggested-todos` 里只测解析函数的那组用例并重锁，再删 `extractSuggestedTodos` 和导出；②抽查这里改严的 CF2 断言和重锁的指纹。