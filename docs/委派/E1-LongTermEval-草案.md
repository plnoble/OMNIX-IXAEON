# 规格草案 E1：7 天长期评测（Long-Term Agent Evaluation）· v2

> dev2 按用户 2026-10-27 任务书**大块四**起草。**草案，不是生效规格。**
> **v2 已把统筹同日拍板的 5 项口径全部落定**（Correction 分母、Stale 两部分、Hard Quiet=0、
> 人工判分真值归属、真实数据不进公开 repo），并补上「North Star 四项独立布尔、禁止压总分」。
> 计数纠正为 **19 项指标**（原文 5 组：Memory 4 + Goal 3 + Agent 4 + Proactivity 4 + Cost 4）。
> 与 M1/H1 同规矩：先立草案 + 队列登记，**不写实现**；定稿与排期归统筹/整合方。
> 依赖：G1（Goal）、M1（记忆合并）、H1（心跳）——E1 是**评测层**，不产生产品功能。

## 1. 要什么（用户原文 1–2 节）

**目的**：当前最高验收标准「连续聊三轮，它记得住，并且替用户做完一件事」**已经不够用**。
需要建立新的产品级验收标准。

**第一阶段 North Star（原文，照抄不改）**：

> 连续使用 IXAEON 7 天，它能够记住关键上下文、持续推进至少 3 个真实目标，
> 其中至少 1 件事情在用户没有再次提醒的情况下**主动继续推进并完成**，
> 同时**没有产生明显无效打扰**。

**这条 North Star 的价值在于它有四个独立的「不」**，缺一不可：
不是「用了 7 天」，而是①记得住关键上下文；②**≥3 个真实目标**被持续推进；
③**≥1 件**在用户不提醒的情况下**主动**推进并**完成**；④**没有明显无效打扰**。
只满足①③（比如不停提醒才算「主动」）不算达成。

### 1a. North Star **不得压成一个总分**（统筹 2026-10-27 定）

报告顶部**必须**始终并列显示四个独立布尔结果，任何一项不许被加权平均掉：

```text
Memory continuity           PASS / FAIL / NOT EVALUATED
>=3 real goals progressed   PASS / FAIL / NOT EVALUATED
>=1 autonomous completion   PASS / FAIL / NOT EVALUATED
Hard Quiet Violations = 0   PASS / FAIL / NOT EVALUATED

North Star = PASS  仅当四项全部 PASS
```

理由（统筹原话意思）：否则会出现「记忆 95 分、主动性 90 分，平均下来通过」，
却**实际一周骚扰了用户十几次**这种荒唐结果。
实现层要求：`north_star` 是**四个独立字段**，不是一个百分比；任一为
`FAIL`/`NOT EVALUATED` 时总判定不得为 PASS（`NOT EVALUATED` 不等于放行）。

## 1b. 「明显无效打扰」= **Hard Quiet Violation 必须为 0**（硬失败线）

不采「≤2 次」之类宽容线。H1 已把 Quiet Policy 写成**代码规则**，
违规则不是主观质量差异，而是**明确违反产品契约**，出现 1 次即 North Star 第④项失败。

`Hard Quiet Violation` 的四种情形（任一计数即违规）：

1. 同一 `notifyKey` 在**同一北京日**重复单发；
2. `routine` / `digest` 越过窗口**单发**（未合窗）；
3. 已在抑制名单 / `suppressed` 的事项**仍然发送**；
4. **并非 Goal 真阻塞**（无 `blocked_reason` 或 G1b 判定的 watch 依据）却以 `urgent` 单发。

**软打扰不进硬失败线**：用户觉得「没价值但没违反规则」的，单独计入
`Unnecessary Interruptions`，**不因单个主观低价值提醒判整周失败**。
两类数必须分列，不许合并成一个「打扰数」。

## 2. 评测原则（原文第 4 节，落成硬约束）

1. **真实使用与合成测试分开**，两边的数字**不许混在一张表里**；
2. **测试全绿 ≠ 7 天评测成功**（这一条与仓库 AGENTS「不看门禁绿不绿」完全一致）；
3. 最终必须同时保留四类材料：**自动指标 / 真正 7 天运行结果 / 用户反馈 / 失败案例**。

