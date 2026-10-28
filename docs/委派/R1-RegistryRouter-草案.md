# 规格草案 R1：Capability Registry & Model Router —— 建立在真实观测上

> dev2 按用户 2026-10-28 任务书**大块七**起草。**草案，不是生效规格；不写实现。**
> 顺序：… → C1 Core Service → **本块** → Door → 多设备 → 更多 Executor。

## 1. 要什么（原文 1 节）

**ModelPool 的失败原因是参数来自人工猜测。** 新系统必须建立在**真实观测**之上。

仓库证据（这条教训是实的）：`ModelPool` 已从生产代码**删净**（全仓只剩 `migrations.ts` 里的历史痕迹）；
AGENTS 明确记着「字段齐全，值是编的」。本草案的每一列都必须回答：**这个数字是谁、什么时候、怎么测出来的。**

## 2. 与已有资产的关系（不另起炉灶，三条衔接写死）

| 已有 | 关系 |
| --- | --- |
| **DS2 的 `ModelCapabilities`**（`packages/core/src/model/capabilities.ts`，待复审分支） | 它是**静态声明面**（provider 支持什么：native-schema/tool/seed/`maxContext`）；R1 Registry 是**观测面**（实测质量/延迟/成功率/健康）。两层必须可联查，**禁止互相冒充**：声明不等于测过 |
| **S1/GKD 的 `experiments` 表**（草案） | Registry 的 Tested 证据**同一张表**（`subject_kind` 扩一个 `model` 即可），**不建第三套观测台账** |
| `DeepSeek 蒸馏`的 lesson：能力声明替代 `if model ==` | Registry 是这条的完全体：名字永不参与选择，只有声明+观测参与 |

**`maxContext: null 不猜` 原则沿用**：没测过的字段就是 null/未测，**禁止用型号、文档、宣传页推断**
（原文 4 节与 E1 的 Observed facts only 同一条规矩）。

## 3. Registry 五组登记面（原文 2 节，逐项落来源）

| 组 | 字段 | 数据来源（实测现状） |
| --- | --- | --- |
| Identity | provider / model / **actualVersion** / endpoint / runtime | ⚠️ 现在只有 `modelName` 一个字符串（`provider.ts`）；`actualVersion` 需要真调 API 回读（`listUpstreamModels` 已有雏形，`openai.ts:282`） |
| Capability | chat/coding/review/planning/extraction/research/vision/tool use/long context | 静态声明（DS2）+ 每次实测结果；**组合键 (model, capability)**，不是 model 一列打天下 |
| Real Measurement | quality / latency / context success / tool success / structured success / failure rate | ❌ 全部无持久化。这是 R1 的主体工作量 |
| Resource | quota / concurrency / usage / cost / subscription limits | ⚠️ 零散：relay 有 `costUsd/inputTokens/outputTokens`；`scripts/real/quota-check.mjs` 存在；无统一存储 |
| Health | available / degraded / unavailable / rate_limited | ❌ 无 |
| **Last Verified** | 每个能力必须有最后测试时间 | ❌ 无——**没有它，上面全是过期传闻** |

## 4. Router 选择顺序（原文 3 节，落成硬过滤）

```text
硬过滤（顺序不可换，任何一项不过直接淘汰，不进比较）：
  1. Privacy        —— 该类数据允许出这台机器吗？允许发给这个 provider 吗？
  2. Authorization  —— 用户为这次用途授权了这个模型/端点吗？
  3. Capability     —— 声明支持且未过期（Last Verified 在窗口内）

软排序（在幸存者里比）：
  4. Quality  5. Reliability  6. Latency  7. Cost  8. Remaining quota
```

**原文红线照抄进验收：不能因为便宜就绕过隐私规则。**
排序字典序实现：第 1~3 步是过滤器不是权重；任何「综合分」只能在幸存者内部算。

## 5. Learning（原文 4 节）——防「一次失败大幅改分」

- 每次执行后记结果（观测管道）；连续失败 → 该 (model, capability) 可靠性下滑；
- **必须有平滑与置信门槛**：样本少时向先验收缩，禁止单条失败把分打穿；
  具体曲线/阈值留整合方定（数字是校准题，不是我现在发明的题）；
- 健康态（degraded/unavailable/rate_limited）来自**短窗口观测**，与长期 reliability 分开——
  否则一次网络抖动会污染长期评分；
- **降级留痕**：为什么从 A 换到 B，必须可事后查询（见 §6 可解释性）。

## 6. 验收（原文 5 节，逐条）

1. 同一评测集分别跑：本地模型 / DeepSeek / Claude·Codex → Registry 落**真实结果**（非合成，跑前登记环境）；
2. Router 能回答：**「这次为什么用了 DeepSeek 而没有用 Claude」**——
   输出必须是决策轨迹：每层过滤淘汰了谁、因为哪条硬规则、幸存者按哪几个数排序。
   **这题答不出来 = R1 未完成**，哪怕选得对；
3. 把某模型 `last_verified` 置为过期 → 它必须从可选集消失（不是降权，是淘汰）；
4. 隐私过滤优先级实验：便宜但隐私不过的候选**永不被选**（负向断言）；
5. 平滑性：注入 1 条失败，评分变动必须小于声明的阈值；注入连续 N 条，按曲线下降（可测）。

## 7. 拆分、档位与依赖

| 支 | 内容 | 档位 | 依赖 |
| --- | --- | --- | --- |
| R1a | Registry schema（identity/capability/measurement/resource/health/last_verified） | **B**（新表+迁移=整合方；涉及成本数据） | C1b |
| R1b | 观测管道：每次模型调用落结果（复用 `experiments`，`subject_kind` 扩 `model`） | **B**（新的数据落库含义） | R1a、E1a 埋点 |
| R1c | 隐私/授权硬过滤层（含隐私规则的单一事实源，与 settings 现有 `personal_memory_to_chat` 衔接） | **B**（权限与隐私） | R1a |
| R1d | 软排序 + 决策轨迹可解释输出 | A | R1b、R1c |
| R1e | Learning 平滑曲线与校准 | B（改记忆/评分含义） | R1b、真实观测积累 |

## 8. 待统筹拍板

1. 三台评测对象（本地/DeepSeek/Claude·Codex）的评测集与判分口径（建议直接复用 E1b 的用例级判定）；
2. Learning 曲线的形态与最小样本量；
3. `actualVersion` 的获取频率（每次启动 vs 每窗口一次）；
4. Router 是否有权在任务中途换模型（我建议：仅失败后、且留痕，不允许静默热切换）。
