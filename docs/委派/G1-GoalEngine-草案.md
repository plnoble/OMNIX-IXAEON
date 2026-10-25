# 规格草案 G1：Goal Engine —— 长期目标与计划系统（v2）

> **这是草案，不是生效规格。** dev2 按用户 2026-10-25《下一阶段主体能力开发任务书》起草，
> v2 已按用户 2026-10-25 的六条决定 + 三条补充修改重写。仍待整合方周四复审定稿、进队列。
>
> 只覆盖任务书「大块一」；大块 2–5 另写。

## 0. 用户已拍板的设计（不再重开）

| #   | 决定                                                                                 |
| --- | ------------------------------------------------------------------------------------ |
| 1   | 表名 `goals`；**不给 `coding_tasks` 加 `goal_id`**，统一走关联表                     |
| 2   | 聊天确认可以，但**不只支持聊天**——加 `confirmation` 维度，UI 明确操作也算确认        |
| 3   | 第一版只做 `manual` + `weighted`；**`evidence-based` / `blocking` 连字段都不造**     |
| 4   | 外挂关联表，**叫 `goal_links`**；**不用它表达子目标**（子目标只靠 `parent_goal_id`） |
| 5   | 拆 G1a–G1e；**G1e 基础界面在 G1a 之后就能做**，不必等 G1d                            |
| 6   | **AI 任何路径都不许把 `proposed` 改成 `active`**                                     |
| 7   | 失败**不机械判 blocked**：失败只产生信号，是否 blocked 要经判断                      |
| 8   | **来源（origin）与确认（confirmation）是两个独立维度**                               |
| 9   | Plan Step **独立成表**（顺序、状态、关联任务、依赖），不保留 JSON 作权威结构         |

### 0.1 确认规则（用户原话落成契约）

- **origin**：谁先提的 —— `user` / `agent`。**只记来源，不表示是否被确认。**
- **confirmation**：确认到什么程度 —— `pending` / `ui` / `chat` / `api`（后三者都算「用户明确确认」）。

| 怎么来的                                       | origin  | confirmation | status                         |
| ---------------------------------------------- | ------- | ------------ | ------------------------------ |
| 用户在界面点「新建目标」                       | `user`  | `ui`         | **`active`**                   |
| 调 API 明确创建                                | `user`  | `api`        | **`active`**                   |
| 用户聊天里说「我希望 IXAEON 能 24×7 自己工作」 | `agent` | `pending`    | **`proposed`**（只是表达想法） |
| AI 从对话里认出候选目标                        | `agent` | `pending`    | **`proposed`**                 |
| 用户对某个 proposed 说「这个要做」             | 不变    | `chat`       | **`active`** + 记消息号        |
| 用户点某个 proposed 的「确认」                 | 不变    | `ui`         | **`active`**                   |

**硬规矩**：`status = 'active'` 必须有 `confirmation != 'pending'`；`confirmation != 'pending'` 的目标
`status` 不能是 `proposed`。数据库 CHECK 与代码两处同时拦。

### 0.2 blocked 不靠数数（用户第 7 条）

**没有任何「N 个任务失败 → 自动 blocked」的规则。** 失败只做三件事：

1. 记进 `goal_events`（哪个任务、什么时候、为什么失败）；
2. 把 `next_review_at` 提前（表示「该看一眼了」）；
3. 界面上标「有疑点」（`watch`，**不是**状态）。

**是否转 `blocked`、理由写什么，由判断产生**：模型复核时提出、或用户直接点。
`blocked` 必须带 `blocked_reason`，事件里 `decided_by` 只能是 `agent` / `user`（**不能是 `system`**）。

## 1. 要什么

在 Project / Todo / Coding Task / Research Task **之上**加一层「为什么做这件事」：长期目标、子目标树、
目标当前采用的方案（多版本、旧版保留、**步骤是可操作结构**）、任务与目标的关联、进度、疑点与复核。
**不新造执行任务系统**。

## 2. 为什么

任务书的判断：IXAEON 能执行任务，但不知道自己为什么执行、长期想去哪。没有这一层，「主动推进」只能靠当场判断、
跨天就断。也是后面 Memory Consolidation / Reflection / Heartbeat 的落点。

## 3. 数据结构（契约）

