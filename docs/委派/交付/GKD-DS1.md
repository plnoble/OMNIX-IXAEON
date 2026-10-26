# 交付：DeepSeek Distillation Phase 1（研究阶段）

> 用户 2026-10-26 任务书「ixaeon × DeepInfer / deepseek-recipe 研究蒸馏与能力吸收」。
> 本轮严格按 §32 执行：**P0 基线 → DeepInfer → recipe → 能力提取 → Capability Graph → Gap Analysis → Adoption Matrix → RFC**，
> 且**Adoption Matrix 完成前未改任何生产代码**（§32 硬要求）。

## 一、完成内容

| 产物                | 文件                                                     | 说明                                                            |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| P0 源码事实基线     | `docs/research/deepseek/README.md`                       | 6 个仓库钉 commit + license；**记录两处与任务书不符的事实**     |
| DeepInfer 能力地图  | `docs/research/deepseek/deepinfer/capability-map.md`     | 10 项能力（C1–C10），逐条 `repo@commit:path`                    |
| recipe 架构分析     | `docs/research/deepseek/recipe/architecture.md`          | Conversation IR 实证形态、`ET_` 机制、V4/V4.1 差异、流式        |
| ixaeon Gap Analysis | `docs/research/deepseek/adoption/ixaeon-gap-analysis.md` | 8 个 gap（G1–G8），全部带我们自己 `文件:行`                     |
| Adoption Matrix     | `docs/research/deepseek/adoption/adoption-matrix.md`     | 19 项判定：ADOPT 2 / ADAPT 7 / REFERENCE 6 / DEFER 2 / REJECT 4 |
| Do Not Copy List    | `docs/research/deepseek/adoption/rejected-ideas.md`      | 五类禁抄 + 8 条引入准则                                         |
| Top 10 Lessons      | `docs/research/deepseek/adoption/top10-lessons.md`       | 每条第 5 要素齐全                                               |
| 3 份 RFC            | `docs/research/deepseek/adoption/rfc-proposals.md`       | IR / ReasoningState / ModelCapabilities                         |
| GKD 设计稿          | `docs/design/github-knowledge-distillery.md`             | 上一包产物，本轮自审修正表数量口径（4→5 表）                    |

## 二、修改文件

**仅新增 8 个文档，零源码改动**（符合 §32「Adoption Matrix 前禁止大改主代码」）：

```
docs/design/github-knowledge-distillery.md          (新增, 362 行)
docs/research/deepseek/README.md                    (新增, 176 行)
docs/research/deepseek/deepinfer/capability-map.md  (新增, 115 行)
docs/research/deepseek/recipe/architecture.md       (新增, 125 行)
docs/research/deepseek/adoption/ixaeon-gap-analysis.md (新增, 158 行)
docs/research/deepseek/adoption/adoption-matrix.md  (新增, 70 行)
docs/research/deepseek/adoption/rejected-ideas.md   (新增, 65 行)
docs/research/deepseek/adoption/top10-lessons.md    (新增, 139 行)
docs/research/deepseek/adoption/rfc-proposals.md    (新增, 约 150 行)
```

## 三、架构决定

1. **分层吸收**（Layer A/B/C）：只把 5 项列入「立即吸收」，其余要么只留知识、要么先写 RFC。
2. **不重复造**：结构化的 zod 校验、审计 `recordAudit`、JobQueue 退避 **明确判定为已有**，不重做。
3. **确定性优先**：把 `seed` + 能力声明放在 P0——因为**没有它们，任何「改进」都无法被验证**。
4. **ReasoningState 提为 P0**：这是我们**真实踩过**的坑（任务书 §9），价值高于表内多项。
5. **不碰推理引擎形态**：batch-invariant / 异步调度 / EP 只取思想，不实现（我们没有推理引擎）。

## 四、测试结果

- `node scripts/verify.mjs`：**全部通过**（本批纯文档，门禁未受影响）。
- 三个提交：`2b789f8`（P0+能力地图）→ `407752c`（recipe+gap+matrix）→ `b7573b8`（lessons+rejected）→ 本批（RFC+验收对照）。

## 五、未解决问题（据实）

1. **任务书两处前提与事实不符**（已写进 README §0，请统筹确认口径）：
   - `deepseek-ai` 组织下**无 TileLang**（真实为第三方 `tile-ai/tilelang`）；
   - DeepEP/DeepGEMM/FlashMLA/DeepSelect 在 DeepInfer 里是 **submodule 依赖**，不是并列研究对象。
2. **未做** `experiments/deepseek-recipe/` 隔离实验（§22.D 允许）——需统筹确认是否要立，涉及跑 recipe 的 Python/Rust 绑定。
3. **未逐文件细读** recipe 全部 24 个协议文件（集中在 IR/reasoning/tools/tokenizer/stream 五面）。
4. **Capability Graph 未单独成文**：结论已散在 ability-map 与 adoption-matrix，若统筹要求独立「能力图谱」文档，需再补。
5. **RFC 三份均未实现**（Proposed 状态），等统筹批准后再按 B 档流程推进（含新增提示词/能力声明属 B 档）。

## 六、下一工作包（建议）

按任务书 §32 顺序，研究阶段已完成；**实现阶段建议只做 RFC-002（ReasoningState）**，理由：

- 问题真实存在（已踩坑）、改动面积小（新增类型 + adapter 分支）、可直接写成验收测试；
- RFC-001（IR）与 RFC-003（能力声明）是它的前置，应一起做但**分三个小提交**；
- 按 B 档：先推测试 → 整合方锁定 → 再写实现。

## 七、commit SHA

- `2b789f8` research(deepinfer): establish source baseline
- `407752c` research(recipe): map protocol conversion architecture
- `b7573b8` research(deepinfer): document rejected ideas and lessons
- 本批：docs(distillation): add ixaeon RFC proposals and acceptance mapping
