# Do Not Copy List（禁止吸收清单）

> 任务书 §26。目的：避免因为「代码很高级」就盲目引入。每条给出**为什么不抄**，不是「不想抄」。

## 一、只适合 DeepSeek 特定模型/架构的逻辑

| 对象                                                                                        | 证据                                           | 为什么禁止                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `v4_modules/` 全部（`engram`、`hc`、`mhc_*`、`mla_attn`、`index_attn`、`compress`、`yoco`） | `deepinfer/model_executor/models/v4_modules/*` | 与 DeepSeek-V4/V4.1 的模型结构绑定（MLA/Engram/HC 等），我们没有自研模型，无法也没有意义使用 |
| `special_tokens.rs` 的具体 token 拼写                                                       | recipe `core/special_tokens.rs`                | 是 DeepSeek 分词器的特殊 token 字面量，我们没有 tokenizer                                    |
| `dsv4.rs` / `dsv41.rs` 编码实现                                                             | recipe `encoding/src/v4*`                      | 依赖 DeepSeek 官方 tokenizer.json；我们通过 provider API，不经手 token                       |
| `mtp_varlen.hpp` / `dflash.py`（DSpark）                                                    | `csrc/engine/`、`models/mtp/`                  | 依赖多 token 预测（MTP）模型头；我们无此结构                                                 |

## 二、只适合超大 GPU/NPU 集群的逻辑

| 对象                                | 证据                                                          | 为什么禁止                                                 |
| ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| EP / EPLB（专家并行、专家负载均衡） | `model_executor/eplb/{policy,shuffle}.py`、`parallel_utils/*` | 需要 MoE 模型 + 多卡通信（NCCL）；我们是本地单机 Node 应用 |
| balanced CP / Attention DP          | `parallel_utils/cp.py`、`parallel_state.py`                   | 同上                                                       |
| `deep_cluster/{hardware,topology}`  | 同目录                                                        | 硬件拓扑感知（NVLink/Ascend HCCS），我们无集群             |
| `shm_broadcast.py`                  | `distributed/shm_broadcast.py`                                | 跨进程共享内存广播，为多 worker 推理设计                   |

## 三、与特定 Kernel 强绑定的实现

| 对象                                                        | 证据                            | 为什么禁止                               |
| ----------------------------------------------------------- | ------------------------------- | ---------------------------------------- |
| `csrc/` 全部 CUDA/C++ 核                                    | `csrc/**`                       | CUDA 13 + SM100 专用；我们是纯 TS        |
| `model_executor/layers/tilelang_ops/`（cuda/ 与 asc/ 两套） | 同目录                          | TileLang DSL 生成的 kernel，NDA 深度依赖 |
| `graph_timer/`（CUDA graph 计时）                           | `csrc/graph_timer/`             | 绑 CUDA graph 捕获机制                   |
| `block_manager.hpp`（显存 block 分配）                      | `csrc/engine/block_manager.hpp` | 显存物理布局管理                         |

## 四、与特定硬件绑定的优化

| 对象                                                              | 证据                                          | 为什么禁止                      |
| ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------- |
| Ascend 相关全部（`npu_ops/`、`acs/*`、`requirements-ascend.txt`） | 多处                                          | 华为 CANN 9.2 / Ascend 950 专用 |
| `DeepSelect` 集成                                                 | `npu_ops/deep_select.py`、`vendor/DeepSelect` | NPU 侧算子选择                  |
| `cuda_utils.cpp` / `cuda_utils.hpp`                               | `csrc/`                                       | CUDA 特定工具                   |

## 五、我们完全没有需求的部分

| 对象                                        | 证据                                    | 为什么禁止                                          |
| ------------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| `deepseek-recipe-image/`（图像抓取/opencv） | 同目录                                  | 我们当前无图像输入需求；引入 opencv 是重依赖        |
| `encoding-decoding-demo/`（Web demo）       | 同目录                                  | 演示用，无产品价值                                  |
| `server-py/`、`server-rs/`（协议服务示例）  | 同目录                                  | 示例服务，我们的 IPC 走 Electron 已有通道           |
| `eval/`（AIME/GPQA/HLE benchmark 脚本）     | `eval/**`                               | 绑 DeepSeek 模型评测，我们的验收是自己的测试体系    |
| `prefix: bool` 前缀续写                     | recipe `messages.rs` `Assistant.prefix` | 我们没有「续写半条消息」的产品需求                  |
| `LatestReminder` 消息类型                   | recipe `messages.rs`                    | 我们的提醒走 TodoStore/通知，不需要模型侧独立消息位 |
| 20+4 位 tool_call_id 格式（含 xxh3 校验）   | recipe `tool_call_id.rs`                | 格式是我们不需要的；**只有 `ET_` 承载的语义值得借** |

## 六、判断准则（本包立的规矩）

引入任何外部代码前必须过：

1. 明确 License；
2. 明确来源（repo + commit + 文件）；
3. 说清楚**为什么必须是代码而不是思想**；
4. 我们确实**没有**同类实现；
5. 无法用更简单的独立实现解决；
6. 不制造强耦合；
7. 有测试；
8. 可独立替换。

**优先级**：学习思想 > 抽象 Pattern > 重新实现 > 包装外部库 > **复制代码（永远最后）**。
