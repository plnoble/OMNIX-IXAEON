# 规格草案 H1：Heartbeat 与 Quiet Policy —— 主动思考循环，主动而不打扰（v3 · 转正式规格准备状态）

> **仍是草案，不是生效规格。** dev2 按用户 2026-10-26 任务书大块三起草。
> v2 合入用户补齐的第 1–3 节原文（目的、输入、输出）；附录 A 合入宿主与调度决策；
> **v3 合入统筹 2026-10-27 第二轮拍板：建议门控、窗口不绑飞书、第一版默认参数**。
> open 项已全部转为已定案，**只剩 §6b/§6c 两个细节与一项排期依赖**。
> **本轮不写实现**（统筹 §16-⑩ 未完、§6c 未定），队列 97~100 行仍为「草案待审（整合方）」，不可领。
> 依赖：G1（Goal/Plan/Step，在整合方手里）。

## 1. 要什么（用户原文 1–3 节）

**目的（原文 1）**：IXAEON 现在只在用户问或任务系统触发时才工作。加一个**轻量的主动思考循环**——
目标不是「让 Agent 一直调用模型」，而是**定期观察当前状态，判断有没有值得采取的行动**。

**输入（原文 2，写死为固定结构化摘要，禁止每轮重塞整个历史上下文）**，每轮 Heartbeat 只读：

1. active Goals；2. blocked Goals；3. Todo；4. Running Tasks；5. Failed Tasks；
2. Research discoveries；7. 最近用户决定；8. 最近项目变化；9. 下次复查时间；10. 资源/额度状态。

**输出（原文 3，动作白名单封闭枚举，默认倾向 NO_ACTION）**：

```
NO_ACTION | CONTINUE_TASK | RESEARCH | CREATE_SUGGESTION |
CREATE_TODO | REQUEST_USER_DECISION | REPLAN | WAIT
```

- 白名单外的动作**一律拒绝写入**（代码层拦，不是提示词祈祷）；
- 每种动作映射到已有机制，**不发明新执行路径**：
  | 动作                  | 映射到                                                                     |
  | --------------------- | -------------------------------------------------------------------------- |
  | CONTINUE_TASK         | 重排已有 coding task / research topic（现有状态机）                        |
  | RESEARCH              | research_topics 排队（现有 interval/next_check）                           |
  | CREATE_SUGGESTION     | 一条建议记忆（`origin='ai'`、`confirmation='none'`——**永远不是用户决定**） |
  | CREATE_TODO           | `TodoStore.propose`（等你拍板，拒绝过的同一件事不再提）                    |
  | REQUEST_USER_DECISION | 按 Quiet Policy 分级：阻塞级单发、其余进窗口                               |
  | REPLAN                | G1c `PlanStore.addVersion`（历史保留；不改 Goal 状态、不激活 proposed）    |
  | WAIT                  | 写 `next_review_at`，本轮到此为止                                          |
  | NO_ACTION             | 只记审计行                                                                 |
- **主动 ≠ 高频打扰**：默认 NO_ACTION；验收里要有「无事可做的一轮 = 0 次模型调用之外的副作用」。

## 1a. 现状核对（写草案前查过的事实）

- relay 侧已有打扰控制的底子（L15 实现于 main）：
  - `RelayState.notify.sent: Record<string, string>`（`packages/relay/src/types.ts` L64）——通知去重表；
  - `idleDay`（同文件 L72）：**「没活」一天一次**的按北京时间日期去重，就是 Quiet Policy 的第 1 条精神；
  - 早报 `morningReport`（北京时间 9 点后一次）、`daily` 事件已有；
  - `formatEvent` 已有事件 → 一条消息的收口。
- ✅ **L11 的合并缺陷已在分支修好（2026-10-27，统筹 §14 要求）**：问题代码在 `dev2/L11` 的
  `Object.assign(notifyStore(s), notifyStore(state))`——整张 `sent` 表被后写者**替换**而不是按 key 合并，
  双道下另一道的去重记录会丢，而 Quiet Policy 全靠这张表可靠。
  已改为 `mergeNotifyInto` 逐键并集 + 新测试 `l11-notify-merge`（5 条，未 lock），
  **负向实测：换回旧写法 4/5 红**；分支 CI 全绿（run 40447697441）。等整合方复审合并，见队列 79 行。
