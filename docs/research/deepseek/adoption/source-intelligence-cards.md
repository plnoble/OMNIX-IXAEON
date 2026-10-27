# Source Intelligence Cards（任务书 §16）

> 两张卡：DeepInfer、deepseek-recipe。字段按 §16 模板；机器可读版见 `../evidence/*.json`（§17）。

---

## Card 1：DeepInfer

```yaml
project: DeepInfer
repo: deepseek-ai/DeepInfer
commit: 553741557a57
license: Apache-2.0
language: Python + C++/CUDA (csrc/)
category: Inference Runtime（离线推理引擎）
core_problem: >
  DeepSeek 大规模生产服务的高性能推理；本公开版提供离线推理 + 规模化所需的核心特性。

important_ideas:
  - 两阶段调度：EngineType NORMAL/PROMPT/COMPLETION，prefill 与 decode 成本结构不同（scheduler.hpp:36-47）
  - 异步调度：CPU 排批与设备执行重叠（README + scheduler.hpp:56「optimistic estimation in async-scheduling」）
  - Batch-invariant inference：结果与批组成无关 → 评测可复现（tests/models/test_batch_invariant.py）
  - Deterministic sampling：固定 seq_seed → 同输入同输出（README + sampling_params.py）
  - Structured outputs：regex / JSON schema / EBNF 解码期强制，底层用第三方 xgrammar（structure_output/）
  - 缓存必须有界：xgrammar 缓存无界 → OOM（CVE-2025-32381），带 kill switch（compiler.py:15-33）
  - DSpark：draft tokens + confidence-scheduled verification（models/mtp/dflash.py）
  - SWA bounded replay（YOCO）：只重放有界尾部（examples/yoco/）
  - EP/EPLB：专家并行与负载均衡（model_executor/eplb/）
  - 调度时成本估算并留痕：total_tflops 注释为 immutable scheduling-time estimate（scheduler.hpp:61-62）

hardware_assumptions:
  - NVIDIA SM100 GPU 或 Huawei Ascend 950 NPU（README「Supported hardware」）
  - Linux + GCC>=13 + Python 3.12 + CUDA 13 / CANN 9.2
  - 多卡通信（NCCL/c10d）、显存 block 管理 → 依赖集群级基础设施

model_assumptions:
  - 目标模型 DeepSeek-V4.1-Flash（README「Supported models」）
  - MoE + MLA/Engram/HC 等专有结构（models/v4_modules/）
  - MTP（多 token 预测）头才能用 DSpark

reusable_patterns: # 思想层，不含代码
  - 确定性 = 评测地基（seed + 批不变）
  - 分层：协议适配 / 引擎执行 / 受约束解码 各司其职
  - 约束强度分级：强制 > 原生 schema > 生成后校验
  - 按内容增长的缓存必须有上限 + kill switch
  - 调度时估算、事后核对估算偏差
  - 便宜草稿 + 昂贵验证（架构级，非 token 级）
  - 重/轻工作分级调度

non_reusable_components:
  - csrc/ 全部 CUDA/C++ kernel（绑 SM100/CUDA13）
  - tilelang_ops/（TileLang DSL 生成核）
  - block_manager/zos（显存物理布局）
  - EP/EPLB/CP 并行实现（绑多卡通信）
  - v4_modules（DeepSeek 模型专有结构）
  - graph_timer、shm_broadcast、nccl_memory

ixaeon_mapping:
  idea_determinism: 验收/benchmark 需要可复现 → ModelCapabilities.seed + 记录 seed（RFC-003 已声明现状 false）
  idea_constraint_layers: 我们已有 zod 校验 + json_schema strict（openai.ts:134-143）→ 缺「按能力选档」
  idea_bounded_cache: 立规矩（尚无此类缓存）
  idea_cost_estimate: JobQueue/模型调用记「预估 vs 实际」，先攒数据
  idea_heavy_light: JobQueue 现状无分级（有 kind 去重与「给聊天让路」）

adoption_status: >
  按 adoption-matrix.md：确定性 ADAPT/ADOPT(P0)、能力声明 ADAPT(P0)、缓存规矩 ADOPT(P1)、
  DSpark token 级 REJECT、kernel/EP REJECT、调度思想 REFERENCE。未实现任何代码。

not_in_this_release: # README 自述边界（重要：别按「完整框架」预期用它）
  - KV cache system
  - VE/Prefill/Decode 分离部署
  - 数据并行副本间负载均衡
```

