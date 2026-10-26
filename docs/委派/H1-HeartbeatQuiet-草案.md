# 规格草案 H1：Heartbeat 与 Quiet Policy —— 主动思考循环，主动而不打扰（v2 草案）

> **这是草案，不是生效规格。** dev2 按用户 2026-10-26 任务书大块三起草；
> v2 已合入用户补齐的第 1–3 节原文（目的、输入、输出）。仍未进队列，等整合方定稿。
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
- ⚠️ **前置：`dev2/L11`（待复审分支）里的合并缺陷**——已核实 main 上现在只有 `notifyStore(state)` 的读取，
  问题代码在 `dev2/L11`：合并用 `Object.assign(notifyStore(s), notifyStore(state))`，整张 `sent` 表被后写者
  **替换**而不是按 key 合并，双道下另一道的去重记录会丢。Quiet Policy 全靠这张表可靠，
  **该缺陷要在 L11 复审时改掉**（已补进周四复审清单 L11 一节），不必另开修复单。
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

## 6. 还 open 的问题（原文 1–3 节已答的不重开：行为白名单已定 8 种；「住哪/周期」原文仍未给）

1. **Heartbeat 住哪**（relay 看门人里，还是桌面 JobQueue？）与**周期**——原文 1 说「定期」但没给宿主和间隔；
   若住 relay，L18（自重启）尚未并入，形态要等它。**→ 2026-10-26 已补《附录 A：宿主与调度决策》，推荐第③案（Runner 宿主无关 + adapter），周期拆成 Tick/Reasoning 两层、数值留统筹定**；
2. 「足够结论」的阈值与「建议」的生成者（模型 or 模板）；
3. evening/weekly 窗口是否也走飞书（L16 通道），还是只在本机；
4. 频控上限、输入封套长度 cap 的数值（先保守常量，真实校准后调）。

## 7. 约束

- 不新造调度器/通知通道；全部复用 relay notify / JobQueue / research_topics；
- 打扰级别不许模型直接定；
- heartbeats 审计与周报数据不进公开仓库真实内容（合成数据测试）。

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
