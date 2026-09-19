# 规格 W1a：从记忆里提「值得持续关注的方向」，你勾了就每天自动找

档位：**B**（把个人记忆发给模型；新的搜索开销）。大小：中（≤300 行）。依赖：无。
v2 规格：你先把验收条件写成测试（`apps/desktop/test/acceptance/w1a-*.test.ts`），**先只推测试**等整合方看过并锁定，再实现。

## 要什么

场景二的最小版：IXAEON 知道用户关心什么（全天智记、机器人、能跑大模型的手机……），应该自己盯着这些方向，有新东西就告诉他。研究功能已经有了（研究主题、按天定时、搜索预算、发现），缺的是「从记忆里提方向、用户勾选」这一步——现在要用户自己一条条建研究主题，没人会去建。

研究页顶上加「帮我想想该关注什么」：

1. 点了先弹确认：「会把你的 N 条目标、在做的项目、约束（记忆）发给模型，让它提 3–5 个值得持续关注的方向」，列出条数（不列内容）。用户点「好」才发。**每次点都要确认**（个人记忆默认不发给模型，这是用户主动要的一次）。
2. 发的是：状态有效的目标、约束类记忆（排除还没采纳的 AI 建议）和项目名称与描述，最多 40 条。用 Core 的模型（`getProvider()`），不走 Hermes。
3. 模型返回最多 5 个方向，每个：`question`（内部用，可以带用户背景）、`publicDescription`（**对外检索用，不许含个人信息**）、`why`（依据哪几条记忆，给记忆编号）。解析不出来就报错，不编。
4. 显示成卡片：方向、「对外检索用：<publicDescription>」、依据（记忆原文，点开看）、「每天自动找一次，最多搜 3 次」（搜索没配置时写「只看你加的来源」）。按钮「关注」/「不关注」。
5. 「关注」→ `createResearchTopic`：`question`、`publicDescription`、`relatedGoalId`（依据里第一条目标）、`relatedProjectId`（依据涉及的项目，有的话）、`intervalMs` 一天、搜索已配置时 `paidBudgetMode: 'request_cap'`、`requestCap: 3`，否则 `'none'`；并启用。
6. 「不关注」→ 记住（`app_settings` 里一个键存拒绝过的方向，最多 200 条），以后再提相似的（字符二元组 Jaccard ≥ 0.6，同待办）不显示。已经有的研究主题也不重复提。

## 约束

- 不加迁移（提议不落库，只有拒绝记在 `app_settings`，关注的就是研究主题本身）。
- 发给模型的只有上面第 2 条列的记忆；在交付说明里贴出提示词全文。
- `publicDescription` 会发给搜索服务：提示词要求不含个人信息，卡片上原样显示给用户看。
- 不改研究的定时、搜索、发现那几块。

## 验收条件

1. 点按钮先出确认，条数对；取消就什么都不发。
2. 确认后发给模型的内容只含有效的目标、约束、项目（不含没采纳的 AI 建议、不含别的个人记忆），最多 40 条。（用假的模型截下请求。）
3. 模型返回 5 个方向：显示 5 张卡，对外检索描述、依据、预算说明都对；返回格式坏了：报错、不显示卡片。
4. 「关注」建出研究主题：字段按第 5 条，已启用；搜索没配置时是 `'none'`。
5. 「不关注」之后再点「帮我想想」，模型又提了同样（或相似）的方向：不显示。已有同名研究主题的方向也不显示。

## 真机检查

在 `scripts/real/` 加一个脚本：临时库里放一组**合成的**记忆（例如「想做一个全天记录的个人助理」「关注人形机器人」「想换一台内存大、能跑本地大模型的手机」），用真的模型走一遍提方向，贴出返回的方向与对外检索描述，如实写有没有把个人信息写进对外检索描述。

## 契约（整合方 2026-09-19 复审测试时定下，锁定测试按这个调）

- `previewWatchDirections(): Promise<{ memoryCount: number }>`：确认框里显示的条数 = 这次会发的记忆条数（不含项目）。
- `suggestWatchDirections(): Promise<{ searchConfigured: boolean; directions: WatchDirection[] }>`，`WatchDirection = { question, publicDescription, basis: Array<{ id, statement }>, relatedGoalId: string | null, relatedProjectId: string | null }`：
  - 模型按 `{ directions: [{ question, publicDescription, why: 记忆编号[] }] }` 返回（`chatStructured`）；不是这个形状、或哪个方向缺字符串的 `question` / `publicDescription`：整次报错，不返回任何方向；
  - `basis` 由主进程按 `why` 对回这次发出去的记忆原文，认不出的编号丢掉；`relatedGoalId` 取依据里第一条目标，`relatedProjectId` 取它的项目（没有目标就取依据里第一条有项目的记忆的项目）；
  - 超过 5 个只留前 5 个；问题或对外检索描述与拒绝过的、已有研究主题的相似（字符二元组 Jaccard ≥ 0.6）就不返回。
- 「有效」的记忆：没被拒绝（`confirmation != 'rejected'`）、没被取代（`state = 'current'`）、没标成已结束（`time_status != 'ended'`）；「没采纳的 AI 建议」按 `isUnadoptedAiAdvice` 判。超过 40 条取最近更新的 40 条。个人记忆和项目记忆都算（这是用户点了确认的一次）。
- `followWatchDirection({ question, publicDescription, relatedGoalId, relatedProjectId })`：建研究主题并启用；搜索可用看 `research.searchAvailable`。
- `skipWatchDirection({ question, publicDescription })`：记进 `app_settings`，重启后仍然有效。
- 界面测试用到的标识：`research-suggest`、`research-suggest-confirm`、`research-suggest-count`、`research-suggest-ok`、`research-suggest-cancel`、`research-direction-<序号>`、`research-direction-public-<序号>`、`research-direction-basis-<序号>`、`research-direction-budget-<序号>`、`research-direction-follow-<序号>`、`research-direction-skip-<序号>`。

执行方原来的测试把「没采纳的 AI 建议」写成了 `open_loop` 类型的条目——本来就不在「目标、约束」里，等于没测；也没测被拒绝、已结束的记忆和搜索已配置时的预算。整合方补全后重新锁定。
