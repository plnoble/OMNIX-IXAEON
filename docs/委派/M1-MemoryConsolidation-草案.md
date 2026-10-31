# 规格草案 M1：Memory Consolidation —— 从「会检索」升级为「会记忆」（v1 草案）

> **新编号（用户 2026-10-29 定，见三周任务单「新编号映射」）**：M1a–M1d → **MC1a–MC1d**。老编号属于已完成的历史任务，不改；本文正文里的旧编号照此对应。

> **开工前置（用户 2026-10-30 定）**：可执行目标与记忆里的目标谁是权威、怎么引用，以 [G1 规格 §3.9](G1-GoalEngine-草案.md) 为准——`goals` 表是可执行目标的唯一权威；`items.type='goal'` 属记忆层，不同步；`research_topics.related_goal_id` 暂时照旧指向记忆条目；新目标与研究话题只经 `goal_links` 显式关联。本草案改稿时照此写进正文。

> **这是草案，不是生效规格。** dev2 按用户 2026-10-26《下一阶段主体能力开发任务书》大块二起草，
> 未进队列。G1（Goal Engine）三单还在整合方手里；本草案供周四一并复审。
> 只覆盖大块二；大块三（Reflection / Heartbeat）另写。

## 0. 现状核对（写草案前查过 main `6ccce28` 的事实）

`items` 表已经有这些轴，**M1 必须复用，不另起一套记忆系统**：

| 轴                   | 现值                                                                                                    | 与任务书的关系                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `project_summary` / `decision` / `rejected_option` / `open_loop` / `goal` / `constraint` / `preference` | Decision Memory ≈ `decision`（已有）；Identity ≈ `preference`+`constraint`（已有）；**Episodic / Semantic / Procedural 没有对应值** |
| `state`              | `current` / `disputed` / `superseded`                                                                   | 冲突处理三分法**已经存在**，直接沿用                                                                                                |
| `origin`             | `ai` / `user` / `work_result` / `research` / `assistant_suggestion`                                     | 「AI 建议 vs 用户决定分维」已有一半：另有 `confirmation`（`none`/`confirmed`/`rejected`）与 `said_by`                               |
| `supersedes_item_id` | 有                                                                                                      | 「新决定覆盖旧决定」已可表达                                                                                                        |
| `item_evidence`      | item ↔ segment（原文片段）                                                                              | 原始资料与证据链已存在（抽取器会留痕）                                                                                              |
| `corrections`        | old → user_text → new                                                                                   | 用户纠正的轨迹已有                                                                                                                  |
| `confidence`         | REAL 0..1                                                                                               | 衰减的载体，但目前**没有按时间衰减的计算**（只有 `temporal.ts` 的 ongoing/ended 判断）                                              |
| `skill_candidates`   | proposed→…→retired                                                                                      | 「IXAEON 学到的工作方式」**已有半个落点**                                                                                           |

**结论**：任务书要的五类分类里，三类已有承载；真正的新概念只有——**记忆簇（cluster）**、
**合成记忆（consolidated memory）与其生成过程**、**衰减/加权打分**。所以 M1 的重心是
「新增两样 + 接线」，不是重写 items。

## 1. 要什么

1. **值得记**：从原始事件里判出哪些信息应当长期保留（现在的抽取器已经在做，但没有「合成分」）；
2. **会演化**：同一件事跨数周、十几二十条 → 聚成簇，提取当前稳定事实，生成合成记忆；
   **原始记忆一律保留**（evidence linkage），可逐级追溯；
3. **分得清冲突**（三条规矩，沿用现有 `state`）：
   - 用户新决定覆盖旧决定：旧 `superseded`、新 `current`，走 `supersedes_item_id`；
   - AI 建议与用户决定冲突：**用户永远优先**——AI 那条不许压制用户那条；
   - 两份外部资料互相冲突：**不许自行选一个当真**，标 `disputed` 等证据；
4. **时间不是等权的**：recency / stability / 确认次数 / 用户确认 / 来源质量参与打分，
   但 **用户明确决定的分有地板**（decay floor），时间再久也不许掉到检索不到；
5. **问法分层**：「我现在的决定是什么」只给当前有效结论；「之前怎么考虑的」才展开演化史。

## 2. 为什么

现在的 Hybrid Memory 是「资料检索器」：找得到相关片段，但**没有「我现在关于 X 的立场是什么」这个对象**。
10~20 条重复/过时/AI 建议/用户拍板混在一起，全靠检索当下重排，问「现在的决定」答不干脆，
问历史也讲不清。记忆层的价值恰恰在**沉淀与演化**，这是任务书「主体智能层」的第二块。