- 桌面端有 JobQueue（退避重试）、`research_topics`（interval_ms/next_check_at/enabled/paused）——
  「继续研究」的执行底子已有，缺的是「由 Goal 的当前步骤触发、结果回写、要不要说」这条链。

## 2. Quiet Policy（用户已写死的第 4 节，落成契约）

1. **同日不重提醒**：每条打扰带 `notifyKey`（事项 id + 事由的稳定哈希）；`sent[notifyKey] = 北京日期`，
   同 key 当日再触发只记日志不发送。`sent` 表按 key 合并（修 L11 缺陷后），**不同 key 互不覆盖**。
2. **窗口合并**：打扰分级 `urgent | routine | digest`：
   - `urgent` = **真正阻塞 Goal**（目标 `status→blocked` 需人拍板、批准过期、额度耗尽停摆）→ 立即可发；
   - `routine`/`digest` → 不发单条，攒进既有窗口：**morning report（9 点）、晚摘（新增 evening summary）、
     周审（新增 weekly review，可先只留数据不做界面）**。同一窗口内同 key 也只出现一次；
   - 分级判断写死为代码规则（阻塞类=urgent），**不由模型自由裁量**——模型可以建议级别，
     最终级别由「是否阻塞 + 是否需用户动作」的判断函数定。
3. **只有真正阻塞 Goal 的事项才单独通知**：判据 = 该事项使某个 `active` 目标无法继续，且解除需要用户动作。
   「有进展」「跑完一棒」「研究出了中间结果」**都不是**单独通知的理由，一律进窗口。
4. 频控兜底：单日报出条数上限（数值待定，TODO 真实校准）；到限后除 urgent 全部并入窗口。

## 3. 验收场景（用户原文第 5 节，逐条可测）

场景：用户建 Goal「研究是否需要给 IXAEON 增加 NAS 节点」后 **48 小时不说话**。IXAEON 应：

5. Heartbeat 自动发现该 Goal 的 Research Task 未完成 → 重新排队继续研究（用现有 topic 的
   interval/next_check 机制，**不新造调度器**）；
6. 每轮研究结果落库（findings + 记忆照现有抽取链），Goal 进度/当前步骤随真实任务状态更新（复用 G1b）；
7. 中间轮次判断「暂时不需要打扰」：跑完的 heartbeat 发 0 条即时通知（断言 sent 与外发调用计数）；
8. 攒到足够结论（阈值规则待定，占位：≥N 条相互印证的 finding 或 topic 达成目标问题）→
   形成**一条**建议（consolidated 记忆 + urgent=false）；
9. 在下一个合适汇报窗口（早/晚摘）通知这一条建议；
10. **全程消息总量有界**：48 小时里除窗口消息外 0 条单发（这就是「不能每个 Heartbeat 都发消息」的可测形式）。

补充反例测试：同一天 heartbeat 重复触发同一建议 → 只出现一次；用户中途回来说「先不用管」→
该 notifyKey 进抑制名单，窗口里也不再出现。

**按原文 2/3 节新增的三条硬验收**：

11. 输入封套有界：一轮心跳发给模型的文本 = 第 1 节那 10 项结构化摘要拼出来，
    长度有上限（数值待校准，先定死一个保守 cap）；**不得出现整段历史对话原文**
    （替身模型断言收到的文本）；
12. 动作白名单封闭：模型返回白名单外的动作（如 DELETE_ITEM、NOTIFY_NOW）→ 该轮记
    `NO_ACTION` + 审计「越界动作被拒」，**不执行、不重试说服**；连续越界 → 心跳自我降频并进周审报告；
