# 规格占位 M1e / X1：多设备调度 与 新增 Coding Executor

> dev2 按用户 2026-10-28 任务书**大块九、十**留档。**这两块现在是占位，不是可开发规格**——
> 任务书自己写了顺序与优先级，这里的工作是把「届时必须回答的问题」先钉住，防止将来顺手发明。

## M1e（大块九：多设备任务调度）

**开工前置（任务书原文）**：必须在 **D1 第一台真实设备稳定之后**。在此之前本文档不进入设计。

不做什么（原文照抄）：**一开始不做分布式大模型。** 第一阶段只做
Independent Task Distribution（FAEX1 跑 Research、NAS 建索引、Desktop 写代码、红魔跑本地模型评测，
结果全部回 Core）。

届时必须回答的七件事（任务书列的故障面，逐条要有真实故障注入测试，不许纸面勾选）：

| # | 问题 | 现在就能确定的约束 |
| --- | --- | --- |
| 1 | lease | 沿用 `door_task_leases` 形态（D1 §2），过期回收规则唯一入口 |
| 2 | timeout | 与 lease 分离：超时≠放弃，先查结果再决定重试 |
| 3 | duplicate | 复用 JobQueue 已验证的同 kind 去重思路，但**跨设备去重是新的** |
| 4 | disconnect | 断连时任务可能仍在跑——回读结果优先于重发 |
| 5 | retry | 有副作用任务的重试必须先证明「上一次没发生或已回滚」 |
| 6 | cancel | 取消传播到设备侧执行进程，取消失败要显式上报 |
| 7 | **idempotency** | **设备离线不得重复执行有副作用任务**（原文红线）——派发键必须含幂等 id，设备侧写入前查重 |

调度大脑在 **Core**，不在 Relay（原则 1）。

## X1（大块十：新增 Coding Executor）

**优先级（任务书原文）：低于前面所有主体能力。** 未来候选：Claude Code / Codex CLI / OpenCode /
其它 Agent Runtime——但注意**已排的 D8（队列 87 行，等用户）就是「执行器加 Claude Code」**，
X1 不重做它，D8 之后才轮到把其余 executor 接进同一契约。

Executor Contract 的权属红线（原则 4 + 任务书原文，写死）：

```text
Executor 不拥有：Goal / Memory / User Identity / Project Truth
——这些全部属于 IXAEON Core。
Executor 只是：接受一个明确范围任务 → 返回修改、结果、证据。
```

届时必须回答：契约版本化（executor 能力声明接 R1 Registry，`subject_kind` 可扩 `executor`）；
证据回传格式与现有 `coding_tasks` 验收链的映射；executor 崩溃/挂死的租约语义（与 M1e §1 同源，不两套实现）。

## 队列处理

两块在队列中登记为**占位行**（不可领、无档位、依赖写死为 D1 稳定 / D8 之后），
防止被「待领」扫描误取，也防止将来重复起草。