## 3. 数据结构（契约草案）

### 3.1 `items` 的扩展（迁移只追加列，不改已发布迁移）

```sql
ALTER TABLE items ADD COLUMN kind TEXT
  CHECK (kind IS NULL OR kind IN ('raw', 'consolidated'));
-- raw：抽取器产的单条记忆（历史数据回填 'raw'）
-- consolidated：合成分；合成记忆仍是 item，检索/权限/隐私边界全部照旧走

ALTER TABLE items ADD COLUMN cluster_id TEXT;      -- 属于哪个簇（可空）
ALTER TABLE items ADD COLUMN decay_floor REAL;     -- 用户确认过的决定的分地板，可空=无保护
ALTER TABLE items ADD COLUMN confirmed_count INTEGER NOT NULL DEFAULT 0; -- 被再次确认的次数
```

**分类不新造一列枚举**，沿用 `type` 并把任务书五类映射清楚（写进文档与查询默认）：

| 任务书分类 | items 表达                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------- |
| Identity   | `type IN ('preference','constraint')` + `confirmation='confirmed'` 或 origin='user'，稳定态 |
| Episodic   | 新增 `type='episode'`（发生过的事件；这是**唯一必须的新枚举值**）                           |
| Semantic   | `type IN ('project_summary','goal','open_loop')` 当前态 + `kind='consolidated'`             |
| Decision   | `type='decision'`（已有；`rejected_option` 算它的反面）                                     |
| Procedural | `skill_candidates`（已有流程：proposed→approved→retired；M1 不动它，只接引用）              |

> ⚠️ 五类里四类已有承载是刻意的：**分类是视图，不是五套新存储**。任务书说「至少增加逻辑分类」，
> 逻辑分类用映射表达，避免 items/skills 两边再堆一套平行枚举。

### 3.2 新表 `memory_clusters`

```sql
CREATE TABLE memory_clusters (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- 可空 = personal/unassigned 的簇
  topic TEXT NOT NULL,             -- 人读得懂的簇标题（「FAEX1 设备规划」）
  consolidated_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_consolidated_at TEXT        -- 上次合成时间；NULL=从没合成过
);
CREATE INDEX idx_clusters_project ON memory_clusters(project_id, updated_at);

-- 簇成员：原始 item ↔ 簇（多对一）；不复制内容，只留关系
CREATE TABLE memory_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES memory_clusters(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (cluster_id, item_id)
);
```

**演化史 = 簇内全体成员按时间 + `supersedes_item_id` 链**，不需要单独的历史表——
旧决定行还在 items 里（`state='superseded'`），这就是任务书要的「底层仍可追溯」。

### 3.3 合成记忆（consolidated item）

- `kind='consolidated'`，`type` 按内容选（多半是 `project_summary` / `decision`）；
- `item_evidence` 指向**簇内成员的 segment**（复用现有证据链，不新建证据表）；
- 簇内容再次变化时：**旧的合成分 `superseded`，新合成分 `supersedes_item_id` 指旧合成**——
  合成层自己也在演化，每一层都能往下追溯。

## 4. Consolidation Job（后台，不改原始资料）

1. 触发：新增 job kind `memory-consolidation`（走现有 JobQueue，退避/审计沿用）；
   默认低频（每日/每 N 条新记忆触发一批），**不随每轮对话跑**；
2. 流程：候选簇（同一项目/主题、近 K 天、成员 ≥ N）→ **聚类**（先复用现有语义索引相似度 +
   type/项目约束，不新造聚类算法）→ 把**簇成员的 statement + evidence + 时间**交给核心模型
   （`AppRuntime.getProvider()`，即后台分析那个），产出：
   - 当前稳定事实（≤ 若干条 statement）；
   - 每条的证据成员 id 列表；
   - 冲突标记（哪些成员互相矛盾、属哪类冲突）；
3. 落库：生成 `kind='consolidated'` item + 簇成员关系 + `item_evidence` 链；
4. **合成不删除、不改写任何原始 item**；原始 item 的 `state`/`supersedes_item_id` 由 4.1 规则维护，不由模型随意动；
5. **没有配核心模型 / 模型出错 → 这一轮不合成，记日志，不挡任何现有功能**（同 D5b 的「不挡任务」原则）；
6. 发给模型的内容过 `hideWorkspacePath` 等既有隐私出口；不夹带其他项目的记忆（个人记忆隔离原则不变）。

