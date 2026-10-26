# DeepSeek 蒸馏：源码事实基线（P0）

> 目的：为「以 DeepInfer / deepseek-recipe 为第一个高价值样本，蒸馏能力而非复制项目」建立**可核对的源码事实**。
> 本目录区分 **FACT（代码/元数据直接读到）** / **INFERENCE（据代码推断）** / **HYPOTHESIS（待验证）** / **RECOMMENDATION（建议）**。
> 不得把猜测写成 DeepSeek 官方事实。所有 FACT 带 `仓库@commit:路径` 证据。

## 0. 研究对象与版本（2026-10-26 实测，GitHub API）

| 仓库                          | commit         | 语言     | License        | Stars  | 最后推送   |
| ----------------------------- | -------------- | -------- | -------------- | ------ | ---------- |
| `deepseek-ai/DeepInfer`       | `553741557a57` | Python   | **Apache-2.0** | 22,674 | 2026-10-25 |
| `deepseek-ai/deepseek-recipe` | `935817c66f5d` | **Rust** | **MIT**        | 2,494  | 2026-10-19 |
| `deepseek-ai/DeepEP`          | `f6aa38fe06cd` | Cuda     | MIT            | 10,359 | 2026-10-21 |
| `deepseek-ai/DeepGEMM`        | `5081f8513af5` | Cuda     | MIT            | 9,103  | 2026-10-20 |
| `deepseek-ai/FlashMLA`        | `0f11e178da1f` | C++      | MIT            | 13,192 | 2026-10-15 |
| `deepseek-ai/DeepSelect`      | `bfa4507d935f` | Cuda     | MIT            | 519    | 2026-09-30 |

### 两处与任务书不符（必须记录，不得沿用错误前提）

1. **任务书把 `TileLang` 列为 `deepseek-ai/` 优先级对象** —— **FACT：`deepseek-ai` 组织下没有 TileLang**。
   真实仓库是第三方 `tile-ai/tilelang`（MIT 标注为 NOASSERTION，8,777 stars）。
   DeepInfer 只在 `deepinfer/model_executor/layers/tilelang_ops/` **使用**其算子 DSL，并非自研对象。
2. **任务书把 DeepEP / DeepGEMM / FlashMLA / DeepSelect 与两个主对象并列为「第二优先级研究项目」** ——
   FACT：它们在 DeepInfer 里是 **git submodule**（`.gitmodules` 六项，含两个 Ascend 变体），
   即「DeepInfer 直接钉死版本的**依赖库**」。因此它们属于 §1 允许的「直接影响关键设计时才下钻」，
   不是并列研究目标。**目录按依赖处理**，不单独立 architecture 文档。

### 体积（决定可研究方式）

- DeepInfer `size=2759KB`、default branch `main`，**实现主体是 Python + `csrc/` C++/CUDA**；
- deepseek-recipe `size=2301KB`，**Rust workspace**（7 个 crate）+ Python 绑定 + 两个 server demo。

## 1. 两个主对象的真实结构（FACT，来自 `git/trees/main?recursive=0`）

### 1.1 DeepInfer（`553741557a57`）

```
deepinfer/                     ← Python 主体
  engine/llm_engine.py, engine_type.py, stats_logger.py, profile_server.py
  entrypoints/llm.py           ← LLM 类入口
  sequence.py, sampling_params.py, config.py
  worker/                      ← base / worker / model_runner / cache_engine / cuda_graph_runner / zos_status
  model_executor/              ← models(v4_modules/*), layers(sampler, attention_backend), parallel_utils, eplb
  structure_output/            ← compiler / mask / matcher / so_matcher_builder  ★受约束生成
  hugging_face/                ← config/loading/tokenizer/weights/processor（HF 适配层）
  distributed/shm_broadcast.py ← 跨进程广播
  npu_ops/                     ← Ascend 侧 deep_select / vit_attn
  ve/                          ← 视觉编码器处理（多模态）
csrc/                          ← C++/CUDA 核
  engine/scheduler.hpp, sequence.hpp, block_manager.hpp, flops_estimator.hpp,
        prepare_sample.*, process_output.hpp, input_metadata/*, pybind_scheduler.cpp
  engine/zos.*                 ← 「zos」相关（HYPOTHESIS：与状态缓存/零开销调度有关，待证）
  graph_timer/, utils/(lockable, object_pool)
deep_cluster/{hardware(nvidia,ascend,cpu),topology/bind.py}   ← 集群与拓扑抽象
vendor/                        ← 6 个 submodule（DeepEP/DeepGEMM/FlashMLA/DeepSelect + Ascend 变体）
eval/                          ← aime/gpqa/hle bench + common/passk/judge
examples/, tests/, doc/, scripts/
```

