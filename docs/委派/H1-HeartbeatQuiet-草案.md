# 规格草案 H1：Heartbeat 与 Quiet Policy —— 主动而不打扰（v1 草案）

> **这是草案，不是生效规格。** dev2 按用户 2026-10-26 任务书大块二的补页起草。
> **注意：用户这次只发了大块三的第 4、5 节（Quiet Policy、验收场景）。第 1–3 节
> （Heartbeat 的目的、触发器种类、行为边界）没收到，本草案相应小节是 dev2 按验收场景倒推的
> 占位设计，必须拿到原文后补全/修正，不能照占位开工。**
>
> 未进队列。依赖：G1（Goal/Plan/Step，在整合方手里）。

## 1. 要什么（占位，等原文 1–3 节）

IXAEON 要能在用户不说话的时候自己推进工作（Heartbeat 周期醒来：看目标、看方案步骤、看未完成的
Research/Coding 任务，能做的做掉、结果存好），但**打扰必须有闸**：
同一件事一天最多提醒一次；非紧急的并入固定汇报窗口；只有真正卡住目标的才单独发。

## 2. 现状核对（写草案前查过的事实）

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

## 3. Quiet Policy（用户已写死的第 4 节，落成契约）

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

## 4. 验收场景（用户原文第 5 节，逐条可测）

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

## 5. 数据结构（草案）

- `RelayState.notify` 扩（或桌面 job_state 侧新增，归属待定）：
  `{ sent: Record<key,date>, digest: Array<{key,level,title,body_md,queued_at}>, suppressed: string[] }`
- 新表（桌面核心侧，若心跳住核心）`heartbeats`：一次心跳一行（醒来时间、看了哪些 goal/step、
  做了什么、产出、打扰决定与级别）——**这是「主动行为要可审计」的落点，也是 weekly review 的数据**。

## 6. 拆分、档位与依赖

| 单      | 内容                                                                              | 档位                         | 依赖              |
| ------- | --------------------------------------------------------------------------------- | ---------------------------- | ----------------- |
| **H1a** | notifyKey/同日去重工具 + `sent` 按 key 合并规范（L11 的缺陷由复审顺手改，不单开） | A                            | 无                |
| **H1b** | Quiet Policy：分级、窗口合并、上限、抑制名单 + heartbeats 表                      | B（改变通知含义/新外发节奏） | H1a               |
| **H1c** | Heartbeat 核心循环（发现未完成→重排研究→落结果；复用 G1b 跟踪）                   | B（自主行为边界）            | H1a、G1b/G1c 并入 |
| **H1d** | evening summary / weekly review 窗口 + 48 小时场景的真机脚本                      | A/B 看是否新增外发文案       | H1b、H1c          |

## 7. 必须先回答的问题（不动手等拍板）

1. **原文第 1–3 节**：Heartbeat 住哪（relay 看门人里，还是桌面 JobQueue？）、周期、行为白名单——占位可能全错；
2. L18（relay 自重启）尚未并入，H1c 若住 relay 要看它落地后的形态；
3. 「足够结论」的阈值与「建议」的生成者（模型 or 模板）；
4. evening/weekly 窗口是否也走飞书（L16 那条通道），还是只在本机；
5. 频控上限数值。

## 8. 约束

- 不新造调度器/通知通道；全部复用 relay notify / JobQueue / research_topics；
- 打扰级别不许模型直接定；
- heartbeats 审计与周报数据不进公开仓库真实内容（合成数据测试）。
