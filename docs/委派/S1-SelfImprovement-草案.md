# 规格草案 S1：Self-Improvement System —— 真正的自我成长

> dev2 按用户 2026-10-28 任务书**大块五**起草。**草案，不是生效规格。**
> 与 M1/H1/E1 同规矩：先草案 + 队列登记，**不写实现**；定稿与排期归统筹/整合方。
> 依赖：E1（评测）、G1（Goal）、H1（心跳/Reflection）、Relay（写代码的执行方）。

## 1. 要什么（用户原文 1 节）

Relay 解决的是「**怎么让 AI 修改 IXAEON 代码**」。
Self-Improvement 要解决的是「**为什么值得修改**」以及「**修改之后是否真的变好了**」。

一句话定性（原文 6 节，照这个划边界）：

```text
Self-Improvement = 产品经理 + 研究员   （发现问题 → 提出改进 → 验证价值）
Relay            = 软件工程团队        （真正写代码）
不能混成一个系统。
```

## 2. Improvement Candidate 结构与状态机（原文 2 节）

字段（照原文，一个不少）：

| 字段                 | 含义                               | 备注                          |
| -------------------- | ---------------------------------- | ----------------------------- |
| `problem`            | 要解决什么问题                     | 必填                          |
| `evidence`           | 证据（指向真实记录，不是模型自述） | **必须有来源引用**，见 §3     |
| `baseline`           | 改进前基线                         | 与 candidate 必须同口径（§4） |
| `hypothesis`         | 为什么认为会变好                   | 允许是猜想，但要写清          |
| `proposedChange`     | 改什么                             | **只是提案**，不由本系统落地  |
| `affectedCapability` | 影响哪项能力                       | 需与 E1 的 19 项指标口径对齐  |
| `expectedBenefit`    | 预期收益                           | 必须可证伪                    |
| `risk`               | 风险                               | 至少要写「最坏情况」          |
| `evaluationPlan`     | 怎么验                             | 必须逐例可对照（§4）          |
| `rollbackPlan`       | 怎么退                             | §5 canary 失败时的退路        |
| `status`             | 状态                               | 见下                          |

状态机（8 态）：

```text
observed → proposed → approved → experimenting → validated → deployed
                  ↘ rejected            ↘ (失败) rolled_back
```

硬规矩：

- `approved` 之后才能进 `experimenting`；
- `deployed` 必须来自 `validated`（**不许跳过验证直接上线**）；
- `rolled_back` 是**一等状态**，不是失败终点——它要留证据供下次参考；
- **任何状态都不允许模型自己迁移**（`observed→proposed` 可以由系统生成，但
  `approved` 必须人/整合方确认，`deployed` 必须 Relay 执行完回报）。

## 3. 来源（原文 3 节）——**逐项核实真实数据源**（这是本草案最要紧的部分）

原文列了 8 种来源。我逐项对到现有代码，凡是**没有真实信号的**明确标出，
因为「模型觉得这样可能更好」本来就被原文禁止，而**没有证据的候选**等于换个说法的模型主观。

| 来源              | 现有真实信号                                                                                                    | 判定              |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| 用户纠正          | ✅ `corrections(id, old_item_id, user_text, new_item_id, created_at)`                                           | **可自动发现**    |
| Task Failure      | ✅ `coding_tasks.status='failed'`（+ `error`）、`JobQueue` 退避记录                                             | **可自动发现**    |
| Memory 错误       | ❌ 无检索/注入日志                                                                                              | **依赖 E1a 埋点** |
| Research 发现     | ✅ `research_findings` / `research_runs`（6 张 research 表）                                                    | **可自动发现**    |
| 7-Day Eval        | ⚠️ E1 尚无实现                                                                                                  | **依赖 E1b/E1d**  |
| 性能异常          | ❌ **实测：core 里没有任何运行时耗时写入**（`durationMs`/`latencyMs`/`elapsedMs` 零命中），只有 CI 里的性能测试 | **需新增埋点**    |
| 模型表现变化      | ❌ 无按模型/版本的成功率追踪                                                                                    | **需新增埋点**    |
| IXAEON Reflection | ❌ H1 未落地                                                                                                    | **依赖 H1c**      |