### 4.1 冲突规则（决定 items 状态的动作，写死）

| 情况                             | 动作                                                                                       | 依据                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 用户新决定 vs 旧决定             | 旧 → `superseded`，新 → `current`，`supersedes_item_id` 串链                               | 任务书；现有机制已有                                |
| AI 建议 vs 用户决定              | **用户赢**；AI 那条标 `needs_review`，不 `superseded` 用户的；也不许拿 AI 建议压制用户记忆 | `assistant_suggestion`/`isWatchableMemory` 已有先例 |
| 两份外部资料冲突                 | 谁都不 `superseded`；双方 `disputed` + 一条「等什么证据」的 note；检索时如实带出 disputed  | 任务书「不能自行选一个当真」                        |
| 模型在合成里想直接改原始条目状态 | **拒绝写入**：合成 job 对原始 item 只读；状态动作只走上面三条代码路径                      | 防「模型自改史」                                    |

### 4.2 时间衰减与加权（打分，不是删除）

排序分 = `base(confidence) × 时间因子 × 权重`，其中：

- 时间因子：`recency`（observed_at/updated_at）+ `stability`（多次确认升、长期未再确认降）；
- `confirmed_count` 与 `confirmation='confirmed'` 加分；
- 来源质量：`origin` 排序 user > work_result > research > ai/assistant_suggestion（沿用现有优先级精神）；
- **地板**：`confirmation='confirmed'` 且 `type='decision'` 的记忆 `decay_floor = 0.6`（数值待定），
  **时间再久也不会掉出检索**；
- 衰减只改**排序**，**绝不改 state、绝不删除**。`shelved_at`/人工淘汰仍是唯一「不在场」机制，
  删除永远走既有「先备份/人工批准」路径。

## 5. 检索接口分层（「现在的」vs「之前怎么考虑的」）

- 现有 hybrid search 默认：同簇只出**当前合成分**一条代表（其余 raw 折叠，可展开），
  disputed 带标记原样出现——回答「我现在的决定是什么」；
- 新增只读接口 `clusterHistory(clusterId)`：按时间返回成员 + supersede 链 + 证据 excerpt——
  回答「之前怎么考虑的」；界面入口 = 合成分卡片上的「看演化史」（UI 归哪单一并定）。
- 上下文选择器（contextSelector）同步：喂给模型的长期记忆优先合成分，省 token 且立场唯一。

## 6. 验收条件（逐条可测；写测试时按此展开）

1. 分类映射：查 Identity/Decision 能命中既有 `type`+`confirmation` 组合，**不新增存储枚举**（episode 除外）。
2. 合成不伤原件：跑一次 consolidation，簇内原始 item 的 statement/state/evidence **逐字段不变**；
   新合成分 `kind='consolidated'`，evidence 指回成员。
3. 演化可追溯：合成 → 内容再变 → 新合成 `supersedes` 旧合成；旧合成分行仍在；两代证据链都能查到。
4. 用户新决定覆盖旧决定：旧 `superseded`、新 `current`、链正确；**corrections 表记轨迹**。
5. AI 建议不压用户决定：同时存在冲突的 ai 建议与 user 决定 → 检索答案取 user；ai 那条 `needs_review`。
6. 外部资料互斥不武断：两份 research 冲突 → 双方 `disputed`，无一方被 superseded；检索如实带标记。
7. 合成 job 改原始 item 状态被拒（直接调用注入路径抛错、不写库）。
8. 衰减地板：给一条 8 周前 `confirmation='confirmed'` 的 decision，打分后**仍在 top 结果**；
   对比同等条件的 `origin='ai'` 记忆可以掉出。
9. 衰减不删不改状态：跑过衰减重排后全库 `state` 计数与行数不变。
10. 「现在的」查询只出一个立场：跨周 12~20 条同主题场景里问「我现在的决定是什么」→ 结果只含当前有效结论；
    问「之前怎么考虑的」→ `clusterHistory` 返回完整演化（含被 superseded 的旧决定与理由）。
11. 没配核心模型 / 模型抛错：不合成、不崩、不影响现有检索；日志写明原因。
12. 发给模型的簇内容不含其他项目记忆、不含工作区绝对路径（替身模型断言收到的文本）。
13. 重复确认升权：同一事实被用户再确认 N 次 → `confirmed_count` 增加、排序分上升（或不再被合成判为过时）。

## 7. 约束

