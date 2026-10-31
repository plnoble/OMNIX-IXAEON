# DeepInfer 能力地图（Capability Map）

> `deepseek-ai/DeepInfer@553741557a57`。标注：**FACT** = 源码/官方 README 直接读到；**INFERENCE** = 由代码推断；**HYPOTHESIS** = 待验证。
> 官方自述（README，FACT）：本仓库是「驱动 DeepSeek 大规模生产服务的高性能推理框架」的**离线推理公开版**。

## 0. 官方声明能力 vs 本仓实际有/没有（FACT）

| README 声明                                              | 本仓实际        | 说明                                                                                              |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| Optimized kernels, model and sampler runtime             | ✅ 有           | `csrc/` + `deepinfer/model_executor/layers/`                                                      |
| Attention DP / balanced CP、MoE EP + EPLB                | ✅ 有           | `model_executor/parallel_utils/{cp,parallel_state}.py`、`model_executor/eplb/{policy,shuffle}.py` |
| DSpark + confidence-scheduled verification               | ✅ 有           | `model_executor/models/mtp/dflash.py`、`csrc/engine/mtp_varlen.hpp`、`input_metadata/dflash.py`   |
| SWA bounded replay（YOCO）                               | ✅ 有           | `examples/yoco/`、`input_metadata/yoco.py`、`DEEPINFER_YOCO_PREFILL_*`                            |
| Asynchronous scheduling（zero-overhead batch scheduler） | ✅ 有           | `csrc/engine/scheduler.hpp`（C++）+ `pybind_scheduler.cpp`                                        |
| Batch-invariant inference                                | ✅ 有           | `tests/models/test_batch_invariant.py`、`DEEPINFER_BATCH_INVARIANT`                               |
| Deterministic sampling                                   | ✅ 有           | `tests/models/test_sampler.py`、`SamplingParams.seq_seed`                                         |
| Structured outputs（regex / JSON schema / EBNF）         | ✅ 有           | `deepinfer/structure_output/`（基于 **xgrammar**）                                                |
| **KV cache system**                                      | ❌ **本仓不含** | README 明说「complete inference service 需要、但本版未包含」                                      |
| **VE/Prefill/Decode 分离部署**                           | ❌ 未完整       | README：「多数引擎功能已实现」，但分离部署不含                                                    |
| **DP 副本级负载均衡（prefill/decode）**                  | ❌ 不含         | 同上                                                                                              |

**结论（FACT）**：这是一份「引擎内核 + 单机/单副本可跑」的公开版，**不含** KV 服务、分离部署、跨副本 LB。

## 1. 能力清单（按可复用价值排序）

### C1. 两阶段调度：Prefill / Decode 显式区分（FACT）

- 证据：`csrc/engine/scheduler.hpp` 的 `EngineType` 枚举 `NORMAL|PROMPT|COMPLETION`（:36-40）；
  `SchedulerOutputs.prompt_run` 布尔位（:47）；`scheduling` 里按 prompt/decode 走不同预算与张量准备
  （`input_metadata/{prepare_tensor_input,prepare_v4_decode_metadata}.*`）。
- 解决什么：prefill（长 prompt、高算力）与 decode（逐 token、受带宽限）成本结构完全不同，混排会互相拖累。
- 可复用性：**思想层面高**（任何「重/轻两级工作混跑」的系统都适用）；实现层面**不适用**（依赖 GPU kernel 与显存规划）。
- ixaeon 映射：JobQueue 里「重任务（研究/整仓分析）」与「轻任务（通知/整理）」分级调度——**REFERENCE→可 ADAPT**。

### C2. 异步调度：CPU 排批与设备执行重叠（FACT）

- 证据：README「Asynchronous scheduling: overlap CPU batch scheduling with device execution」；
  `scheduler.hpp` 中 `num_batched_tokens`/`last_step_num_batched_tokens` 以及注释
  「optimistic estimation in async-scheduling varlen case」（:56）。
- 解决什么：调度决策（CPU）与执行（GPU）串行会让设备空转。
- 可复用性：思想通用（**IO 与计算重叠**），但我们的「设备」是外部 API，重叠方式是并发而非 GPU stream。
- ixaeon 映射：模型调用与本地 IO/DB 写入重叠——**ADAPT**（并发度与限流需自己定）。

### C3. Batch-invariant inference（FACT，高价值）

- 证据：`tests/models/test_batch_invariant.py`、README「keep model results identical across different batch compositions」。
- 解决什么：同一请求和别的请求凑一批就得到不同数值结果 → **不可复现**，评测/回归不可信。
- 可复用性：**思想极高**。我们的痛点完全相同：同一问题在不同并发、不同上下文下结果漂移，导致「回归测试不可信」。
- ixaeon 映射：**确定性评测**——固定输入 → 固定输出（或固定可解释差异），用于 Agent/task replay、回归基线。**ADOPT（思想级）**。

### C4. Deterministic sampling（FACT）

