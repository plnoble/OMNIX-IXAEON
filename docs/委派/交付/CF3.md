# CF3 交付说明：聊天改用直连模型做主引擎（本轮只交测试）

档位 **B**。本轮按规格「B 档的流程：先只推测试」执行：**只写验收测试，没有实现**。

规格：[CF3-直连模型做聊天主引擎.md](../CF3-直连模型做聊天主引擎.md)

## 改了哪些文件、各多少行

全部是**新增测试文件**，没有改任何源码、没有改任何既有测试、没有加迁移：

| 文件                                                     | 行数 | it 数 | 覆盖的验收条件                         |
| -------------------------------------------------------- | ---- | ----- | -------------------------------------- |
| `packages/core/test/acceptance/cf3-chat-stream.test.ts`  | 210  | 5     | 1、2、3（含反向）、4                   |
| `packages/core/test/acceptance/cf3-direct-chat.test.ts`  | 230  | 5     | 5、6、7（含超限）、9                   |
| `packages/core/test/acceptance/cf3-prompt.test.ts`       | 70   | 7     | 8（拆成 7 条断言）+ 提示词版本号       |
| `apps/desktop/test/acceptance/cf3b-direct-chat.test.ts`  | 542  | 9     | 10、11、12（两条）、13、14、15、16、17 |
| `apps/desktop/test/acceptance/cf3b-engine-label.test.ts` | 81   | 1     | 18                                     |

合计 **1133 行 / 27 个 `it`**。18 条验收条件逐条落位，一条没删、没放宽；
每个文件开头都有注释逐条对应条件编号。

一律不联网、不碰真库：core 侧用内存假 SSE 服务（`ReadableStream` + `Response`，照 `m1-streaming` 的既有写法）
与 `FakeStreamChatClient`；桌面侧用假 OpenAI 兼容网关（stub 全局 `fetch`），`IXAEON_DATA_DIR` 指向临时目录。
合成数据：模型名 `demo-a`、Key `sk-synthetic`、记忆与问题全是编的；没有真实网关地址、Key、模型清单、真实记忆。

## 已实现

**没有实现。** 本轮按 B 档流程只交测试；`chatStream.ts`、`directChat.ts`、CF3b 的接线一行都没写。

## 自动化通过

**不通过，而且这是预期的。** 测试现在按现状实现应当失败。

核心实测输出（`node node_modules/vitest/vitest.mjs run --project acceptance <文件>`）：

```
cf3-chat-stream.test.ts  5 tests | 5 failed   TypeError: OpenAIChatStreamClient is not a constructor
cf3-direct-chat.test.ts  5 tests | 5 failed   TypeError: FakeStreamChatClient is not a constructor
cf3-prompt.test.ts       7 tests | 7 failed   （缺 DIRECT_CHAT_* 导出）
```

```
cf3b-direct-chat.test.ts 9 tests | 8 failed | 1 passed
cf3b-engine-label.test.ts 1 test  | 1 failed
```

**红的原因全部是「契约里的导出还不存在」，不是测试写错**：

- core 三个文件：`OpenAIChatStreamClient is not a constructor`、`FakeStreamChatClient is not a constructor` 等；
- 桌面：`expected 'hermes' to be 'direct'`（现在还没走直连）、`expected '这条来自 Hermes 替身，不该出现' to contain '照常回答'` 等。

**唯一一条现在就是绿的：条件 17**（「聊天模型没配 → 走现在的路径，原有行为不受影响」）。
它不是"实现提前做好了"，而是**回归守卫**：它断言的是「旧路径不要被这次改动弄坏」，所以今天应当绿、
实现之后仍应绿。这一点我不含糊其辞——它是唯一绿的一条，且是设计如此。

### 类型检查（测试本身要能编译）

仓库的 `tsconfig.json` **把 `packages/*/test/acceptance/**` 与 `apps/*/test/acceptance/**` 排除在外**
（这是既有约定，队列 Q1 就是收这件事），所以门禁的 `typecheck` 一步根本不看这些文件。
为了落实「测试本身要能编译」，我用一个临时 tsconfig 把这 5 个文件单独纳入、跑了一次定向类型检查：

