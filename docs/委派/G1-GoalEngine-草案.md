# 规格草案 G1：Goal Engine —— 长期目标与计划系统

> **这是草案，不是生效规格。** 由 dev2 按用户 2026-10-25 的《下一阶段主体能力开发任务书》整理，
> 未经整合方审、未进队列、未定档位归属的拆分方式。用户看过、整合方周四复审时定稿之后才开工。
>
> 本草案只覆盖任务书「大块一：Goal Engine」。大块 2–5（Memory Consolidation、Reflection / Heartbeat、
> Long-term Agent Evaluation、Self-Improvement）另写。

## 0. 先说三件必须由人拍板的事

起草时发现三处任务书没写到、但不定就做不了的地方。**这三条不定，下面的契约都是悬的。**

### 0.1 名字冲突：`goal` 这个词已经被占了

- `coding_tasks.goal TEXT`：编码任务的**目标描述文本**（不是实体）。
- `todos.title`：待办就是一行字。
- 规格里 `Goal` 是**实体**（有 id、状态、进度、父子关系）。

**建议**：新表叫 `intents` 而不是 `goals`？——不，容易越改越乱。建议**表名就叫 `goals`，代码里类型叫 `Goal`**，
但所有文档和字段注释里必须写清「`coding_tasks.goal` 是文本，`goals` 是实体」，并且 **`coding_tasks` 加的是
`goal_id` 列（带下划线）**，不是复用 `goal`。这一点请确认。

### 0.2 谁来「确认」用户拍板

任务书要求：AI 识别的目标只能是 `proposed`，**用户明确拍板后才转 `active`**。

现在的系统里，聊天式拍板已有先例（T2b：聊天里提议的编码任务进待办，拍板即批准；拍板前先查待办状态）。
**建议照 T2b 的做法**：聊天里出现明确的批准/否决意图 → 走同一条「拍板」通路；并且 `userConfirmed` 字段
记录**是哪条消息**拍的板（`confirmed_by_message_id`），不能只有布尔值——不然复核时说不清谁批的。

### 0.3 Progress 怎么算，任务书给了四种，必须先定默认

任务书允许 weighted milestones / blocking tasks / manual progress / evidence-based progress。
**建议第一版只实现两种**，其余留字段不实现（免得像 `ModelPool` 那样字段齐全、值是编的）：

- `manual`：用户或整合方直接设一个数（`progress` 字段）；
- `weighted`：每个子目标/任务带权重，按已完成部分加权求和。

`evidence-based`（靠证据判定）和 `blocking`（阻塞项）第一版**只存字段、不计算**，等有真实用例再写。
请确认。

---

## 1. 要什么

在 Project / Todo / Coding Task / Research Task **之上**加一层「为什么做这件事」，并且：

1. 能记录长期目标、子目标（树）、目标当前采用的方案（Plan，**允许多版本**，旧版本保留）；
2. 能认得**从对话里冒出来的目标**，但只记成 `proposed`，用户拍板才 `active`；
3. 已有任务（Todo / Coding Task / Research Task）能挂到目标上，**不新造执行任务系统**；
4. 任务完成/失败时自动更新目标进度、标记受阻、提出替代方案；
5. 第一版界面只要「看得懂状态」，不做甘特图。

## 2. 为什么

任务书的判断：IXAEON 现在能执行任务，但不知道自己**为什么**执行、长期想去哪。没有这一层，
所有「主动推进」都只能靠当场判断，跨天就断了。这一层也是后面 Memory Consolidation / Reflection 的落点。

## 3. 核心数据结构（契约）

### 3.1 迁移（只追加，编号接在现有最后一号之后）

新表 `goals`：

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  -- 从哪来：用户直接说的 / AI 从对话里认出来的
  source TEXT NOT NULL CHECK (source IN ('user', 'agent')),
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'active', 'paused', 'blocked', 'completed', 'abandoned'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  target_date TEXT,
  next_review_at TEXT,
  -- 0..100，整数；manual 时直接就是这个值
  confidence INTEGER CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  -- 0.2.2：拍板是哪条消息拍的（说不清谁批的就不算数）
  confirmed_by_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  parent_goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_mode TEXT NOT NULL DEFAULT 'manual' CHECK (progress_mode IN ('manual', 'weighted')),
  blocked_reason TEXT
);
CREATE INDEX idx_goals_status ON goals(status, priority DESC, updated_at DESC);
CREATE INDEX idx_goals_parent ON goals(parent_goal_id);
```

新表 `goal_weight`（weighted 进度用；也是「这个目标下有哪些东西」的一张表）：

```sql
CREATE TABLE goal_weight (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  -- 绑到本目标下的子目标 / 任务
  kind TEXT NOT NULL CHECK (kind IN ('subgoal', 'todo', 'coding_task', 'research_topic')),
  ref_id TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  PRIMARY KEY (goal_id, kind, ref_id)
);
```

新表 `goal_plans`（**多版本，不覆盖**）：

```sql
CREATE TABLE goal_plans (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'abandoned')),
  superseded_by INTEGER,
  PRIMARY KEY (goal_id, version)
);
```

**已有任务的绑定**（不新造表、不改字段含义）：照 `todos.linked_kind/linked_id` 的既有做法，
用 `goal_weight` 这一张表表达「这个任务为哪个目标服务」，不需要给 `coding_tasks` / `todos` 加列。

> 任务书原文写的是「现有 Task 加 goalId / subgoalId / planVersion 字段」。**建议改成上面这种外挂表**：
> ① 三张任务表（todo / coding_task / research_topic）都要加列，改三处、还要处理历史行；
> ② 一个任务将来可能同时服务两个目标，加列就写死一个；
> ③ `todos` 当初就是这么设计的（薄的一层，`linked_*` 指过去）。**这条请确认**。

`plan_version` 那部分：绑定时可记「当时用的是哪一版方案」，放在 `goal_weight` 加一列 `plan_version INTEGER`。

### 3.2 状态机

```
proposed ──拍板──> active ──┬──> paused ──> active
                            ├──> blocked ──> active
                            ├──> completed
                            └──> abandoned