13. 默认倾向可测：构造「一切正常、无新信息」的一轮 → 输出必须是 NO_ACTION 或 WAIT，
    且副作用为零（不建 todo、不发通知、不动任务状态）。

## 4. 数据结构（草案）

- `RelayState.notify` 扩（或桌面 job_state 侧新增，归属待定）：
  `{ sent: Record<key,date>, digest: Array<{key,level,title,body_md,queued_at}>, suppressed: string[] }`
- 新表（桌面核心侧，若心跳住核心）`heartbeats`：一次心跳一行——醒来时间、**去重三元组
  （`snapshot_fingerprint` + `wake_reason` + `due_window`/`review_epoch`，见附录 A.2）**、
  **模型返回的动作（白名单枚举）**、映射后实际做了什么、产出、打扰决定与级别、
  越界拒绝标记、**额度不可用的 `skipped/quota_unavailable` + `next_retry_at`**
  ——**这是「主动行为要可审计」的落点，也是 weekly review 的数据**。

## 5. 拆分、档位与依赖

| 单      | 内容                                                                                    | 档位                             | 依赖              |
| ------- | --------------------------------------------------------------------------------------- | -------------------------------- | ----------------- |
| **H1a** | notifyKey/同日去重工具 + `sent` 按 key 合并规范（L11 的缺陷由复审顺手改，不单开）       | A                                | 无                |
| **H1b** | Quiet Policy：分级、窗口合并、上限、抑制名单 + heartbeats 表                            | B（改变通知含义/新外发节奏）     | H1a               |
| **H1c** | Heartbeat 核心循环：10 项输入封套 + 8 动作白名单映射 + 默认 NO_ACTION + heartbeats 审计 | B（自主行为边界 + 新提示词外发） | H1a、G1b/G1c 并入 |
| **H1d** | evening summary / weekly review 窗口 + 48 小时场景的真机脚本                            | A/B 看是否新增外发文案           | H1b、H1c          |

## 6. 问题状态（2026-10-27 统筹任务书 §13 同步后更新）

### 已由统筹定案（不再是 open，实现照此，不再重议）

1. **宿主 = 方案③**：`HeartbeatRunner` 住 `packages/core`，宿主无关；结构
   `buildSnapshot / decide / executeAllowedAction / quietPolicy / recordRun`；
   Scheduler 由 adapter 提供，**第一阶段 = Desktop JobQueue adapter**，未来 IXAEON Core Service 换 adapter；
   **Relay 不作正式宿主**，继续只承担 Coding 流水线 + 现有通知出口（统筹 §13.1）。
2. **Tick 与 Reasoning 两层必须保留**；Tick 零模型调用、可降频、**额度不足只挡 Reasoning 不停 Tick**
   （记 `skipped/quota_unavailable` + `next_retry_at`，恢复自醒，不得失去自主唤醒能力）（§13.2 / 附录 A.2）。
3. **去重三元组**：`snapshot_fingerprint + wake_reason + due_window/review_epoch`；
   新窗口即使快照没变也允许再醒一次（§13.3 / 附录 A.2）。
4. **数值口径**：默认 Tick interval、退避档位、每日 Reasoning 上限、due window 宽度——
   统筹 §13.4 定为**可配置默认值，不得成为不可修改的业务契约**（与本草案 A.3 一致；
   验收一律注入合成时钟，不钉分钟数）。
5. **前置依赖已解除一半**：L11 的 `sent` 整表替换缺陷（Quiet Policy 的地基）已在 `dev2/L11` `085a260`
   修成逐键合并 + 5 条回归（负向实测旧写法 4/5 红），等整合方复审合并。

### 已定案（统筹 2026-10-27 第二轮拍板，由 open 转入）

5. **「足够结论」= 代码门控 + 模型只写建议文字**：满足**任一**即允许 `CREATE_SUGGESTION`，
   判定在代码里，**模型不许自评「证据够了」**：
   (a) Research Topic 的目标问题已被明确回答；或
   (b) **≥2 个独立来源相互印证，且不存在 unresolved conflict**。
   未过门控 → 继续 `RESEARCH` 或 `WAIT`，不发建议。门控过后模型仅负责生成措辞。
   验收形态：来源不足 / 有未解冲突 / 模型自称够了但门控不过 → 三种都断言 `CREATE_SUGGESTION` 不产生。