### 3.1 `goals`（**属于 G1a**）

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  -- 维度一：谁先提的（不表示是否被确认）
  origin TEXT NOT NULL CHECK (origin IN ('user', 'agent')),
  origin_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  -- 维度二：确认到什么程度（pending = 还没被用户确认）
  confirmation TEXT NOT NULL DEFAULT 'pending'
    CHECK (confirmation IN ('pending', 'ui', 'chat', 'api')),
  confirmed_by_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, -- 聊天确认时才有
  confirmed_at TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'active', 'paused', 'blocked', 'completed', 'abandoned'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  target_date TEXT,
  next_review_at TEXT,
  confidence INTEGER CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),
  parent_goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
  -- 父子关系的权重属性（不是 goal_links 的活）：根目标可为 NULL，子目标默认 1，非 NULL 时必须 > 0。
  -- G1b 算父目标 weighted 进度时，直接子目标「完成」按它计一次；子目标内部的任务不重复计入父目标。
  parent_weight INTEGER CHECK (parent_weight IS NULL OR parent_weight > 0) DEFAULT 1,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_mode TEXT NOT NULL DEFAULT 'manual' CHECK (progress_mode IN ('manual', 'weighted')),
  blocked_reason TEXT,
  watch INTEGER NOT NULL DEFAULT 0 CHECK (watch IN (0, 1)), -- 有疑点，不是状态
  watch_reason TEXT,
  CHECK (status <> 'active' OR confirmation <> 'pending'),
  CHECK (status <> 'proposed' OR confirmation = 'pending'),
  CHECK (status <> 'blocked' OR (blocked_reason IS NOT NULL AND length(blocked_reason) > 0))
);
CREATE INDEX idx_goals_status ON goals(status, priority DESC, updated_at DESC);
CREATE INDEX idx_goals_parent ON goals(parent_goal_id);
CREATE INDEX idx_goals_review ON goals(next_review_at) WHERE next_review_at IS NOT NULL;
```

### 3.2 `goal_links`（**只管「目标 ↔ 已有任务」**；**属于 G1b**）

```sql
-- 不表达子目标（子目标只靠 goals.parent_goal_id）。一个任务可以同时服务两个目标。
CREATE TABLE goal_links (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('todo', 'coding_task', 'research_topic')),
  ref_id TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  plan_version INTEGER, -- 绑定时用的是哪一版方案（可空）
  created_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, kind, ref_id)
);
CREATE INDEX idx_goal_links_ref ON goal_links(kind, ref_id);
```

### 3.3 `goal_plans` + `goal_steps` + `goal_step_deps`（**属于 G1c**）

```sql
CREATE TABLE goal_plans (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'abandoned')),
  superseded_by INTEGER,
  PRIMARY KEY (goal_id, version)
);

-- Plan Step 是可操作结构：顺序、状态、能挂任务、能写依赖。Heartbeat 将来直接推进一步。
CREATE TABLE goal_steps (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0), -- 可重排；重排不动 id
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'doing', 'done', 'skipped', 'blocked'
  )),
  linked_kind TEXT CHECK (linked_kind IS NULL OR linked_kind IN ('todo', 'coding_task', 'research_topic')),
  linked_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (goal_id, plan_version) REFERENCES goal_plans(goal_id, version) ON DELETE CASCADE,
  UNIQUE (goal_id, plan_version, seq)
);
CREATE INDEX idx_goal_steps_plan ON goal_steps(goal_id, plan_version, seq);
CREATE INDEX idx_goal_steps_status ON goal_steps(status);

CREATE TABLE goal_step_deps (
  step_id TEXT NOT NULL REFERENCES goal_steps(id) ON DELETE CASCADE,
  depends_on_step_id TEXT NOT NULL REFERENCES goal_steps(id) ON DELETE CASCADE,
  PRIMARY KEY (step_id, depends_on_step_id),
  CHECK (step_id <> depends_on_step_id)
);
```

**契约**：`goal_steps` 是步骤的**权威结构**，`goal_plans` 不再有 `steps_json`。

### 3.4 `goal_events`（审计：凭什么改的；**属于 G1a**）

```sql
CREATE TABLE goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'created', 'confirmed', 'status', 'progress', 'plan', 'step',
    'task_failed', 'task_done', 'watch', 'note'
  )),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('user', 'agent', 'system')),
  ref_kind TEXT,
  ref_id TEXT,
  summary TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX idx_goal_events_goal ON goal_events(goal_id, at DESC);
```

**每次改 `status` / `confirmation` / `progress` / 方案版本，都必须有一条 `goal_events`。**

### 3.5 状态机

```
proposed ──用户确认──> active
proposed ──用户否决──> abandoned
active ─┬─> paused ──> active
        ├─> blocked（必须有 blocked_reason，事件 decided_by ≠ system）
        └─> completed（progress 置 100）