proposed ──否决──> abandoned
```

契约：

1. `proposed → active` **只能**由用户拍板触发，且必须写 `user_confirmed = 1` 和 `confirmed_by_message_id`。
   AI 自己不能把任何目标改成 `active`（包括「看起来很确定」的）。
2. `active → blocked` 由自动跟踪触发（见 3.4），必须同时写 `blocked_reason`；没有原因的 blocked 不许写。
3. `completed` 只能从 `active` 或 `blocked` 进；进 `completed` 时 `progress` 置 100。
4. `abandoned` 之后不许再回 `active`（要重开就新建一个目标并写明 `reason`）。

### 3.3 从对话识别目标

- 只产出 `status = 'proposed'`、`source = 'agent'` 的行；
- 标题必须能被用户看懂（不是模型内部措辞）；
- 同一个目标重复识别出来时，靠标题+来源去重，**不重复打扰**（照 `TodoStore.propose` 的做法：认出已有的就不再提；
  被否决过的目标，同样的事再提也不打扰）；
- **不发出去任何东西**：目标识别只用已有对话内容，不新增外发。

### 3.4 自动跟踪与 Progress

- 任务完成（todo done / coding_task completed / research_topic 完成）→ 重算该目标进度；
- `weighted` 模式：`progress = round(100 × Σ(已完成部分权重) / Σ(全部权重))`，没有绑任何东西的目标不进 `weighted`
  （退回 manual，不瞎算）；
- 任务连续失败（同一目标下 ≥2 个任务在最近 N 天内失败）→ 目标转 `blocked`，`blocked_reason` 写清是哪几个任务；
- **证据**：每次自动改状态都要能回答「凭什么」——写进审计（`audit_events`），带上是哪几个任务/哪条消息。

### 3.5 Replan

允许触发的六种情况（任务书原文）：任务连续失败、外部条件变化、模型/设备不可用、用户修改目标、长期无进展、原计划假设失效。

契约：

1. 生成新 Plan 时，**旧版本一律改成 `superseded` + `superseded_by = 新版本号`，内容一个字不删**；
2. 新 Plan 必须有 `reason`（为什么重规划）和 `assumptions`（这次假设了什么）；
3. 重规划**不改** `status`：`active` 的目标重规划之后还是 `active`（重规划不是状态迁移）；
4. 一个目标同一时刻只能有一版 `current`。

## 4. UI（第一版只做「看得懂状态」）

新增 Goals 页（与 Todos / Projects 同级入口）。列表显示：

| 列       | 说明                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 标题     | 点进去是详情                                                                           |
| 状态     | proposed / active / paused / blocked / completed / abandoned，`blocked` 要直接显示原因 |
| 进度     | 一条进度条 + 百分比；`blocked` 时显示「卡在哪」                                        |
| 子目标   | 「3 个子目标，1 个已完成」（不展开树）                                                 |
| 下次复核 | `next_review_at`，过期的标黄                                                           |
| 下一步   | 一句话建议（来自当前 Plan 的下一步）                                                   |

详情页：目标描述、子树、当前 Plan 的步骤、关联任务（带各自状态）、方案历史（版本列表，可看旧版）、审计记录。
**不做**甘特图、不做拖拽排序、不做依赖图。

`proposed` 的目标在列表顶部单独一块「AI 觉得你可能想要的目标（待你确认）」，带「确认 / 不是这个」两个按钮；
点「不是这个」→ `abandoned` 并记下（以后同样的事不再打扰）。

## 5. 验收条件（逐条可测，写成锁定测试）

务必要能覆盖任务书 1–10 条那个真实场景。条件写成测试文件
`packages/core/test/acceptance/g1-goal-engine.test.ts`（核心层）+ `apps/desktop/test/acceptance/g1-goals-page.test.ts`（界面）。

1. **建目标**：用户建一个长期目标 → 一行 `status = 'active'`、`user_confirmed = 1`、`source = 'user'`、
   有 `confirmed_by_message_id`。
2. **AI 提议只能是 proposed**：从对话识别出的目标 `status = 'proposed'`、`user_confirmed = 0`；
   **任何自动路径都改不成 active**（这条要单独有一个「企图绕过」的测试）。
3. **自动分解**：对一个 active 目标请求分解 → 生成 3～5 个子目标（`parent_goal_id` 指向它），
   父目标不因分解而改状态；子目标默认 `proposed`。
4. **挂真实任务**：把 2 个真实任务（1 个 coding task、1 个 todo）挂到目标上 → `goal_weight` 有 2 行；
   任务本身一行不改（`coding_tasks` / `todos` 的列不变）。
5. **完成一个任务 → 进度变化**：weighted 模式下，完成权重 1/3 的任务 → `progress` 从 0 变 33（四舍五入）；
   manual 模式下完成任务**不改** `progress`（手动值优先）。
6. **一个任务失败 → 标记 Blocker**：同一目标下两个任务失败 → `status = 'blocked'`、`blocked_reason` 含这两个任务号，
   并且写了一条审计记录。
7. **自动提出替代方案**：目标变 blocked 之后请求重规划 → 生成 `goal_plans` 第 2 版，
   第 1 版变 `superseded` 且 `superseded_by = 2`；**第 1 版的 steps 内容逐字仍在**。
8. **重启后还在**：关掉数据库连接、重开、重新读 → 目标、子目标、绑定、两版方案、审计全在。
9. **不同 Goal 不串状态**：两个目标各挂一个任务、各自完成一个 → 两个进度互不影响；
   一个 blocked 不影响另一个。
10. **状态机不许越界**：`proposed → completed` 被拒、`abandoned → active` 被拒、没有 `blocked_reason` 的 blocked 被拒。
11. **界面**：Goals 列表能显示 active 目标的状态/进度/下次复核；blocked 的目标在卡片上直接显示原因；
    `proposed` 的在顶部单独一块、点「不是这个」之后不再出现。

## 6. 约束

- 迁移**只追加**（新表），不改已有表结构、不改已发布迁移；
- **不新造任务系统**：任务仍由 Todo / CodingTask / ResearchTopic 承担；
- 发给模型的目标识别提示词属于「新的外发」（把对话内容发给模型）→ **这一条本身要单独评档位**；
- 不碰 Door / 模型池 / 自我升级（这些仍在「暂停」清单里，本单不涉及）；
- 界面不做甘特图、不做拖拽、不做依赖图。

## 7. 尺寸与拆分（预估）

| 块                                        | 预估源码行数   | 说明                    |
| ----------------------------------------- | -------------- | ----------------------- |
| 迁移 + 类型                               | 约 120         | 3 张新表                |
| `GoalStore`（增删改查、状态机、进度计算） | 约 260         | 核心                    |
| 自动跟踪接线（任务完成/失败 → 目标）      | 约 80          | 挂在已有任务状态变化处  |
| Plan 版本与 Replan                        | 约 120         |                         |
| 从对话识别（提示词 + 解析 + 去重）        | 约 150         | 新的外发                |
| IPC + preload + 契约类型                  | 约 60          |                         |
| Goals 页 + 详情页                         | 约 350         |                         |
| **合计**                                  | **约 1140 行** | 远超 300 行，**必须拆** |

**建议拆成 5 单**（每单 ≤ 300 行源码，各自有锁定测试）：

| 单      | 内容                                                                   | 依赖    |
| ------- | ---------------------------------------------------------------------- | ------- |
| **G1a** | 迁移 + `GoalStore`（含状态机与 manual/weighted 进度）                  | 无      |
| **G1b** | 任务绑定（`goal_weight`）+ 自动跟踪（完成/失败 → 进度/blocked + 审计） | G1a     |
| **G1c** | Plan 多版本 + Replan                                                   | G1a     |
| **G1d** | 从对话识别目标（**这条单独评档位：新外发**）                           | G1a     |
| **G1e** | Goals 列表页 + 详情页                                                  | G1a–G1d |

## 8. 真机检查

`scripts/real/g1-goal-engine.mjs`：临时数据目录、应用设 `IXAEON_DATA_DIR`、**合成数据**，走一遍
「建目标 → 分解 → 挂任务 → 完成一个 → 进度变 → 失败一个 → blocked → 重规划 → 关应用重开还在」，
输出贴进交付说明。不碰用户真实数据。

## 9. 待用户拍板的清单（共 6 条）

1. 表名叫 `goals`、`coding_tasks` 那边加 `goal_id`（不是复用已有的 `goal` 文本列）——**同意？**
2. 「用户拍板」是否照 T2b 的路子走聊天确认，并记 `confirmed_by_message_id`——**同意？**
3. 第一版只实现 `manual` + `weighted` 两种进度，`evidence-based` / `blocking` 只存字段——**同意？**
4. 任务绑定用外挂表 `goal_weight` 而不是给三张任务表各加列——**同意？**
5. 拆成 G1a–G1e 五单、按上面顺序做——**同意？**
6. `proposed → active` 只能靠用户拍板，AI 任何路径都不许——**同意？**（这条我认为没有商量余地，只是请你确认）