**关键 FACT**：调度器在 **C++ 侧**（`csrc/engine/scheduler.hpp`，经 `pybind_scheduler.cpp` 暴露给 Python），
不在 Python 里。这决定了「异步调度/batch-invariant」的实现层次与我们（纯 TS/Node）**不同层**。

### 1.2 deepseek-recipe（`935817c66f5d`）

```
deepseek-recipe-core/src/         ← 会话与提示词核心（Rust）
  conversation.rs, messages.rs, prompt.rs, tools.rs,
  special_tokens.rs, json.rs, multimodal/token_spec.rs
deepseek-recipe/src/protocol/     ← ★协议转换层（本任务最重要的研究对象）
  openai/chat_completion/{request,response}/{convert,schema,chunk_generator}
  openai/responses/{request,response}/{convert,schema,accumulator,custom_tool_input,tools}
  anthropic/messages/{request,response}/{convert,schema,chunk_generator}
  reasoning.rs, reasoning_content.rs, tool_call_id.rs,
  json_schema.rs, output_constraint.rs, validation.rs, client_tools.rs, image.rs
deepseek-recipe/src/stream/       ← decoder/inference/logprobs/output_parser/processor（流式）
deepseek-recipe/src/request/options.rs, response.rs, error_response.rs
deepseek-recipe-encoding/src/     ← tokenizer + v4/dsv4.rs, v41/dsv41.rs（版本化编码）
deepseek-recipe-image/src/        ← fetcher/resolver/retry/limits/opencv（多模态图像）
deepseek-recipe-macros/src/       ← prompt.rs / untagged.rs 宏
deepseek-recipe-python/src/       ← PyO3 绑定（conversation/request/response/parsing/inference）
server-py/, server-rs/            ← 两个协议服务示例
static/tokenizers/{v4,v41}/       ← 随仓发布的分词器
encoding-decoding-demo/           ← 演示（encode→decode 往返）
docs/{streaming,tokenizer}.md
```

**关键 FACT（直接回答任务书 §8）**：recipe **确实存在协议无关的内部表示**：
`deepseek-recipe-core/src/{conversation,messages,prompt,tools}.rs` 是模型侧结构，
`deepseek-recipe/src/protocol/{openai,anthropic}/*/request|response/convert.rs` 是**每个协议各一个独立转换器**，
两侧不互相 import 协议 schema。这就是「Conversation IR + Adapter」的**实证形态**，不是猜测。

## 2. 两个对象的关系（FACT）

- 二者**互不依赖**：DeepInfer 无 recipe 引用，recipe 无 DeepInfer 引用（trees 无交叉 import）。
- 职责互补：
  - **DeepInfer** = 推理**引擎/运行时**（调度、批处理、KV/状态缓存、EP、受约束生成 mask、采样）；
  - **deepseek-recipe** = API **协议适配与编码层**（OpenAI/Anthropic 协议 ↔ DeepSeek 模型协议、tokenizer、reasoning、tools、streaming）。
- 组合关系（INFERENCE）：生产部署中 recipe 负责「对外协议 → 模型 token」，DeepInfer 负责「token → 推理执行」。
  **这是我们该吸收的分层思想**：协议适配与执行引擎分离。

## 3. 本阶段取证方式与边界