推论（写进验收）：E1 的产出**不许**是「一次跑通的脚本」。
脚本只是采数工具；没有真实 7 天数据时，E1 状态只能是「未开始评测」，不是「评测通过」。

## 2a. 人工判分的真值归属（统筹 2026-10-27 定）

- **用户本人是最终真值**；系统/整合方只负责**预标与整理**；
- Goal Progress Accuracy、Blocker Detection Accuracy、Useful Proactive Action 等
  **主观正确性指标**，最终 annotation 必须允许用户 `confirm / reject / adjust`；
- **禁止**开发者给自己的系统打分后当最终结果；未经用户确认的预标只能标「预标待确认」。

## 2b. 真实数据存放与公开边界（统筹 2026-10-27 定）

- **绝不进公开 GitHub repo**；
- 原始评测数据放**本机 IXAEON data 目录下的独立 `eval/` 存储**：
  `<IXAEON_DATA>/eval/<run-id>/`；库内可存 `eval_runs` / `eval_annotations`；
- 仓库里**只允许**：脱敏后的模板、schema、合成样例、必要的匿名汇总报告；
- **真实对话 / Goal / 记忆内容 / 用户反馈原文默认不 push**（与 AGENTS 隐私规矩一致）。

## 3. 指标清单 + **每一项的数据来源实测**（这是本草案最要紧的部分）

用户列了 5 组 19 项指标。我把每一项都对到**现有代码里的真实来源**，
凡是**没有来源**的，明确标「❌ 无采集基础，需新增埋点」——规格不能写测不到的指标。

### 3.1 Memory

| 指标                        | 定义（**口径已拍板**，见下）                                                  | 现有来源                                                                                        | 判定                    |
| --------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| Recall Success Rate         | 该召回的记忆被召回的比例                                                      | ❌ 无检索日志                                                                                   | **需新增埋点**          |
| Wrong Memory Injection Rate | 召回了不该出现的记忆的比例                                                    | ❌ 无「注入了哪些条目」记录                                                                     | **需新增埋点**          |
| User Correction Rate        | **`corrections 次数 / memory-injected assistant turns`**（分母已定，见 3.1a） | ✅ `corrections(id, old_item_id, user_text, new_item_id, created_at)` 已存在；分母需 E1a 补埋点 | 可测（分母随 E1a 落地） |
| Stale Memory Rate           | **自动可证 stale + 人工发现 stale 两部分分列上报**（定义见 3.1b）             | ⚠️ 半有：`items.state ∈ (current,disputed,superseded)` + `superseded_item_id` + 有效期字段      | 部分可测，两部分分报    |

#### 3.1a Correction Rate 的分母（统筹 2026-10-27 拍板，**不是**交互总数）

```text
User Correction Rate = 因记忆错误产生的 correction 次数 / memory-injected assistant turns
```

**为什么不用总交互数**（统筹给的反例，照记）：
聊 100 次、其中只有 5 次用到长期记忆、错 1 次——
用 100 当分母是 1%，**实际记忆相关错误率是 20%**。总交互数会严重稀释问题。

- 分母 = **实际发生长期记忆注入的 assistant turns**（不是所有 turns）；
- **没有记忆注入时 → `N/A`**（不写 0%，见验收 4）；
- 分子只算**因记忆错误**产生的 correction（区分「纠正记忆」与「纠正别的」，靠 `corrections.old_item_id` 指向记忆条目来判定）；
- E1a 本来就要补 retrieval/injection 埋点，**把分母一次做对**。

#### 3.1b Stale Memory 的正式定义（统筹 2026-10-27 拍板）

```text
Auto-confirmed stale:
  current item
  AND (
    存在更新的 user-confirmed correction / superseding item
    OR 显式有效期 / 时间范围已经结束
  )
  AND 旧 item 仍参与 current-memory retrieval
```

三条**同时**成立才算自动可证 stale——注意第三条「仍参与检索」不可省：
已经不被检索的旧条目不算「被当作 current 用」。