- 证据：README「pass a fixed `seq_seed` to `SamplingParams`」；`deepinfer/sampling_params.py`。
- 解决什么：采样随机导致同输入不同输出。
- 可复用性：**极高且低成本**——给每次生成一个**显式 seed** 并记录，就能让「这次为什么是这个结果」可复现。
- ixaeon 映射：D5a/D5b 的验收测试、任何 benchmark——**ADOPT**（如果 provider 支持 seed；不支持的记录为不可复现）。

### C5. 受约束生成（Structured Outputs，FACT）

- 证据：`deepinfer/structure_output/{compiler,mask,matcher,so_matcher_builder}.py`；
  实现基于第三方 **xgrammar**（`compiler.py` import `xgrammar`）；README 支持 regex / JSON schema / EBNF。
- **重要工程细节（FACT，`structure_output/compiler.py:15-33`）**：xgrammar 缓存**必须有字节上限**，否则
  「不同 schema 让缓存无界增长，可能 OOM（DoS 向量，见 CVE-2025-32381）」；还把 `DEEPINFER_XGRAMMAR_DISABLE_CACHE`
  留成 kill switch，并明说「xgrammar ≤0.1.x 开缓存出过生产事故」。
- 解决什么：让机器间通信/结构化提取不靠「祈祷模型输出合法 JSON」。
- ixaeon 映射：我们**大量**用 JSON 结构化输出（规划、抽取、验收）。但注意：DeepInfer 是在**解码层用 grammar 强制**，
  我们只能用 **provider 原生 JSON schema** 或 **校验+修复**。→ **ADAPT**（分层降级：native schema → tool call → 校验修复）。
- **可直接借的教训**：任何「按 schema 缓存编译产物」的地方，都要有**上限 + kill switch + 失败回退**。

### C6. DSpark / confidence-scheduled verification（FACT）

- 证据：README「accelerate decoding with draft tokens and use confidence estimates to schedule verification」
  `DEEPINFER_ENABLE_MTP_VARLEN=1`、`DEEPINFER_USE_NEXTN_DECODE`（默认 draft 长度 5）；
  代码 `model_executor/models/mtp/dflash.py`、`csrc/engine/mtp_varlen.hpp`。
- 解决什么：用便宜的 draft + 昂贵的 verify 换吞吐。
- 可复用性：**token 级不可用**（要 kernel 与模型头）；**架构级极高**（draft→verify→accept/correct）。
- ixaeon 映射：**Speculative Agent Execution**：便宜模型出方案 → 强模型只校验/改错处。任务书 §13 明确要求这个概念迁移。**ADAPT**。

### C7. EP/EPLB 与并行策略（FACT）

- 证据：`model_executor/eplb/{policy,shuffle}.py`、`parallel_utils/{cp,parallel_state,communication_op}.py`、
  `deep_cluster/{hardware,topology}`。
- 解决什么：成本不同的工作单元如何分布到异构资源。
- 可复用性：**不适用**（GPU/NPU 拓扑、专家并行）。思想层：**异构资源按成本分配** → 我们的 Workload Router 可参考，但**REFERENCE only**。

### C8. SWA bounded replay / YOCO（FACT）

- 证据：`examples/yoco/`、`input_metadata/yoco.py`、README「replaying only a bounded suffix」。
- 解决什么：长上下文 prefill 只重算**有界尾部**，而不是全量重算（前提：保留的尾部要覆盖 SWA 窗口 + 最大回溯长度）。
- 可复用性：**思想可迁移**——「上下文压缩/重放只保留有界窗口」；但依赖 attention 机制细节。
- ixaeon 映射：**上下文压缩**（compaction）时「只重放有界尾部」的取舍口径。**REFERENCE**。

### C9. 状态缓存与 block 管理（FACT/HYPOTHESIS）

- 证据：`csrc/engine/block_manager.hpp`、`worker/cache_engine.py`、`worker/zos_status.py`、`csrc/engine/zos.{cpp,hpp}`。
- **HYPOTHESIS**：`zos` 与「状态缓存/零开销调度」相关（目录与命名暗示，未见文档明说）。
- 可复用性：**不可复用**（显存 block 分配）。

### C10. 可观测与统计（FACT）

- 证据：`engine/stats_logger.py`、`engine/profile_server.py`、`flops_estimator.hpp`、`graph_timer/`、
  `SchedulerOutputs.attn_tflops/total_tflops`（「immutable scheduling-time MFU estimate」）。
- 可复用性：思路——**调度时就把成本估算记录下来，事后可核对估算准不准**。低成本可借。**ADOPT（思想）**。

## 2. 明确「不要抄」的部分（详见 `adoption/rejected-ideas.md`）

CUDA/TileLang kernel、EP/EPLB 实现、block/zos 显存管理、graph_timer、xgrammar 集成实现、
任何依赖 SM100/Ascend 950 的代码。

## 3. 一句话总结（FACT 支撑）

DeepInfer 对我们的价值**不是代码**，是三样东西：
**① 确定性（batch-invariant + seeded sampling）**、
**② 分层（协议适配 / 引擎执行 / 受约束解码各司其职）**、
**③ 成本意识（调度时估算、draft-verify 换吞吐、缓存必须有界）**。