**结论：8 种来源里 3 种现在就能自动发现，3 种依赖 E1/H1，2 种需新增埋点。**
所以 S1 的第一版**只能做「有证据的三类」**（纠错 / 任务失败 / 研究结论），
其余等埋点或前置落地——不许拿「模型觉得」凑数。

## 4. Baseline → Candidate 对照（原文 4 节，落成硬要求）

原文的例子正是要害：

```text
Memory Recall v1：30 场景正确 22
Memory Recall v2：30 场景正确 27
但如果旧场景退化 5 个，则不能只看总体分数。
```

落成规则：

1. **必须逐例对照**，保存「哪些从对变错」「哪些从错变对」的**具体清单**，不只存两个总分；
2. **净提升 ≠ 可接受**：出现**任何回归用例**时，报告必须显式列出，且不允许用
   「总体 +5」掩盖「旧场景 −5」；
3. `baseline` 与 `candidate` 必须**同口径、同用例集、同判定标准**——换口径就等于没比较；
4. 判定要么是**用例级可复现的自动判定**，要么标注为**人工判分**（沿用 E1 §2a：
   用户是最终真值），**禁止**「综合打分通过」这种无法复核的结论。

**依赖现实**：这套逐例对照正是 E1b 的产物。**E1 没落地前，S1 只能记录候选，不能声称「验证变好」。**

## 5. Canary 与 Rollback（原文 5 节）——**实测：当前零基础**

原文要求：`candidate config` / `canary run` / `observation period` / `rollback`，
失败后**自动回到已知稳定版本**。

实测结论（写规格前查过）：

- **core 与 relay 都没有** canary、feature flag、配置版本号、自动回滚机制
  （全仓 `canary|featureFlag|rollback` 只在 `storage/archiveStore.ts` 出现，那是文件备份还原，不是配置回滚）；
- 现有「配置」是 `settings.ts`（少量开关）+ relay 的 `config.json`，**都没有版本与历史**。

所以 §5 不是「接一下现成能力」，而是**要新建**：

1. **配置版本化**：每次 candidate config 落成一个带版本号的不可变记录（谁改了什么、什么时候）；
2. **canary 运行**：候选配置先作用于限定范围（时间窗/功能子集），与 baseline 并行可比；
3. **观察期**：按 E1 的指标在窗口内比较，**不能只看分数**（沿用 §4 逐例对照）；
4. **自动回滚**：观察期失败或出现硬违规（如 E1 的 Hard Quiet Violation）→ 一键回到上一个已知稳定版本，
   且**回滚本身要留审计**。

**这条是 S1 最大的成本，也是最高风险的一环**（改的是运行配置，失败影响全局）。
必须单独成支、单独评审，**不得与「候选记录」混在一支里做**。

## 6. 关键架构判断：**与既有 skill_candidates 严重重叠，必须先定归属**

`skill_candidates`（`migrations.ts`，已存在并有运行时生命周期 `runtime/skills.ts`）已有：

```text
problem / method / eval_case / status(proposed|evaluated|approved|rejected|retired)
/ eval_before / eval_after / benefit / version / eval_evidence_json / approved_version
/ created_from_work_run_id
```

与 Improvement Candidate 对照：

| Improvement Candidate                                                      | skill_candidates 里的对应                                      | 差异                                  |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| `problem`                                                                  | `problem`                                                      | 同                                    |
| `baseline`                                                                 | `eval_before`                                                  | 同                                    |
| `proposedChange`                                                           | `method`                                                       | 同                                    |
| `evaluationPlan`                                                           | `eval_case`                                                    | 同                                    |
| `expectedBenefit`                                                          | `benefit`                                                      | 同                                    |
| `evidence` / `hypothesis` / `affectedCapability` / `risk` / `rollbackPlan` | **无**                                                         | 缺 5 项                               |
| 状态 8 态                                                                  | 5 态（缺 `observed`/`experimenting`/`deployed`/`rolled_back`） | 缺 4 态（且 `evaluated`≈`validated`） |

**这是本草案必须先由统筹拍板的事**：三条路选一，我不自行发明。