**另一半必须人工**：像「三个月前想买 A，现在没兴趣了，但从没说过」这种，
系统**没有证据**，**不许让模型自己猜「这条应该过时了」**，只能由用户/评测标注。

最终 `Stale Memory Rate` **两部分都报**：

| 部分              | 含义                                | 谁判 |
| ----------------- | ----------------------------------- | ---- |
| `stale_auto`      | 上式为真的比例                      | 自动 |
| `stale_annotated` | 用户/评测发现的、无自动证据的 stale | 人工 |

**不许把两部分合成一个数后声称「全自动」**。

**结论：Memory 四项里，Correction 现在可测（分母随 E1a 做实）；Stale 两部分分报（自动半 + 人工半）；
Recall 与 Wrong Injection 两项必须新增埋点。** 这是 E1 最大的实现成本，不能藏起来。

### 3.2 Goal

| 指标                              | 现有来源                                                                                                       | 判定                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| Goal Progress Accuracy            | ⚠️ G1b 的 `progress` 是**计算值**，但「准不准」需要**人工对照**真实完成情况                                    | 需人工标注，非纯自动 |
| Blocker Detection Accuracy        | ⚠️ G1a 有 `blocked_reason`、G1b 有 `watch/watch_reason`；但「该 blocked 却没 blocked」= 漏报，**无法自动发现** | 需人工对照           |
| Goal Abandonment / Pause Accuracy | ⚠️ 状态流转有 event 可查（`goal_events`），但「pause 得对不对」同样需人工判                                    | 需人工对照           |

**结论：Goal 组没有一项能纯自动算——都需要人工/用户对照。** 这正好印证原文第 4 节的第 2 条原则。

### 3.3 Agent

| 指标                        | 现有来源                                                                                                      | 判定                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Task Completion Rate        | ✅ `coding_tasks.status ∈ (queued, running, succeeded, failed, cancelled)`（`migrations.ts`）+ `todos.status` | **可自动测**                 |
| User Rework Rate            | ❌ 没有「用户返工」信号                                                                                       | **需新增埋点**（或人工标注） |
| Unauthorized Action Count   | ✅ 部分有：`audit_events` 记了大量 `kind`（`mcp.*`、`coding.landing_orphan` 等）                              | 需先定义「未授权」清单才能筛 |
| Failed Action Recovery Rate | ⚠️ `coding_tasks` 有 failed，`JobQueue` 有退避重试；但「最终恢复成功」需要**跨尝试关联**                      | 需补关联键                   |

### 3.4 Proactivity

| 指标                        | 现有来源                                                                           | 判定                                |
| --------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| Useful Proactive Actions    | ❌ 无（H1 还没实现）                                                               | **依赖 H1 落地 + 需人工判「有用」** |
| Unnecessary Interruptions   | ⚠️ H1 的 Quiet Policy 会产出 `skipped` 记录（草案 §2），但「打扰是否必要」要用户判 | 依赖 H1                             |
| Duplicate Reminders         | ✅ 可算：relay 的 `notify.sent` 键 + H1 的 `notifyKey`                             | **可自动测**（H1a 落地后）          |
| Missed Important Follow-ups | ❌ 「该提醒却没提醒」= 漏报，无法自动发现                                          | **需人工/用户反馈**                 |

### 3.5 Cost

| 指标                           | 现有来源                                                               | 判定                                            |
| ------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Model Calls                    | ⚠️ 无统一计数（`audit_events` 里散落，非专表）                         | 需统一埋点                                      |
| Tokens                         | ✅ relay 侧有 `inputTokens/outputTokens`（`relay/src/types.ts:55-56`） | **relay 内可测**；core 侧调用无此字段           |
| Paid Usage                     | ✅ relay 侧 `costUsd`（`types.ts:54`）                                 | 同上                                            |
| Background vs foreground usage | ❌ 无区分标记                                                          | **需新增埋点**（JobQueue/心跳触发 vs 用户触发） |

### 3.6 汇总（这张表是 E1 的实现路线图）