- **只读远端**：经 `gh api` 读元数据 / 文件树 / 单文件内容；**不 clone 整仓、不落本地镜像**（对齐 GKD 设计 §12 非目标）。
- 每个能力结论必须能给到 `repo@commit:path`；给不出的写 HYPOTHESIS。
- 不假设能跑完整 DeepInfer（任务书 §21）：无 GPU 集群、不下载 V4.1-Flash 权重。
- 本目录只放**研究成果**，实验代码按 §22.D 放 `experiments/deepseek-recipe/`，不混进生产代码。

## 4. 目录与状态

| 文件                                                                                  | 状态                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `README.md`（本文）                                                                   | ✅ P0 基线                                             |
| `deepinfer/capability-map.md`                                                         | ✅ 10 项能力，逐条证据                                 |
| `recipe/architecture.md`                                                              | ✅ IR / reasoning / tools / tokenizer / 流式           |
| `adoption/ixaeon-gap-analysis.md`                                                     | ✅ 8 个 gap（全部带我们文件:行）                       |
| `adoption/adoption-matrix.md`                                                         | ✅ 19 项判定 + 与任务书假设差异                        |
| `adoption/rejected-ideas.md`                                                          | ✅ Do Not Copy List + 8 条引入准则                     |
| `adoption/top10-lessons.md`                                                           | ✅ 10 条 Lesson（Lesson/Why/Evidence/Impact/Action）   |
| `adoption/rfc-proposals.md`                                                           | ✅ 3 份 RFC（IR / ReasoningState / ModelCapabilities） |
| `deepinfer/{architecture,scheduling,cache,speculative-decoding,structured-output}.md` | ⏳ 主要结论已并入 `capability-map.md`，需细化再拆      |
| `recipe/{api-conversion,prompt-rendering,tokenizer,reasoning,tool-calling}.md`        | ⏳ 主要结论已并入 `recipe/architecture.md`             |

## 5. 任务书 §30 验收对照

| 验收项                                                           | 状态           | 位置                                                               |
| ---------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| A 准确解释两者及关系                                             | ✅             | 本文 §2 + `recipe/architecture.md` §0                              |
| B 两份 Capability Map                                            | ✅（合并形式） | `deepinfer/capability-map.md` + `recipe/architecture.md` §1-5      |
| C ≥10 个结构化 SourceCapability                                  | ✅ 13 项       | capability-map C1-C10 + recipe IR/reasoning/tools/tokenizer/stream |
| D 每项有 Evidence/Problem/Mechanism/Assumptions/Mapping/Decision | ✅             | 各表 + `adoption-matrix.md`                                        |
| E Adoption Matrix                                                | ✅             | `adoption/adoption-matrix.md`                                      |
| F ixaeon Gap Analysis                                            | ✅             | `adoption/ixaeon-gap-analysis.md`                                  |
| G ≥3 个架构 RFC                                                  | ✅ 3 份        | `adoption/rfc-proposals.md`                                        |
| H 未引入 GPU 依赖/私有化设计/Provider 强耦合/重复能力            | ✅             | 零代码改动，纯文档                                                 |
| I 所有新增代码测试通过                                           | ✅ N/A         | 本阶段无代码                                                       |
| J 工作区干净                                                     | ✅             | 见交付说明                                                         |

## 6. 本版**不含**什么（照 §25/§10 的教训显式声明）

- **不含**任何 ixaeon 生产代码改动（本阶段纯研究，见任务书 §32「Adoption Matrix 前禁止大改主代码」）；
- **不含** DeepInfer 实机运行（无 SM100/Ascend 硬件，不下载 V4.1-Flash 权重，任务书 §21）；
- **不含** `experiments/deepseek-recipe/` 实验代码（§22.D 允许但本批未做，需统筹确认后再立）；
- **不含** recipe 的逐文件细读（集中在 IR/reasoning/tools/tokenizer/stream 五个最相关面）；
- **不含** `deepinfer/{scheduling,cache,speculative,structured-output}` 独立拆文档（结论已进 capability-map）。