```
总错误 = 12   按码: TS2305=9  TS2724=3
```

**12 个错误全部是 `Module ... has no exported member 'X'`**，即规格「契约」一节里写好、但还没实现的那些导出。
**其它类型错误 0**（没有 implicit any、没有签名不符、没有别的）。
也就是说：实现一到位，这 5 个文件就能过类型检查。

另外 `node_modules/eslint/bin/eslint.js` 对这 5 个文件 **exit 0**，`prettier --check` 干净。

## 真机通过

**没跑，而且这一轮跑不了。** 规格的真机检查甲/乙都要求先把实现写出来并起假的 OpenAI 兼容网关
（甲还要开应用截图，乙要经 `run-batch.mjs` 跑 `scripts/real/cf3-direct-chat.ts`）——本轮只有测试，
没有可跑的东西。按 B 档流程，真机检查在整合方锁定测试、实现写完之后做。

所以：**真机通过 = 未跑（不是通过，也不是失败）**。

## 用户接受

**未取得。** 规格第丙项（用户用自己的数据连着聊三轮）本来就只能实现并合并之后再做。

## Codex 审查

**不适用。** B 档由整合方复审，不走 `codex-review.mjs`。

## 三处需要整合方知道我的判断（不是改条件，是把读法写清楚）

1. **条件 8 的「不含『建议待办』」怎么测**：规格「要什么」第 3 条明确要求提示词里**写上**
   一句「不要在回答末尾附『建议待办』」，所以提示词里必然出现这四个字。
   我的断言是：**每一处出现所在的那一行都必须带 `不要|不许|别|无需` 之一**（即只出现在否定语境），
   并且必须至少有一处这样的否定句。没有简单地断言「全文不含这四个字」——那样会与第 3 条自相矛盾。
2. **条件 18 的「显示『直连』」**：现有渲染是 `引擎 {m.engine} · 模型 {m.modelName}`
   （`apps/desktop/src/renderer/src/pages/AskMessage.tsx:408`），而条件 10 要求消息里存的是英文 `'direct'`。
   因此实现必须在渲染层把 `direct` 映射成中文「直连」。测试断言渲染文本匹配 `/直连/`、
   含模型名，且**不得**出现 `引擎 direct`（防止英文原样漏出）。
   如果整合方的本意是消息里直接存「直连」而不是映射，这条要改的是规格，请指示。
3. **条件 11 的夹具**：用 `ItemService.createManual({ scope: 'personal', ... })` 造一条合成个人记忆，
   用 `setPersonalMemoryToChat(db, true/false)` 开关，断言工具结果里有/没有这条。
   并额外用「工具结果 = 记忆桥同一方法」的等价性来钉「不许抄第二份」这条要求。

## ⚠️ 必须让整合方/用户知道：CF3 有两侧重复劳动

推进到「改队列」这一步时才发现，同一行 CF3 已经被**接力第 87 棒**做过一遍，并且它把这个冲突挂给了用户：

- 队列提交 `1ef01e3` 的原文：「等用户：CF3 同一行被窗口 agent 在 10-03 领走（窗口进行中，同名 dev/CF3）；
  接力第 87 棒也已按规格写好 11 条测试（本机未推），两边只能留一边，哪边继续？」
- 那批工作没有被丢弃，仍在**一处未被 git worktree 登记的独立副本**里：
  `D:\Agent\Worktrees\IXAEON\dsh\CF3`（独立 clone，分支同为 `dev/CF3`，
  本地提交 `8f8dae68`「CF3 测试：直连模型客户端与引擎循环 11 条验收测试（B 档先只交测试；因与窗口同一行撞车未推）」）；
- 磁盘上再没有第三份 cf3 测试；`git stash list` 为空；主干与远程都没有那 11 条。