| 类别            | 现在就能自动测            | 需人工/用户对照 | 需新增埋点                                  |
| --------------- | ------------------------- | --------------- | ------------------------------------------- |
| Memory (4)      | 1（Correction）           | 0               | 2（Recall/Wrong Injection）+1 部分（Stale） |
| Goal (3)        | 0                         | 3               | 0                                           |
| Agent (4)       | 1（Completion）           | 2               | 1（Rework）                                 |
| Proactivity (4) | 1（Duplicate，待 H1a）    | 3               | 0（依赖 H1）                                |
| Cost (4)        | 2（relay 内 Tokens/Paid） | 0               | 2（Model Calls / Background-vs-foreground） |

**全自动可测仅 5/19，纯人工/用户判断 8/19，需新增埋点 6/19。**

## 4. 数据结构（草案，等 M1/G1 定稿后再定表）

评测**不该**新建一套「指标库」跟 business 表并行抢真值。原则：
**能从既有表算出的一律不落新表**；只有「必须留存的原话/人工判分」才落表。

- 建议最小新增（暂名，**交整合方定**）：
  - `eval_runs`：一次评测的窗口与结论（`id / started_at / ended_at / kind(real|synthetic) / north_star_met / notes`）；
  - `eval_annotations`：人工/用户判分（`run_id / subject_kind / subject_ref / metric / value / note / by / at`）；
  - 埋点侧（Recall/Wrong Injection/Model Calls/Background-vs-foreground）**尽量走 `audit_events` 的既有通道**，不为评测单独造一套事件流。
- **禁止**：把评测脚本算出来的数字直接写成产品状态（如「Goal 完成」）。评测只读。

## 5. 验收条件（草案，等整合方锁）

1. **真实与合成严格分离**：任何报告中真实 7 天数据与合成测试数字必须分表、分标题，不许合计；
2. **无真实数据时结论必须是「未评测」**，不许出现「通过」字样（可自动断言报告生成器）；
3. 每项指标在报告里必须带**来源标注**（哪张表/哪次人工判分）与**样本量**；
4. 分母为零时必须显式写 `N/A` 而非 `0%`（避免「0 次打扰」这种假好消息）；
5. 19 项指标逐项落位：**没有采集基础的必须在报告里标「未采集」**，不许静默省略；
6. 失败案例必须至少保留 3 条**原文级**记录（脱敏后），不能只留统计数字；
7. **North Star 必须是四个独立布尔字段**（`memory_continuity` / `goals_progressed_ge3` /
   `autonomous_completion_ge1` / `hard_quiet_violations_zero`），**禁止压成一个总分或百分比**；
   任一为 `FAIL`/`NOT EVALUATED` 时总判定不得为 `PASS`；
8. **`Hard Quiet Violation` 必须等于 0**，且四类情形分别可数（重复单发 / 越窗单发 /
   抑制后仍发 / 非真阻塞却 urgent）；
9. **软打扰与硬违规分列**：`Unnecessary Interruptions` 不得与 `Hard Quiet Violation` 合并成一个数；
10. **主观指标的最终 annotation 必须经用户 `confirm / reject / adjust`**；
    未经确认的只能标「预标待确认」，**不得作为最终结果**（可自动断言报告里存在该标记）；
11. **真实数据不进公开仓库**：仓库内只允许脱敏模板/schema/合成样例/匿名汇总；
    可自动断言：仓库内不存在 `<IXAEON_DATA>/eval/` 原始数据样本，且汇总报告不含对话原文。

## 6. 拆分、档位与依赖

| 支      | 内容                                                                                                                              | 档位                                          | 依赖                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------- |
| **E1a** | 埋点补齐（retrieval/injection 与 Correction 分母、Recall/Wrong Injection、Model Calls、Background-vs-foreground、任务跨尝试关联） | **B**（改数据采集 + 可能新表 = 迁移归整合方） | 无                              |
| **E1b** | 指标计算与报告生成（四项布尔 North Star、真实/合成分离、N/A 与样本量、未采集标注、软硬打扰分列）                                  | A                                             | E1a                             |
| **E1c** | 人工/用户判分入口（confirm/reject/adjust）与失败案例留存                                                                          | A（若外发则 B）                               | E1b                             |
| **E1d** | 真实 7 天运行（脚本 + 每日留痕 + 四类材料 + North Star 判定）                                                                     | A（跑真实数据，只读）                         | **G1 并入 + M1 定稿 + H1 落地** |