paused / blocked ──> active / abandoned
```

1. `proposed → active` 只能由用户确认触发（`confirmation` 从 `pending` 变成 `ui`/`chat`/`api` + 事件）。
   **AI 任何路径都不行**——包括模型直接调 store、重规划、进度重算。
2. `active → blocked` 必须有 `blocked_reason`，事件 `decided_by` 只能是 `agent` / `user`（**不能 `system`**）。
3. `blocked → active` 必须清空 `blocked_reason` 并记事件。
4. `completed` 只能从 `active` / `blocked` / `paused` 进；进入时 `progress = 100`。
5. `abandoned` 是终态：不许回 `active`（要重开就新建，`description` 写清为什么）。

### 3.6 Progress（**manual 属于 G1a；weighted 整块属于 G1b**）

- `manual`：`progress` 就是人给的值；任务完成/失败都**不改**它（只记事件）。
- `weighted`：分母 = 直接挂在该目标上的任务权重（`goal_links.weight`）之和
  **+ 直接子目标的 `parent_weight` 之和**；分子 = 已完成任务与已完成子目标的对应权重之和；
  `progress = round(100 × 分子 / 分母)`；**分母为 0 → 保持原值**（不瞎算成 0）；
  **直接子目标完成后按子目标自身的 `parent_weight` 计入直接父目标一次**；
  子目标内部的任务不重复计入父目标（它们只算子目标自己的进度）。

### 3.7 从对话识别目标

- 只产出 `origin = 'agent'`、`confirmation = 'pending'`、`status = 'proposed'`；
- **聊天里用户表达愿望 ≠ 确认**：就算用户说「我希望……」，也只是 `proposed`；
- 去重照 `TodoStore.propose`（认出已有的不重复提；被否决过的不再打扰）；
- **这一条是新的外发**（把对话内容发给模型），单独评档位。

### 3.8 Replan

1. 新版本 → 旧版本 `status = 'superseded'`、`superseded_by = 新版本号`，**旧的行一个字不删**；
2. 新版本必须有 `reason`；`assumptions_json` 写这次假设了什么；
3. 一个目标同一时刻只能有一版 `current`；
4. 重规划**不改 `status`**；
5. 新版本的 `goal_steps` 由旧版本复制（`status` 重置 `pending`，`linked_*` 保留），`goal_step_deps` 同步复制。

## 4. UI（第一版只做「看得懂状态」）

**Goals 列表页（G1e 只依赖 G1a）**：标题、状态徽章、进度条、子目标数、下次复核（过期标黄）、
**疑点标记**（`watch` 单独标出，点开看 `watch_reason`）、下一步（当前方案里第一个 `pending` 且依赖已满足的步骤）。
`blocked` 的卡片直接显示 `blocked_reason`。

**顶部单独一块**「AI 觉得你可能想要的目标（待你确认）」：`proposed` 的行 + 「确认 / 不是这个」两个按钮。

**详情页**：描述、子目标树（点进去，不画图）、**当前方案的步骤列表**（每步带状态，可手动改）、
方案历史（能看旧版本，只读）、关联任务（能跳过去）、事件时间线。
**不做**甘特图、拖拽排序、依赖图。

## 5. 验收条件（按单切分，各单可独立锁定、独立实现）

**切分原则（用户 2026-10-25 定）**：不允许「名义拆单但 G1a 已经把 G1b/G1c 的接口和表一起钉死」。
每一单的测试只能引用**本单自己引入的表和接口**；跨单的东西用「测试内部用真实 Store 造数据」，
不得为了测试给生产接口开后门。

| 单  | 测试文件                  | 只允许引用的表                                          | 只允许引用的接口                                                         |
| --- | ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| G1a | `g1a-goal-store.test.ts`  | `goals`、`goal_events`                                  | `GoalStore`（create/get/childrenOf/confirm/transition/setProgress/list） |
| G1b | `g1b-goal-links.test.ts`  | G1a 的两张 + `goal_links`                               | G1a 的 + `link/unlink/recomputeProgress`                                 |
| G1c | `g1c-goal-plans.test.ts`  | G1a 的两张 + `goal_plans`/`goal_steps`/`goal_step_deps` | G1a 的 + `PlanStore`                                                     |
| G1d | `g1d-goal-detect.test.ts` | G1a 的两张                                              | G1a 的 + 识别器                                                          |
| G1e | `g1e-goals-page.test.ts`  | 读，不写结构                                            | 界面                                                                     |

### G1a：Goal 核心（`goals` + `goal_events` + `GoalStore`）

1. **迁移只加两张表**：`goals`、`goal_events` 在；**`goal_links` / `goal_plans` / `goal_steps` / `goal_step_deps` 一张都不许有**（这条要单独断言，防止 G1a 偷偷把后面几单的表也建了）。
2. `goals` 的列：`id/title/description/origin/confirmation/confirmed_by_message_id/confirmed_at/status/priority/created_at/updated_at/target_date/next_review_at/confidence/parent_goal_id/parent_weight/progress/progress_mode/blocked_reason/watch/watch_reason`；
   **没有** evidence / blocking / milestone 相关列。
3. **`coding_tasks` / `todos` / `research_topics` 结构完全不改**（`PRAGMA table_info` 逐列比对；`coding_tasks.goal` 仍是文本）。
4. **origin × confirmation 正交**：
   - UI 创建 → `origin='user'`、`confirmation='ui'`、`status='active'`；
   - API 创建 → `user`/`api`/`active`；
   - 聊天表达想法 → `agent`/`pending`/`proposed`（**哪怕听起来很确定**）；
   - `origin=agent` 能被 `ui` 确认（来源不变、确认方式变）；`origin=user` 也能走 `chat` 确认（记消息号）。
   - 数据库层：手写 SQL 造 `active + pending` 被 CHECK 拒。
5. **proposed 不能被 AI 激活**（分层不变量的 G1a 那一层）：`transition(proposed → active, decidedBy='agent')` 必须拒。
6. **状态机**：`proposed→completed` 拒；`abandoned→active` 拒；`blocked` 没有 `blocked_reason` 拒；
   `blocked` 的事件 `decided_by` 只能是 `agent`/`user`；`blocked→active` 清空理由并记事件；`completed` 时 `progress=100`。
7. **非法迁移事务回滚不残留 `goal_event`**：连续几次非法迁移全抛错后，`goal_events` 一行都没多。
8. **manual progress**：`setProgress` 存进去就是那个值；**G1a 不计算任何进度**（没有 `recomputeProgress`）。
9. **`progress_mode='weighted'` 允许保存**，但 G1a 不算它——存进去读出来还是那个模式、`progress` 保持原值。
10. **父子**：`parent_goal_id` 建树、`childrenOf` 能取到；根目标 `parent_weight` 可为 NULL、子目标默认 1、传 0 或负数被拒。
11. **重启后仍在**；**不同 Goal 不串状态**（一个 blocked 不影响另一个）。

### G1b：关联与 weighted 进度（`goal_links` + 任务状态读取）

12. **迁移只加 `goal_links`**；`kind` 只能是 `todo`/`coding_task`/`research_topic`（**不许出现 `subgoal`**、不许用 `refId='goal:xxx'` 绕）。
13. **挂真实任务**：用**真实的** `TodoStore` / `CodingTaskStore` 建任务再挂——**测试内部用真 Store，不靠 `setRefDone` 这种后门**；`goal_links` 有行、任务表列不变。
14. **一个任务挂两个目标**：两行；A 完成它不影响 B 的进度。
15. **weighted 计算**：3 个等权任务完成 1 个 → 33、完成 2 个 → 67；分母 0 → 保持原值。
16. **子目标按 `parent_weight` 计一次**：子目标完成后父目标按 `parent_weight` 计；**子目标内部的任务不重复计入父目标**。
17. **失败产生信号但不改状态**：2 个任务失败 → `status` **仍 active**，但 `watch=1`、`watch_reason` 写明是哪两个、`next_review_at` 提前、`goal_events` 有 2 条 `task_failed`。
18. **blocked 要判断**：复核给出结论后写 blocked 成功（`decided_by='agent'`）；`system` 直接写 → 抛错。
19. **proposed 不能被激活**（分层不变量 G1b 那一层）：自动跟踪、进度重算跑完，proposed 仍是 proposed。

### G1c：方案与步骤（`goal_plans` + `goal_steps` + `goal_step_deps` + `PlanStore`）

20. **迁移只加三张方案表**；`goal_plans` **没有 `steps_json` 列**（Step 是权威结构）。
21. **多版本**：重规划一次 → 2 行；第 1 版 `superseded` + `superseded_by=2`；第 1 版 `goal_steps` **逐行仍在**。
22. **Step 可操作**：4 步各有 `seq`/`status`/可选关联任务；改某步 `status='doing'` 只动这一行。
23. **两阶段重排**：重排后 **ID 集合不变、依赖不变、任务绑定不变、行数不变**（证明不是删了重建），只有 `seq` 变；
    传重复 id → 整体失败、`seq` 保持原样（单事务）；重排不重置状态。
24. **依赖**：A 依赖 B → B 未完成时 A 不能进 `doing`；成环写入被拒。
25. **`advanceStep` 给 Heartbeat 用**：依赖已满足的 pending → `doing` 并写 `started_at`。
26. **proposed 不能被激活**（分层不变量 G1c 那一层）：`replan` / `advanceStep` 跑完，proposed 仍是 proposed。

### G1d：从对话识别（只产出 proposed）

27. 只产出 `origin='agent'`/`confirmation='pending'`/`status='proposed'`（**分层不变量 G1d 那一层**）。
28. 去重：同一个目标再识别一次不重复建；`abandoned` 过的同样的事不再提。
29. **不外发别的**：发给模型的 user 文本里只有对话内容，不夹带记忆、项目文件（用替身模型断言）。

### G1e：界面（A 档；**等 G1a 锁定后再做，现在不提前钉 UI 数据接口**）

30. 列表显示 active 目标的标题、状态、进度、下次复核；过期复核标黄。
31. blocked 卡片直接显示 `blocked_reason`；有 `watch` 的单独标出并显示 `watch_reason`。
32. `proposed` 在顶部单独一块，点「确认」→ 变 active 并消失；点「不是这个」→ 不再出现。

## 6. 约束

- 迁移**只追加**；不改已有表结构；**不给 `coding_tasks` / `todos` 加列**；
- 不新造任务系统；
- `evidence-based` / `blocking` 相关字段、枚举值、代码**一律不造**；
- 不碰 Door / 模型池 / 自我升级；
- 界面不做甘特图 / 拖拽 / 依赖图；
- G1d 的提示词是新的外发，单独评档位。

## 7. 拆分、档位与依赖（用户 2026-10-25 定）

| 单      | 档位  | 内容                                                                                                      | 预估行数 | 依赖                           |
| ------- | ----- | --------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| **G1a** | **B** | 迁移 `goals` + `goal_events`；`GoalStore`：create/confirm/transition/setProgress/childrenOf/list          | 约 250   | 无                             |
| **G1b** | **B** | 迁移 `goal_links`；任务真实状态读取；weighted 进度；`task_done`/`task_failed` 事件；watch；next_review_at | 约 230   | G1a                            |
| **G1c** | **B** | 迁移 `goal_plans`/`goal_steps`/`goal_step_deps`；`PlanStore`；Replan；`advanceStep`；两阶段重排           | 约 290   | G1a                            |
| **G1d** | **B** | 从对话识别目标（新外发）                                                                                  | 约 180   | G1a                            |
| **G1e** | **A** | Goals 列表页 + 详情页（**等 G1a 锁定后再做**）                                                            | 约 300   | G1a（读 G1b/G1c 的数据时再加） |

**档位理由**：G1a/G1b/G1c 都**涉及数据库迁移**，按规矩是 B 档；G1d 是**新的外发**，B 档；只有 G1e 是纯界面，A 档。
五单合计约 1250 行，每单都在 300 行以内。

**每单必须能独立锁定、独立实现**：G1a 的测试只碰 `goals`/`goal_events`/`GoalStore`；
G1b 才引入 `goal_links`；G1c 才引入三张方案表。**任何一单的测试不许引用别的单还没引入的表和接口。**

## 8. 真机检查

`scripts/real/g1-goal-engine.mjs`：临时数据目录、`IXAEON_DATA_DIR`、**合成数据**，走一遍
「建目标 → 分解 → 挂两个任务 → 完成一个（进度变）→ 失败两个（watch 亮、不 blocked）→ 复核判 blocked →
重规划（旧版保留）→ 推进一个步骤 → 关应用重开还在」，输出贴进交付说明。

## 9. 已定案（不再待定）

1. **`goal_steps.seq` 采用可重排方案**（用户 2026-10-25 定）：
   - Step **ID 永久稳定**（重排不动 id）；
   - 重排**在单个事务里**做；
   - **使用两阶段临时序号**（先把本版方案的 `seq` 整体挪到临时区，再回填最终序号），避免撞 `UNIQUE(goal_id, plan_version, seq)`；
   - **不允许删除重建 Step**（依赖、任务绑定、状态都挂在 Step 上，删了就丢）。
2. 档位见第 7 节：G1a/G1b/G1c/**G1d** = B，G1e = A。
3. 子目标与父目标的权重用 `goals.parent_weight`（不是 `goal_links`，也不是 `refId='goal:xxx'`）。
4. 任务完成/失败的真值来源永远是 `TodoStore` / `CodingTaskStore` / `ResearchTopicStore` 自己；
   **不许为了测试在 `GoalStore` 上开「标记完成」这类产品接口**。