---

## Card 2：deepseek-recipe

```yaml
project: deepseek-recipe
repo: deepseek-ai/deepseek-recipe
commit: 935817c66f5d
license: MIT
language: Rust（workspace 7 crate）+ PyO3 绑定
category: Protocol Adapter / Encoding Layer（不是推理引擎）
core_problem: >
  对外 API 协议（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）
  与 DeepSeek 模型侧协议（会话→prompt→token ids）之间的双向转换，含流式、工具、reasoning、多模态。

important_ideas:
  - Conversation IR：core/conversation.rs + messages.rs 五变体（System/User/Assistant/Tool/LatestReminder），
    协议 schema 与 IR 完全隔离，每协议各一份 convert.rs（回答任务书 §8）
  - Prompt 与 String 类型区分：special token 边界显式化（messages.rs:1-10 注释）
  - reasoning 状态精确处理：三条件才拒绝 + ET_ 带内标记区分「无推理」与「漏传」
    （reasoning_content.rs:1-70、tool_call_id.rs:1-40）→ 直接对应我们踩过的坑
  - 模型版本差异收敛：encoding/src/v4/{dsv4,dsv41}.rs 各一份；V4/V4.1 渲染差异写死在注释与 convert
  - 流式按协议各异：Responses 需 accumulator（事件累加）≠ delta 逐块（stream/ + chunk_generator.rs）
  - 图像栈自带 limits/retry/resolver（deepseek-recipe-image）

hardware_assumptions:
  - 无（纯 CPU 转换层；这是它与 DeepInfer 的关键差别）

model_assumptions:
  - DeepSeek V4 与 V4.1 的 prompt 格式与特殊 token（static/tokenizers/{v4,v41}/tokenizer.json）
  - thinking mode 的 reasoning_content 回传约定

reusable_patterns:
  - 协议 DTO ↔ Canonical IR ↔ 模型格式 的三层分离
  - 「空值」必须区分合法空与漏传（带内标记）
  - 版本差异收敛到单一落点，不散落 if
  - 不同协议的流式语义不同，不做统一硬抽象

non_reusable_components:
  - 具体特殊 token 拼写（DeepSeek 分词器专有）
  - tool_call_id 的 20+4 位 xxh3 格式（只借 ET_ 的语义）
  - prefix 续写、LatestReminder 消息位（我们无此需求）
  - opencv 图像栈、server-py/server-rs 示例、encoding-decoding-demo

ixaeon_mapping:
  conversation_ir: RFC-001（类型已交付于 DS2；chat() 接线因破坏既有测试面暂停，见交付说明）
  reasoning_state: RFC-002（ReasoningState 四态已交付于 DS2）
  version_capabilities: RFC-003（ModelCapabilities 已交付于 DS2）

adoption_status: >
  IR/reasoning/capabilities 三项 ADAPT(P0)，已在 dev2/DS2 交付类型层与纯函数层；
  多轮接线（DS3）暂停——实测改接口会破坏 6+ 既有测试读取 FakeProvider.textCalls 的字段形状，
  等整合方定方案。prefix/multimodal 等 REJECT。

note: >
  两仓库互不依赖（trees 无交叉 import）。组合关系（INFERENCE）：recipe 管「对外协议→token」，
  DeepInfer 管「token→执行」。这个分层本身就是该吸收的思想。
```