| 方案                                 | 说明                                                                                                                                       | 代价                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **A. 扩展 `skill_candidates`**       | 加 `kind` 判别 + 补 5 列 + 补 4 状态                                                                                                       | 改动既有表与既有生命周期，**迁移归整合方**；风险是污染技能语义                 |
| **B. 新建 `improvement_candidates`** | 独立表、独立生命周期                                                                                                                       | 与 skill_candidates 形成两套「候选→评估→批准」，**违反「不要第二套知识系统」** |
| **C. 两层（我倾向）**                | 新建 `improvement_candidates` **只承载系统级变更**（代码/配置，带 canary/rollback）；**技能类**改进仍走 `skill_candidates`，由候选单向引用 | 多一张表，但**职责不重叠**：一个管「系统怎么变」，一个管「agent 会什么」       |

选 C 的理由：`affectedCapability` + `canary/rollback` 说明它本质是**变更管理**，不是技能库；
而 GKD 已定「capability 复用 skill_candidates」，若 S1 再把系统变更塞进同一张表，
会出现「一个 agent 会什么」与「系统这版改了没有」混在一条记录里的语义混乱。

**另需注意的第三处重叠**：GKD 的 `gkd_experiments` 也在做「验证一个 pattern 值不值得采用」。
S1 的 `experimenting` 与它的关系也要在定稿时说清——**建议 S1 复用同一套实验记录表**
（`gkd_experiments` 或改名 `experiments`，加 `subject_kind='improvement'`），
而不是第三套实验台账。

## 7. 与 Relay 的边界（原文 6 节，写死）

- S1 **只产出** `improvement_candidates` 与验证结论，**不写代码、不改仓库、不提 PR**；
- 真正的代码改动**一律交给 Relay / Coding Executor**（`coding_tasks`）；
- 交接方式：`approved` 的候选 → 生成一条 coding task（引用候选 id）→ Relay 执行 →
  回报结果写回候选的 `status`/证据；
- **禁止**：S1 自己调用编码执行器绕过 Relay 的流水线；也**禁止** S1 直接把候选标 `deployed`
  ——`deployed` 必须由 Relay 侧确认改动已并入后才成立。

## 8. 拆分、档位与依赖

| 支      | 内容                                                                                 | 档位                                        | 依赖        |
| ------- | ------------------------------------------------------------------------------------ | ------------------------------------------- | ----------- |
| **S1a** | 候选记录 + 3 类有证据来源的自动发现（纠错/任务失败/研究结论）+ 状态机（不含 canary） | **B**（新表或改既有表 = 迁移归整合方）      | §6 归属先定 |
| **S1b** | 逐例 baseline→candidate 对照（用例级清单、回归必列、口径一致）                       | A                                           | E1b、S1a    |
| **S1c** | 配置版本化 + canary + 观察期 + 自动回滚                                              | **B**（改运行配置与全局行为，**最高风险**） | S1a、S1b    |
| **S1d** | 与 Relay 的交接（approved 候选 → coding task → 结果回写）                            | **B**（跨系统边界）                         | S1a、Relay  |

**排期现实**：S1a 可以在 E1 之前做（三类来源已有信号），
但 **S1b 起必须等 E1b**，**S1c 是最高风险，建议最后做**。

## 9. 不做什么（防过度设计）

- 不做「模型自己觉得该改就改」——原文 3 节明确禁止；
- 不做自动改代码（那是 Relay）；
- 不把 North Star / E1 的指标另立一套（口径必须与 E1 的 19 项对齐）；
- 不新建第三套实验台账（复用 GKD 的实验表，见 §6）；
- 不在 S1 里顺手实现 H1 的 Reflection（那是 H1c）；
- 不让 canary 绕过人批准（`approved` 必须人/整合方确认）。

## 10. 待统筹拍板

1. **§6 的归属选择**（A 扩展 skill_candidates / B 新表 / **C 两层**）——这条不定，S1a 无法开工；
2. `experimenting` 是否复用 GKD 的实验表（建议复用）；
3. canary 的作用范围口径（按时间窗 / 按功能子集 / 按项目）；
4. 「已知稳定版本」的定义（上一个 `deployed` 版本？还是人工指定的基线？）。