- 迁移只追加（3 列 + 2 表 + `episode` 枚举扩展——SQLite 改 CHECK 要重建表，**这块写法由整合方定**，见第 9 节）；
- 不新造记忆存储层；不新造聚类算法（先用现有语义索引）；不新造证据表；
- 合成只读原始 item；删除/淘汰机制不变（本单不新增任何删除路径）；
- 发给模型的提示词属新的外发 + 改变记忆含义 → **整单 B 档**；
- 不动 `skill_candidates` 的评审流程；Procedural 先只做「映射 + 引用」。

## 8. 拆分与尺寸（预估）

| 单      | 内容                                                                                 | 预估      | 档位              | 依赖    |
| ------- | ------------------------------------------------------------------------------------ | --------- | ----------------- | ------- |
| **M1a** | items 扩展列（迁移）+ kind/cluster 字段 + `episode` 类型 + `clusterHistory` 只读接口 | 约 180 行 | B（迁移）         | 无      |
| **M1b** | 簇表 + 候选聚类（复用语义索引）+ 合成 job（提示词 + 落库 + 冲突三条规则）            | 约 290 行 | B（外发/提示词）  | M1a     |
| **M1c** | 打分/衰减（含地板）接入 hybrid search 与 contextSelector                             | 约 200 行 | B（改变记忆含义） | M1a     |
| **M1d** | 检索折叠展示 + 「看演化史」入口（界面）                                              | 约 250 行 | A                 | M1a–M1c |

每单 ≤300 行；合计约 920 行。

## 9. 需要整合方拍板的事（别在实现里发明）

1. `type` 加 `episode` 值 = 改 CHECK → **SQLite 需重建表**：重建写法、是否干脆把五类做成独立
   `memory_kind` 列（不动旧 CHECK）——整合方定。草案先写「重建」。
2. `decay_floor=0.6`、`recency` 半衰期、簇成员数 N、K 天窗口：**这些数值必须有真实用例校准**，
   没校准前写成常量 + TODO，不许凭手感调成「看起来对」。
3. 合成分的 `type` 归属（project_summary 还是 decision）与 disputed 时合成分是否照样生成。
4. Procedural 是否长期就该住 `skill_candidates`（我倾向是；若是，任务书里的 Procedural 不再是新存储）。

## 整合方审稿（2026-10-29）

**结论：方向通过，M1a/M1b 改完下面几处后可以进 B 档；M1c 等 E1a 的埋点有了基线再做；M1d 最后。** 先查现有 `items` 再动手、分类做成视图不另起存储、合成不改原件，这几条都对。

第 9 节四件，整合方定：

1. **不重建 `items` 表、不往旧 `type` 的 CHECK 里加 `episode`**（用户 2026-10-29 确认保留此前已定架构）。逻辑分类用**一列独立、可空的 `memory_kind`**（自己的 CHECK，不碰旧 `type`），五类分类靠它和既有 `type`/`confirmation` 组合表达，不建第二套记忆存储；历史数据 `memory_kind` 可为空。§3.1 的 `kind`（raw/consolidated）与 `memory_kind` 是两件事，规格里分开写清。
2. **数值（`decay_floor`、半衰期、簇成员数 N、K 天窗口、相似度门槛）一律写成可配置的默认值**，代码和文档里标「未校准」；验收只测性质（地板保住、确认次数升权、衰减不改状态），**不许钉具体数字**——这正是 ModelPool 的教训。校准等 E1 的真实数据。
3. **合成记忆的 `type`**：簇只在同一 `type`、同一项目里聚，合成分沿用成员的 `type`。簇里有外部资料冲突时照样生成合成分，正文写明冲突、`state='disputed'`。
4. Procedural 长期住 `skill_candidates`，M1 不动它。

另外两处必须写死：

- **§4.1「AI 建议 vs 用户决定」里的 `needs_review` 不是现有状态**（`state` 只有 current/disputed/superseded），要改。不加新状态：AI 那条保持原状态，靠检索层规则「同簇有用户决定时，回答『现在的决定』只取用户那条」，并记一条审计。**AI 建议不得压过用户决定，冲突与证据历史不得丢失**（AI 那条、它的证据、冲突的审计都留着，`clusterHistory` 查得到）。测试按这个写。
- **M1b 的聚类规则和合成提示词要逐字写进规格**（B 档：发给模型的提示词）：用现有语义索引的相似度、超过门槛（可配置）就进同一簇，同项目、同 `type`；提示词原文、模型返回的 JSON 结构、返回不合格时怎么办。