**排期现实**：E1d 是唯一能产出 North Star 结论的一支，但它依赖 G1/M1/H1 全部落地。
在此之前 E1 只能准备**采数与报告工具**，不能宣称评测。

## 7. 不做什么（防过度设计）

- 不做「实时打分面板」——7 天评测是**事后复盘**，不是运维监控；
- 不为 19 项指标各造一张表；
- 不把评测结果反写产品状态（评测只读）；
- 不用合成数据冒充 7 天结果（原文原则 4-1）；
- 不让模型自己判「这条记忆过时了」「我做得对不对」（见 3.1b 与 2a）；
- 不把 North Star 压成分数（见 1a）；
- 不在 E1 里顺手实现 H1 的心跳（那是 H1c）。

## 8. 口径状态：**已全部拍板**（统筹 2026-10-27）

| 原待定项             | 决定                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| Correction Rate 分母 | `corrections / memory-injected assistant turns`；无注入 = `N/A`（3.1a）     |
| Stale Memory 判定    | 自动可证（三条件同时成立）+ 人工标注，**两部分分报**（3.1b）                |
| 「明显无效打扰」阈值 | **Hard Quiet Violation = 0**，任何 1 次即第④项失败；软打扰单列（1b）        |
| 人工判分由谁做       | **用户本人是最终真值**，整合方/系统只预标；须 `confirm/reject/adjust`（2a） |
| 真实数据存放         | `<IXAEON_DATA>/eval/<run-id>/`，**绝不进公开 repo**（2b）                   |

**遗留但非阻塞**（实现时按最小惊讶原则，不需要再问）：

- 四类硬违规的判定代码放哪（H1 的 Quiet Policy 侧 vs 评测侧）——建议**复用 H1 的判定**，评测只读不改；
- 匿名汇总报告的粒度（是否到「每天一条」）——建议按周聚合，避免细粒度泄漏。

## 整合方审稿（2026-10-29）

**结论：通过（有条件），而且要提前做。** 评测只读、真实数据不进仓库、用户本人是最终真值、没跑真实 7 天就只能写「未开始评测」、North Star 四项分开判——这几条都对。E1a（埋点）和 E1b（报告）是后面 M1、H1 改得好不好的**尺子**，应排在 M1c、H1c 之前，先量出基线。

~~开工前必须补：第 5 节验收条件还是空的……~~ **更正（同日，用户指出）**：第 5 节已有 11 条验收条件，不是空的——整合方审稿时截取原文把范围停在了「## 5」标题行，没读到内容，写错了。已有的 11 条不重写。

开工前只补缺的三样：

1. **把 11 条落成具体测试的写法**：每条对应哪个测试文件、用什么合成数据、断言什么（比如第 2 条「无真实数据时结论必须是『未评测』」= 报告生成器在空的 `eval_runs` 上输出里没有「通过」字样）。
2. **E1a 埋点事件的结构**：落在 `audit_events` 的哪几个 `kind`、每种 `detail_json` 的字段和类型（Recall/Wrong Injection、Model Calls、Background-vs-foreground、Correction 分母、任务跨尝试关联）。
3. **迁移规格**：`eval_runs` / `eval_annotations` 的建表语句（列、类型、约束、索引），整合方据此写正式迁移；哪样只走 `audit_events`、不新建表，写明。

**North Star：用户 2026-10-29 正式批准双层验收**——L1 基础验收（连续聊三轮记得住、完成至少一项真实任务）照旧作为日常产品验收；L2 长期自主验收即本草案的 7 天四项，四项分别 PASS 才算 North Star PASS。AGENTS.md 与三周任务单已同步。E1a 提前采基线、E1b 提前准备报告；**E1d 必须等 G1、M1、H1 落地后才开始真实 7 天评测**。
