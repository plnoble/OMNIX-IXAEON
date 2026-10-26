# Adoption Matrix（DeepSeek 能力 → ixaeon）

> 依据 `ixaeon-gap-analysis.md` 逐条判定。决策词：**ADOPT / ADAPT / REFERENCE / DEFER / REJECT**（见任务书 §3）。
> 任务书 §24 给的初始假设表**只作参考**，本表按源码证据修正。

## 主表

| DeepSeek 能力                                | 解决的问题                           | ixaeon 是否有同类问题               | 决策                              | 优先级                 | 证据（外部 → 我们）                                                                                      |
| -------------------------------------------- | ------------------------------------ | ----------------------------------- | --------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| **Conversation IR**（core 与协议隔离）       | API 格式不该直接进模型后端           | **是**（无 IR，换 provider 改业务） | **ADAPT**                         | **P0**                 | recipe `core/conversation.rs`、`protocol/*/convert.rs` → 我们 `provider.ts:7-21` 只有 system/user 字符串 |
| **Conversation IR + 工具 IR**                | 工具轮次需要结构承载                 | **是**（无 tool IR）                | **DEFER**（IR 位置预留，先不做）  | P2                     | recipe `messages.rs:44-58` `Tool{tool_call_id}` → 我们无                                                 |
| **reasoning 状态（ET\_ 标记）**              | 区分「无推理」vs「漏传」导致请求失败 | **是**（真实踩过）                  | **ADAPT**                         | **P0**                 | recipe `reasoning_content.rs:1-70`、`tool_call_id.rs:1-40` → 任务书 §9 那条 `must be passed back`        |
| **结构化输出（grammar 强制）**               | 机器间通信不能靠祈祷                 | **是，但已有 zod 校验版**           | **ADAPT**（补能力分层，不重做）   | **P1**                 | DeepInfer `structure_output/`（xgrammar）→ 我们 `provider.ts:13-18` zod safeParse                        |
| **xgrammar 缓存上限 + kill switch**          | 无界缓存 OOM（CVE-2025-32381）       | **是**（任何按 schema 缓存）        | **ADOPT**（工程规矩）             | **P1**                 | `structure_output/compiler.py:15-33` → 我们暂无此类缓存，先立规矩                                        |
| **Deterministic sampling（seq_seed）**       | 同输入同输出                         | **是**（验收/benchmark 不可复现）   | **ADOPT**                         | **P0**                 | DeepInfer README + `sampling_params.py` → 我们 `provider.ts` 无 seed                                     |
| **Batch-invariant inference**                | 批组成影响结果 → 评测不可信          | **是**（同问不同并发结果漂移）      | **ADAPT**（思想：确定性评测口径） | **P1**                 | `tests/models/test_batch_invariant.py` → 我们的评测口径                                                  |
| **两阶段调度（Prefill/Decode）**             | 重/轻工作混跑互相拖累                | **部分**（JobQueue 无分级）         | **REFERENCE**                     | P2                     | `csrc/engine/scheduler.hpp:36-47`                                                                        |
| **异步调度（CPU/设备重叠）**                 | 调度与执行串行导致空转               | **部分**（无明确重叠设计）          | **REFERENCE**                     | P2                     | README + `scheduler.hpp:56`                                                                              |
| **DSpark（draft+confidence verify）**        | 用便宜预算换吞吐                     | **否**（token 级无需求）            | **REJECT**（token 级）            | —                      | `models/mtp/dflash.py`、`mtp_varlen.hpp`                                                                 |
| **Speculative 模式（draft→verify→correct）** | 便宜模型出草稿、强模型只校验         | **是**（成本高、无分层）            | **ADAPT**                         | **P1**（依赖能力声明） | 同上抽象 → 任务书 §13                                                                                    |
| **EP / EPLB**                                | 异构资源按成本分布                   | **否**（我们无 GPU 集群）           | **REFERENCE**                     | P3                     | `model_executor/eplb/`                                                                                   |
| **SWA bounded replay（YOCO）**               | 长上下文只重放有界尾部               | **是**（context compaction 口径）   | **REFERENCE**                     | P2                     | `examples/yoco/`、`input_metadata/yoco.py`                                                               |
| **KV/状态缓存（block manager）**             | 复用已算结果                         | **类似**（无统一缓存抽象）          | **DEFER**（写 RFC，不实现）       | P2                     | `block_manager.hpp`、`cache_engine.py`                                                                   |
| **模型版本化编码（v4/v41）**                 | 版本差异要收敛                       | **是**（会散落 `if model==`）       | **ADAPT**（能力声明按版本）       | **P0**                 | recipe `encoding/src/v4,d41` → 我们 `provider.ts:8` 只有 modelName                                       |
| **协议各自流式实现**                         | 不同协议流式模型不同                 | **待查**                            | **REFERENCE**                     | P2                     | recipe `stream/*` + `chunk_generator.rs`                                                                 |
| **成本估算记录（MFU/tflops）**               | 调度时估算、事后可核对               | **部分**（无成本估算记录）          | **ADAPT**（记录预估 vs 实际）     | P1                     | `SchedulerOutputs.attn_tflops`、`stats_logger.py`                                                        |
| **CUDA/TileLang kernel**                     | 极致性能                             | **否**                              | **REJECT**                        | —                      | `csrc/`、`tilelang_ops/`                                                                                 |
| **多模态图像栈**                             | 图像输入                             | **否**（当前无需求）                | **REJECT**                        | —                      | recipe `image/`（opencv）                                                                                |
| **DeepSelect（NPU 选择算子）**               | NPU 侧算子选择                       | **否**                              | **REJECT**                        | —                      | `npu_ops/deep_select.py`                                                                                 |