6. **窗口不绑飞书**：morning / evening / weekly **先在 core 内形成摘要事件**；用户启用远程通知时
   再统一交给**现有** Feishu Notifier Adapter 投递。硬要求：**飞书不可用或未启用，
   既不能阻止本地摘要形成，也不能丢通知数据。**
7. **第一版默认参数**（只是默认配置，**不得写成不可修改的业务契约**）：
   Tick 10 分钟；quota unavailable 退避 30 分钟；连续超 6 小时升为 60 分钟；
   Reasoning 上限 12 次/北京日；输入封套 cap 12,000 字符。
   验收一律经参数注入 + 合成时钟，**不得依赖具体分钟数或 cap**——改校准不该红测试。

### 仍 open 的只剩排期与两个细节（不是设计缺口）

- **排期**：H1c 的 `REPLAN` / `CONTINUE_TASK` 要等 **G1b/G1c 并入 main**
  （实测 `migrations.ts` 无 `goal_plans`/`goal_links`）。在此之前
  Tick/Reasoning 骨架、Quiet Policy、建议门控均可先行。
- 细节见 §6b/§6c。

## 6b. 第 6 条的真实成本（本轮实测，别当零成本）

写规格前查过代码，两个硬事实：

1. **core 侧没有任何通知/摘要存储**。只有
   `audit_events(id, kind, detail_json, created_at)`（`packages/core/src/db/migrations.ts`）——
   它是**留痕**，不是待投递队列（没有 delivered/失败状态，删除与保留语义也不同）。
2. 飞书出口整个在 relay 侧：`createNotifier(target: FeishuTarget | null, store, opts)`
   （`packages/relay/src/notify/feishu.ts:168`），**target 为 null 时直接返回 `{ok:true, sent:false}`**
   —— 不投递、**也不留存**。这正是第 6 条要禁止的「丢通知数据」。

结论：

- 第 6 条需要 **core 侧新增一张通知/摘要事件表**（暂名 `notification_events`），
  字段至少能表达 `kind(morning|evening|weekly|urgent|digest-item) / 目标窗口 / 标题 / 正文 /
级别 / notifyKey(去重三元组) / created_at / delivered_at(可空) / delivery_error(可空)`；
  语义 = **写入即成功**，远端投递失败只写 `delivery_error`，不删记录、不阻塞心跳；
  投递侧消费 `delivered_at IS NULL`，投成功才盖章。
- **这等于新增数据库迁移 → 整合方关卡**，执行方不自写（AGENTS「迁移文件只由整合方编写」）。
- 与 §7 第一条「不新造通知通道」**不矛盾**，需在正式规格里把话说明白：
  不新造的是**外部投递通道**（继续复用 relay 的飞书 adapter）；
  新增的是**本地待投递存储**，否则第 6 条的「不丢」根本无处可存。
- relay 的 `notify.sent` 继续管**飞书限频**（流水线自己的事），新表管**内容不丢**，
  职责不同，**不要合成一张表**。

## 6c. 正式开工前仍需统筹定的两件小事

1. **`unresolved conflict` 由谁判、记在哪**：实测 core 的 `items.state='disputed'` 属 M1 记忆层、
   `gkd_pattern_conflicts` 属 GKD 层，**都不等于「本轮研究结论互相矛盾」**。我不发明字段。
2. **`notification_events` 与 `audit_events` 的分工**：我倾向新表（理由见 §6b），但由整合方定；
   若复用 `audit_events` 需先给它加投递状态列，那是改已有表，更需整合方判。

两件都不影响已定架构，但**不写清不能开工**——否则实现里必然出现临场发明的语义。

## 7. 约束