两侧内容对比（**不是谁对谁错，是重复**）：

|              | 接力第 87 棒（`dsh/CF3`，未推）           | 本次窗口（`dev/CF3`，已推） |
| ------------ | ----------------------------------------- | --------------------------- |
| 覆盖条件     | **1–9（仅 CF3，core）**                   | **1–18（CF3 + CF3b）**      |
| 用例数       | 11                                        | 27                          |
| 文件         | 1 个（`cf3-direct-chat.test.ts`，469 行） | 5 个（1133 行）             |
| 桌面侧 10–18 | **没有**                                  | 有                          |

我的处理：**没有删除、没有覆盖对方那份**，只是按用户在本窗口的直接指示（11-03 让我做 CF3、窗口里状态写「窗口进行中」）
继续推进并把队列改成「测试待审（整合方）」。**请整合方/用户裁定最终保留哪一侧**：

- 若要保留本侧：`dsh/CF3` 那份建议由整合方在本机删除或归档，避免将来误推；
- 若要保留 `dsh/CF3` 那侧：本分支可整体丢弃，但**桌面侧 10–18 需要那边补写**（那侧没有覆盖）。
- 若想取长补短：1–9 两边可逐条对照（本侧的 1–9 与它等价，多出的是 18 条断言的细分与反向用例）。

这条我不自行决定——它已经挂过一次用户了，再自己咽下去就等于替用户做了选择。

## 已知缺口 / 交给整合方

- **测试锁定**：按 B 档规矩，我没有把测试锁进 main（`lock` 只写本分支的指纹清单），也没有合并、没有 `done`。
- **`acceptance.mjs lock` 的落点**：本轮执行的是规格要求的分支内 `lock`（登记指纹供整合方核对）；
  整合方复审并合入 main 后，main 上的锁定由整合方负责。
- **条件 14 的 `injectedMemoryByTurn` 是私有方法**：测试用 `as unknown as { injectedMemoryByTurn(...) }`
  的形状访问它（该方法在 `packages/core/src/extraction/extractor.ts:505`，是 private）。
  如果整合方不希望测试直接碰私有方法，请指示改测「提炼结果里 AI 建议是否被收下」这一外观行为。
- **条件 12（配了搜索）** 用替身 `WebSearchExecutor`（`{ provider, search }`）记录收到的查询词；
  断言合成邮箱 `someone@example.com` 在发出去之前已被替换。替身返回的是最小结果形状，
  实现若对结果形状有更多要求，这条可能需要补。
- **没有改动** `AgentSession`、Hermes 适配器、Core 有界循环（那是 CF3c），也没有加迁移（42 已在 main）。

## 整合方复审测试（2026-11-03）

保留窗口这一版（`dev/CF3`，覆盖 1–18）；接力第 87 棒的 `dsh/CF3` 本地副本作废。改了 6 处，全是补严或修测试自身的错，条件一条没删、没放宽：

1. 条件 17：`chatModelName()` 空着会退回 `modelName`，光清模型名还是三样齐，正确的实现也过不了。改成清掉地址来造「没配」。
2. 条件 16：取消可能在假流的 gate 放开之前发生，abort 事件会错过、流一直挂着。改成先看 `signal.aborted`。
3. 条件 1：鉴权头改成 `new Headers()` 读，实现用普通对象还是 Headers 都行。
4. 条件 5 补严：tool 结果前面要有那条带 `toolCalls` 的 assistant 消息（OpenAI 兼容端点的要求）。
5. 条件 7 补严：上下文在此前轮次之前，此前轮次在这一问之前。
6. 条件 11 补严：工具结果就是记忆桥 `search_memory` 那个对象（带 `today`、`items`），JSON 序列化后交回模型。条件 13 补测 `record_observation`。

锁定后现状：27 条里 26 红 1 绿。红的全是「还没实现」（导出不存在、走的还是旧路径）；绿的是条件 17。没用原型实现验证过，写实现时发现测试本身有错，停下写进本文件交整合方，不要自己改。