## 决策汇总

| 决策          | 数量 | 具体                                                                                                              |
| ------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| **ADOPT**     | 2    | seed/确定性；缓存上限+kill switch 工程规矩                                                                        |
| **ADAPT**     | 7    | Conversation IR；reasoning 状态；结构化分层；batch-invariant 口径；speculative 模式；版本化能力声明；成本估算记录 |
| **REFERENCE** | 6    | 两阶段调度；异步调度；EP/EPLB；SWA replay；流式；—                                                                |
| **DEFER**     | 2    | 工具 IR；统一缓存抽象                                                                                             |
| **REJECT**    | 4    | DSpark token 级；CUDA kernel；图像栈；DeepSelect                                                                  |

## 与任务书 §24 初始假设的差异（诚实记录）

| 任务书假设                           | 源码证据后的修正                                                         |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 「Structured Output: ADOPT/ADAPT」   | 我们**已有** zod 校验版 → 只能 **ADAPT（补分层）**，不是从零 ADOPT       |
| 「Deterministic Sampling: ADAPT」    | 我们**完全没有** seed → 应是 **ADOPT**（直接加 seed 即可，无需改造架构） |
| 「Async Scheduler: REFERENCE」（对） | 维持 REFERENCE                                                           |
| 「EP/EPLB: REFERENCE/ADAPT」         | 我们无 GPU 集群 → **REFERENCE**（不 ADAPT）                              |
| 「DeepGEMM/FlashMLA: REJECT」（对）  | 维持；另补 **DeepSelect REJECT**、**DSpark token 级 REJECT**             |
| 未提及                               | 新增 **reasoning 状态 P0**（我们真实踩过，价值高于表内多项）             |

## 三个层次归类（任务书 §28）

**Layer A —— 立即吸收（低风险、高价值、通用）**

1. reasoning 状态四态（消除已踩坑）
2. 会话 IR 最小版（消息数组，含 reasoning/tool 位）
3. 能力声明（替代 `if model ==`）
4. seed + 记录（可复现）
5. 缓存上限 + kill switch 规矩

**Layer B —— 下一阶段（涉及架构）**

1. Speculative Agent Execution（草稿+验证）
2. 统一缓存 RFC
3. 结构化输出能力分层（native schema 已用 → tool → 校验修复的降级链）
4. 成本估算记录（预估 vs 实际）

**Layer C —— 只留知识**
两阶段/异步调度、EP/EPLB、SWA replay、KV 管理、CUDA kernel、DSpark token 级、多模态栈。