- **不新造外部投递通道**：远端通知继续复用 relay 现成的飞书 adapter；
  但「窗口不绑飞书」（§6 第 6 条）要求本地先落摘要事件，**这需要 core 侧新增一张表 = 数据库迁移**
  （见 §6b，迁移由整合方编写，执行方不自写）。两条不冲突：新增的是**存储**，不是**通道**。
- 不新造调度器：Scheduler 由 adapter 提供（第一阶段 Desktop JobQueue）；研究的重排复用
  `research_topics` 的 interval/next_check，**不新造 Research Scheduler**；
- 打扰级别不许模型直接定；「证据够了」也不许模型自己判（§6 第 5 条是代码门控）；
- heartbeats 审计与周报数据不进公开仓库真实内容（合成数据测试）；
- 默认参数（§6 第 7 条）是配置不是契约，验收不得依赖具体分钟数或 cap。

## 附录 A：Heartbeat 宿主与调度决策（2026-10-26 应用户要求补，纯比较、非定稿）

### A.0 事实底（写对比前在 main 上核过的）

| 事实                                                                                                                | 位置                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| JobQueue 类本体在 **packages/core**（含退避重试 `retryBackoffMs`），不属于桌面                                      | `packages/core/src/jobs/jobQueue.ts:39`              |
| 桌面已有「`setInterval` 驱动核心轮询」的先例（研究定时器）                                                          | `apps/desktop/src/main/appRuntime.ts:2661`           |
| 飞书通知出口（早报/日摘/回复收听）**全在 relay 侧**；桌面没有自己的外发通道                                         | `packages/relay/src/notify/`（webhook 出现在 relay） |
| 心跳要读的 10 项里，Goals/Todo/Tasks/Research 在**核心 SQLite**；额度/资源状态目前只有 **relay 的 RelayState** 里有 | `packages/relay/src/types.ts`                        |

### A.1 三案对比

**① Relay 宿主**：看门人每轮 `once` 后顺带跑心跳。

| 利                                                                                      | 弊                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 额度/资源状态天然在手（quotaPause、idleDay）；飞书出口现成（morning report 就是它发的） | 心跳语义 = 调度器队列（给角色发任务书），**桌面 Goal/Todo 数据要跨进程读**；relay 的活是「流水线推进」，把「主体思考」塞进去，两件事的暂停/恢复/崩溃语义互相污染（额度停摆=relay 停=心跳也停）；依赖 L18（未并入）、L17 额度兜底；**未来 Core Service 化时要搬家**，改动 = 推倒重来 |

**② Desktop JobQueue 宿主**：注册 job kind `heartbeat`，桌面定时器驱动。

| 利                                                                                                                                                        | 弊                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 读 10 项输入全在同一进程同一库（Goals/Todo/Tasks/Research 都是核心的）；研究定时器已有同类先例（L2661）；应用开着就有心跳，符合「桌面在→IXAEON 在」的现状 | **通知出口在 relay 侧**，心跳要「 REQUEST_USER_DECISION」得跨进程反向送达（桌面→relay 数据目录文件或 IPC 均未设计）；**桌面一关就全停**，与「24×7 自主」的方向相反；心跳逻辑从此长在 appRuntime 的巨类里，Core Service 化时**从桌面里剜出来**，同样搬家 |

**③（推荐）宿主无关 `HeartbeatRunner` + `Scheduler Adapter`**：

```
packages/core/src/heartbeat/
  runner.ts     HeartbeatRunner：组 10 项封套 → 判 due → 调模型 → 8 动作白名单映射 → heartbeats 审计
  ports.ts      端口：Clock / EnvelopeSource(核心库) / QuotaSource / Notifier(打扰出口) / Reasoner(模型)
  adapter.ts    SchedulerAdapter 接口：wake(tick) —— 谁叫它、多久叫一次，Runner 不关心
```

第一阶段只交付一个 adapter：**Desktop JobQueue adapter**（复用 jobQueue 的退避/审计/暂停语义，不新造调度器）；
`Notifier` 端口第一阶段接「写进 relay 数据目录的 digest 队列文件」或直接把打扰事件交给 relay 现成通道——
**具体接线在 H1b 里定，Runner 不感知**。未来 IXAEON Core Service（任务书大块六）接管时，
换成 Core Service 的 timer adapter，**Runner 与验收测试一个字不动**。

| 利                                                                                                                                                                                                                                 | 弊                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①② 的搬家成本都没了：宿主换=换 adapter，心跳逻辑/审计/验收全稳定；**测试不需要起桌面或 relay**（端口全可替身，符合「合成数据可测」）；额度状态、打扰出口做成端口，天然解决②的反向送达问题；Core Service 是方向，端口化就是为它铺路 | 多一层抽象；adapter 边界（谁能 wake、并发怎么防）要整合方定；**打扰出口端口的第一阶段实现仍要碰 relay**（写它的收件目录或新约定）——这条不藏：H1b 必须单独评这一块 |

### A.2 调度分两层：Scheduler Tick ≠ Heartbeat Reasoning（用户 10-26 定，同日第二轮修正）

| 层                      | 频率与成本                         | 内容                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scheduler Tick**      | 可配置、**零模型调用**（纯本地读） | 到点了只查六样「有没有 due/变化」：active/blocked Goals 到 `next_review_at`、failed/running task 变化、research due（复用 `research_topics` 的 interval/next_check，**不新造 Research Scheduler**）、digest 窗口到点、资源/额度状态**变化本身**。**没有 due → 什么都不做** |
| **Heartbeat Reasoning** | 只有 Tick 判出 due/变化事件才进入  | 组 10 项封套 → 模型判断 → 8 动作白名单 → 审计                                                                                                                                                                                                                              |

**硬规矩（写进未来验收）**：

1. 禁止每个 Tick 都调模型——`heartbeats` 表要能统计「Tick 次数 vs Reasoning 次数」，后者≤前者，且比例是周审指标之一；
2. **去重按三元组，不按裸指纹**（用户 10-26 修正：只比 snapshot hash 会把「review 到期了但内容没变」这类**本来就该醒**的场景错误压掉）：
   契约——**只有「相同 `snapshot_fingerprint` + 相同 `wake_reason` + 同一 `due_window`/`review_epoch`」才允许去重**；
   进入新的 review window / digest window 时，**即使快照内容一字不差，也允许重新触发一次 Reasoning**；
3. **额度不足不停 Tick**（用户 10-26 修正，推翻旧稿「额度没了连醒都不醒」）：
   - Tick 零模型调用、成本是纯本地读，**模型/额度不可用只允许挡 Reasoning**；
   - Tick 发现了该 Reasoning 的 due 但模型不可用：**不调模型** → 记 `skipped/quota_unavailable` → 写 `next_retry_at` → 允许退避/降频；
   - 额度恢复后，下一次 Tick 依 due 自行重新唤醒，**不需要任何人工动作**；
   - 额度长期不足时允许把 Tick 降到较低频率（数值待定，见 A.3），但**不允许彻底失去自主唤醒能力**——
     「彻底停掉 Tick」在任何额度状态下都不是合法实现。

### A.3 默认周期：**统筹待定参数，本草案不拍死数字**

Tick 间隔、额度不足时的降频档、每日 Reasoning 上限、due 判定的时间窗——全部列为**统筹复审时的待定参数**（TODO 校准）。
开发测试一律注入合成时钟（照 `IXAEON_RELAY_NOW` / `runCheck` 注入的既有模式），
**任何验收不得把具体分钟数钉成契约**——数值改校准不该红测试。

### A.4 推荐结论（给统筹签字用）

**采第③案**：`HeartbeatRunner` 住 `packages/core`，宿主无关；第一阶段 Scheduler Adapter = Desktop JobQueue；
**Relay 不作为 Heartbeat 的正式宿主**（只继续当打扰出口与流水线调度器）；未来 IXAEON Core Service 接管时换 adapter。
若统筹否掉③，退路顺序：② > ①（① 与「主体层不属于 relay」的任务书方向冲突最明显）。
