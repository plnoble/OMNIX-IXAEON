# GitHub Knowledge Distillery / Refinery —— 设计（v1，2026-10-26）

> 状态：**设计稿，未开工**。按工作包 §26，第一步只交这份文档 + 自审；§27 的 GKD-1 待本文定稿后启动。
> 本文以 main `4b87d81` 的真实代码为准，每条复用点都带 `文件:行` 证据。**不允许凭空设计**——凡引用的机制都在仓库里核过。

---

## 0. 一句话定位

把外部开源世界的**工程思想**（不是代码、不是仓库、不是 RAG 语料）蒸馏成 IXAEON 自己**经实验验证、可复用、可反校、带来源**的能力，沉进已有的能力原语。

核心不变量（贯穿全文，也是验收红线）：

```
Evidence（repo/commit/file/license）
   → Pattern（问题+核心思想+取舍+适用/不适用，无代码正文）
   → Experiment（PASS 才准下一步）
   → Capability（= 复用 skill_candidates，不新建库）
   → Evolution（新版本不覆盖旧版本；实际开发结果反向改 confidence）
```

---

## 1. 当前 IXAEON 可复用基础设施（逐条带证据）

设计前先盘清家底。下面每一条都是**已存在、本工作包必须复用**的机制，不是待建的。

### 1.1 后台任务：JobQueue（复用，不新建队列）

- `packages/core/src/jobs/jobQueue.ts:39` `class JobQueue`：`register(kind, handler)`（:69）、`enqueue(kind, payload)`（:73）、`start(intervalMs=300)`（:95）自带轮询循环。
- 已有退避重试：`DEFAULT_RETRY_BACKOFF_MS`（:22）、`maxAutoRetries`（:66）、`retry_count` 列。
- 已有并发/让路语义：`jobs` 表按 kind 去重排队（:285）、「后台任务给聊天让路」（:204）、`extract` kind 的重试查询（:325/375）。
- **结论**：Distillery 的每一阶段（Scout / Evaluate / Analyze / Extract / Synthesize / Experiment）= 注册成 JobQueue 的新 `kind`，**零新调度器**。
- **注意（诚实）**：现有 job 都是「事件触发入队」，**没有周期性 job 的先例**。Distillery 若要「定期增量」，靠的是**外部触发入队**（研究检查器 `checker.ts` 已有按 `next_check_at` 的定时扫描，见 1.2），不是 JobQueue 自己起定时器。

### 1.2 外部抓取 + URL 安全（复用，GitHub API 走这条路）

- `packages/core/src/research/urlSafety.ts:12` `assertPublicHttpsUrl`：**只允许 https、只允许 443、拒 localhost/元数据/私网/回环 IP**。`api.github.com` 完全合规 → 天然能过。
- 抓取入口：`fetchApproved.ts:35`（原始 fetch，限字节 `readLimitedResponseText`）、`tinyfishFetch.ts`（渲染动态页，2MB 上限 `MAX_RENDER_BYTES:20`）。GitHub **REST/搜索返回 JSON**，用 `fetchApproved` 那类原始 fetch 即可，不需要 TinyFish 渲染。
- 编排：`research/researchStore.ts:104` `ResearchStore`（topic/run/finding 三层）、`checker.ts`（按 `interval_ms`/`next_check_at` 到点重查 —— 这就是现成的「周期性增量研究」机制）。
- **结论**：Scout 调 GitHub Search API、Evaluator 抓 README/文档 = 复用 ResearchStore 的来源/抓取/URL 安全，**不新建 HTTP 层**。

### 1.3 能力沉淀原语：skill_candidates（**本工作包最关键的复用，直接当 Capability Library**）

- 表 `packages/core/src/db/migrations.ts:599` `skill_candidates`：
  - `status IN ('proposed','evaluated','approved','rejected','retired')`（:606）—— 就是工作包 §12 要的 capability 状态机的**现成版本**；
  - `problem / method / eval_case`（:602-604）—— Pattern 的问题/做法/验证用例已有字段；
  - `version`（:697）、`approved_version`（:699）、`eval_evidence_json`（:698）、`eval_before/eval_after/benefit`（:610-612）—— **版本化 + 实验前后对照 + 证据**，正是 §13/§14 要的 confidence 演进与版本升级，无需新建 `capability_versions`；
  - 生命周期由 `runtime/skills.ts:79` 管理（含 :107/:118 去重：同一件事不重复提案）。
- **架构决定（§12 落地）**：**Capability Library = skill_candidates。** GKD **不新建 capabilities/capability_versions/capability_sources 三张表**——它们与 skill_candidates 的列一一重叠。新增的只有「Pattern 及其 GitHub 来源证据」这类**中间蒸馏产物**（见 §4），验证通过后才**晋升为一条 skill_candidates**（status 走 proposed→evaluated→approved）。

### 1.4 记忆与证据链（部分复用其范式，不混存）

- `items`（`migrations.ts:553` 区）：`type/origin/confirmation/state(current/disputed/superseded)/confidence/supersedes_item_id`。工程 Pattern **不是个人记忆**，不进 items；但「证据可追溯、冲突用 disputed、新旧用 supersedes」这套**范式**在 §4/§6/§7 直接照搬。
- `item_evidence(item_id, segment_id, excerpt, relevance)`（`migrations.ts` 段内）：证明「这条知识来自哪段原文」的双证表 —— GKD 的 `gkd_pattern_sources` 是它的同构体（见 §4）。

### 1.5 编码任务与审批边界（复用，作为「实际开发使用能力」的一端）

- `execution/taskStore.ts` `CodingTaskStore`：状态机 `draft→waiting_approval→queued→running→pending_verify→pending_accept→completed/failed/cancelled`（`migrations.ts:485` CHECK）。
- **关键边界**：`approve()`（:358）要求**先备好隔离工作区 + 用户明确批准**；`liveApproval()`（:426）每次执行前重算 digest、版本变了旧批准作废。**这正对应 §25 禁止1「clone→copy→改→完」**——任何把 Capability 落成 IXAEON 代码的动作，都必须过这条既有审批闸，Distillery 自己无权绕过。
- `taskStore.ts` 还有 D5a/D5b 的「验收测试先行 + 核心模型锁定前复核」——GKD 的 §11 实验/验证可以直接产出一个「验收测试」交给 coding task 跑，复用而非新造 benchmark 框架（能复用的部分）。

### 1.6 审计与可观测（复用，满足 §23 反黑箱）

- `audit.ts:6` `recordAudit(db, kind, detail)`。Distillery 每个状态跃迁（为什么研究/为什么拒/为什么晋升/实验结果）都走 recordAudit + §4 表的 `decision/reason` 列，天然可答 §23 那串「为什么」。

### 1.7 relay / Agent 编排边界（**明确不复用进 GKD**）

- relay（`packages/relay`）是「给角色发任务书推流水线」的调度器，与「主体思考/知识蒸馏」不是一回事（见 H1 附录 A 的同款判断）。**GKD 住 core，不塞进 relay。** 额度/远程通知若要，走 H1 定义的端口，不在本包发明。

### 1.8 数据库与测试地基（约束本包怎么落地）

- 迁移最新 `id: 38`（`migrations.ts:1099`）→ GKD 从 **39** 起，且**迁移只追加、由整合方写**（AGENTS「迁移文件只由整合方编写」）。**这直接约束 GKD-1：见 §9。**
- **⚠️ main 上还没有 `goals`/`goal_links` 表**（GoalStore 在待复审分支 `dev2/G1a`，`git grep "CREATE TABLE goals" migrations.ts` 为空）。因此 §19 说的 `goal_links` 联动**在 G1 并入前不可依赖**——GKD 的 MVP 入口必须能只靠 `research_topic` / 用户直接请求启动，把 Goal 关联留作 G1 并入后的增强（解耦，降低阻塞，见 §8）。

---

## 2. GitHub Distillery 架构（八段能力链 → JobQueue kind + 复用件）

```
用户请求 / research_topic / (G1 并入后) active Goal
        │  触发
        ▼
[GKD Scout]        ── GitHub Search API（经 assertPublicHttpsUrl/fetchApproved）
        │  产出 gkd_repo_studies(row, decision='scouted')
        ▼
[GKD Evaluator]    ── 抓 README/docs/元数据；打分；REJECT/REFERENCE_ONLY/DEEP_ANALYZE/EXPERIMENT_CANDIDATE
        │
        ▼
[GKD Analyzer]     ── 仅 DEEP_ANALYZE：§5 的 16 项结构化理解（不写「总结这个 repo」）
        │  产出 gkd_patterns + gkd_pattern_sources
        ▼
[GKD Synthesizer]  ── 跨仓库：共识 / 分歧 / 冲突 / best-of-breed / 新方案（§8/§16）
        │  产出候选 skill_candidates(status='proposed') 或 gkd_patterns 合成层
        ▼
[GKD Experimenter] ── §11：建实验（优先复用 coding task 的验收测试/benchmark）；PASS/FAIL
        │  写 experiments
        ▼
[GKD Curator]      ── 只有 PASS 才准把 proposed→evaluated→approved 落进 skill_candidates（§12/§25禁止4）
        ▼
Capability Library（= skill_candidates）
        │  实际 coding task 开跑前查询（§18）
        ▼
用后真实结果回灌 confidence / 触发 Delta Research（§15）
```

每段一个 JobQueue kind；段间用 §4 的表传递，不靠内存。

---

## 3. 数据流（状态如何一路带着 provenance）

```
repo_url + commit_sha + license
      → gkd_repo_studies（含 decision、reason、eval_scores_json）
      → gkd_patterns（无代码正文，problem/core_idea/benefits/costs/applicable/not_applicable/confidence/status）
           └─ gkd_pattern_sources（pattern_id ↔ study_id + file_path + line/symbol + snippet_kind）
      → experiments（pattern/capability ↔ 用例 ↔ PASS/FAIL ↔ 证据）
      → skill_candidates（晋升后的能力；eval_evidence_json 指回 experiments）
      → coding_task（使用）→ 回灌 skill_candidates.benefit/version + recordAudit
```

**每一跳都必须能顺藤摸到最初 repo/commit/file**（§9/§25禁止5「来源丢失」= 硬红线，由 §6 约束保证）。

---

## 4. 数据模型（最小化：新增 5 表，晋升复用 1 表，不建 §20 的 10 张）

> 原则（§20 原话）：能复用必复用，别为漂亮狂加表。§20 列的 10 个概念里，
> `capabilities/capability_versions/capability_sources/research_runs` **都由既有件承载**，只剩蒸馏中间链需要新表。

新增（迁移号从 39 起，**由整合方编写**）：

```sql
-- 4.1 每被研究一次的仓库快照 + 评估决定（承载 §3/§4 的 scout/evaluator 产物与 provenance 头）
CREATE TABLE gkd_repo_studies (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,          -- owner/name
  commit_sha TEXT NOT NULL,              -- 钉死版本，§9 provenance 必需
  license TEXT,                          -- §10，来自 GitHub API license 字段，未知记 unknown
  fetched_at TEXT NOT NULL,              -- 分析时间
  source_type TEXT NOT NULL DEFAULT 'github_repo'
    CHECK (source_type IN ('github_repo','rfc','paper','blog','docs','issue','pr')), -- §30 未来来源
  origin_ref TEXT,                       -- 为什么研究：research_topic id / (G1后) goal id / 'user'
  relevance REAL, innovation REAL, engineering_quality REAL, maintainability REAL,
  test_quality REAL, novelty REAL, license_risk TEXT,   -- §4 评分（可空：scout 阶段还没评）
  decision TEXT NOT NULL DEFAULT 'scouted'
    CHECK (decision IN ('scouted','reject','reference_only','deep_analyze','experiment_candidate')),
  reason TEXT,                           -- §23「为什么拒另一个」
  core_share REAL,                       -- §4「核心代码占比」估计
  UNIQUE (repo_full_name, commit_sha, source_type)
);

-- 4.2 蒸馏出的 Pattern（§6/§7；核心：无代码正文，只有思想 + 取舍 + 适用边界）
CREATE TABLE gkd_patterns (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,             -- 如 durable-job-lease-v2
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  core_idea TEXT NOT NULL,               -- 允许含 ≤N 行的最小示意（见 §10 约束），默认描述而非贴码
  benefits TEXT NOT NULL DEFAULT '',
  costs TEXT NOT NULL DEFAULT '',
  applicable TEXT NOT NULL DEFAULT '',
  not_applicable TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'pattern'
    CHECK (kind IN ('pattern','technique','algorithm','architecture_decision','failure_pattern','anti_pattern','tradeoff')), -- §6 + §17 反模式同表
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'extracted'
    CHECK (status IN ('extracted','conflicting','superseded','promoted')),
  superseded_by TEXT REFERENCES gkd_patterns(id),  -- §14 版本链，不覆盖
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 4.3 来源证据（§9；= item_evidence 的同构体；§25禁止5 的机器保证）
CREATE TABLE gkd_pattern_sources (
  pattern_id TEXT NOT NULL REFERENCES gkd_patterns(id) ON DELETE CASCADE,
  study_id TEXT NOT NULL REFERENCES gkd_repo_studies(id) ON DELETE CASCADE,
  file_path TEXT,                         -- §9 file/line/symbol
  line_ref TEXT,
  symbol TEXT,
  snippet_kind TEXT NOT NULL DEFAULT 'idea'   -- §10 四级
    CHECK (snippet_kind IN ('idea','derived_design','copied_code','modified_code')),
  license_at_source TEXT,                 -- 抓取当时的 license，供兼容检查
  note TEXT,
  PRIMARY KEY (pattern_id, study_id, file_path, line_ref)
);

-- 4.4 冲突记录（§16；不强行融合）
CREATE TABLE gkd_pattern_conflicts (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,                    -- 如 "queue-backend"
  side_a_pattern TEXT REFERENCES gkd_patterns(id),
  side_b_pattern TEXT REFERENCES gkd_patterns(id),
  conditions_for_a TEXT NOT NULL,         -- 「单机 Durable → SQLite」
  conditions_for_b TEXT NOT NULL,         -- 「分布式 Worker → Redis/Postgres」
  tradeoff TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 4.5 实验（§11；晋升闸的凭证）
-- 统筹 2026-10-28 定：本表**领域中立**，命名 experiments（原 gkd_experiments 作废——
-- Self-Improvement S1 的 experimenting 也落同一张表，禁止第三套实验台账）。
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pattern','capability','improvement')),
  subject_id TEXT NOT NULL,               -- pattern_id / skill_candidates.id / improvement_candidates.id
  subject_version TEXT,                   -- 主体版本绑定（技能的 version / 候选版本 / pattern 无版本可空）
  baseline_ref TEXT,                      -- 基线引用（哪次评测/哪个用例集；与 candidate 必须同口径）
  candidate_ref TEXT,                     -- 候选引用
  judge_rule TEXT NOT NULL DEFAULT '',    -- 判分口径（用例级自动判定 or 人工判分；空=未声明，实现层应拒绝入库）
  kind TEXT NOT NULL                      -- §11 实验类型
    CHECK (kind IN ('unit','integration','benchmark','load','failure_injection','crash_recovery','security','memory','latency','throughput')),
  env_json TEXT NOT NULL DEFAULT '{}',    -- 环境（配置版本/哈希、机器、模型版本）
  spec TEXT NOT NULL,                     -- 怎么测（可指向一段验收测试/脚本路径，§1.5 复用 coding task 的测试）
  result TEXT NOT NULL DEFAULT 'pending'
    CHECK (result IN ('pending','pass','fail')),
  regression_json TEXT,                   -- 失败与回归的**逐例记录**（从对变错/从错变对），不只存汇总
  evidence_json TEXT,                     -- 数字/输出摘要（不含真实用户数据，§公开仓库隐私）
  subject_retired INTEGER NOT NULL DEFAULT 0, -- 主体被删/退役的标记：**实验证据不静默消失**
  coding_task_id TEXT,                    -- 若用真任务跑，指回 CodingTaskStore
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

**本表的四条硬约束**（统筹 2026-10-28）：

1. **多态引用完整性由代码层校验**——`subject_kind` 决定去查哪张表，SQL 建不了 FK，
   所以插入/查询都必须先按 kind 校验主体存在；
2. **删除主体不得 CASCADE 掉实验**——删 pattern/候选时置 `subject_retired=1`，
   实验记录与证据**必须留存**（失败实验也是知识）；
3. `baseline_ref` / `candidate_ref` / `judge_rule` 为空时**实现层应拒绝入库**
   （没有基线和判分口径的实验证明不了任何事）；
4. `regression_json` 必须能表达**逐例**结果，禁止只写 `{"pass":27,"fail":3}` 这种汇总
   （否则「总体 +5、旧场景 −5」会被掩盖，S1 §4 同一要求）。

晋升（§12）**不新建表**：`gkd_patterns.status='promoted'` + 建/更新一条 `skill_candidates`（problem/method/eval_case 来自 pattern，`eval_evidence_json` 指向 `experiments`）。confidence/版本/前后对照全用 skill_candidates 现成列。

---

## 5. 状态机

**RepoStudy**：`scouted → reject | reference_only | deep_analyze | experiment_candidate`（终态即决定；reject/reference_only 不再往下）。

**Pattern**：`extracted → conflicting（进 gkd_pattern_conflicts）| superseded（被新版取代）| promoted（已进 capability）`。

**Capability（= skill_candidates，复用其 status，映射工作包 §12）**：

```
（§12 命名）      →  skill_candidates.status
candidate        →   proposed      ← Synthesizer 产出时
experimental     →   evaluated(未过) / 有 pending experiment
validated        →   evaluated 且关联 experiments.result='pass'
adopted          →   approved（approved_version=当前）
deprecated       →   retired
rejected         →   rejected
```

**晋升不变量（§11/§25禁止4）**：`result != 'pass'` 的 pattern **禁止** `promoted`；代码路径里 `proposed→approved` 必须检查存在 `result='pass'` 的 experiment 行，否则抛错。**没有旁路。**

---

## 6. Provenance 设计（§9，红线）

- 每条 Pattern 至少 1 行 `gkd_pattern_sources`，且每行带 `study_id → (repo_full_name, commit_sha, file_path[, line_ref/symbol], license)`。
- 写入门禁：`gkd_patterns` 落库的事务里，若无任何来源行 → 拒绝（不允许 §9「听说很多项目这么做」的无源知识）。
- **不 clone、不整仓入库**（§22 非目标）：Analyzer 只按需经 URL 安全抓**指定文件的文本**（GitHub raw/blob），逐文件记 provenance；不落整仓、不建本地 GitHub 镜像。
- 来源仓库更新/删除（§28）：`gkd_repo_studies` 按 `(repo, commit)` 钉版，旧 provenance **不随上游变**；上游删除不影响已存证据（commit 不可变）。重查同 repo 新版本 → 新 study 行 → 触发 §15 Delta，而非改旧行。

---

## 7. Capability versioning（§14）与 confidence（§13）

- 版本：同一 `slug` 演进 → 旧 `gkd_patterns.superseded_by` 指新；晋升侧 skill_candidates 的 `version`/`approved_version` 递增，**旧版本行保留**，`eval_before/eval_after` 记「为什么变、哪条证据导致升级」。
- confidence（§13，复用 skill_candidates，不新列优先）：由 `source_count`（多来源印证↑）、`experiment result`（pass↑/fail↓）、`real_world_usage`（coding task 用后回灌 `benefit`）、`age`、`contradictory_evidence`（有冲突↓）计算。**具体权重是待定参数**——先做保守可解释的加权和，写死成有注释的常量，真实校准后再调（避免 §13「0.83 说不清怎么来的」：公式必须在代码里可读出，§23 反黑箱）。

---

## 8. 与 GoalEngine / research_topic / coding_task 的关系（§9/§18/§19）

- **入口（§19 自动触发）**：
  - 主用现成 `research_topic`（`researchStore.createTopic`，:107）——coding agent 遇陌生问题 → 建 topic → Distillery 消费。**这条现在就通**（topic 无 done 态，用 run 成功计数判断，不猜完成）。
  - **Goal 关联（`goal_links`）依赖 G1，尚未并入 main（§1.8）→ 列为 GKD 后置增强**，不进 MVP 关键路径。
- **出口（§18 使用）**：coding task 开跑前查 skill_candidates（按 problem 相似），把 recommended/pitfalls/tests 注入上下文；复用 `taskStore` 现成检索，不新造查询子系统。
- **回灌（闭环）**：coding task 完成/失败 → 回写对应 capability 的 `benefit`/`eval_after` + `recordAudit('gkd.capability.used', …)`。
- **晋升落地仍走审批**：Capability 变 IXAEON 代码 = 建 coding task，经 `approve()`/`liveApproval()`（§1.5）。**Distillery 绝不自动改核心代码（§22/§25）。**

---

## 9. MVP 范围（§21）与 GKD 拆分（§27）

**MVP 选「Durable Job Queue」**——理由：IXAEON 自己就有 `jobQueue.ts`，蒸馏出的能力可**立刻拿去改进我们真实的队列**（lease 目前缺失），端到端可测、反馈闭环是真的，不是玩具。

MVP 链路（一次走通即算 §29 demo）：

```
research_topic「研究最可靠的 durable queue 设计」
→ Scout 搜 5~10 repo（GitHub API，带 license）
→ Evaluate 选 3~5 deep_analyze
→ Analyze 出 Pattern（provenance 齐）
→ Synthesize 跨仓对比（含 §16 冲突：SQLite vs Redis）
→ 产出 candidate + 至少 1 个 experiments
→ 我们自己的 jobQueue 加 lease 作实验，coding task 跑（含 crash recovery / 重复执行 / 10000 jobs 里挑 1~2 项）
→ PASS → 晋升 skill_candidates（adopted）
→ 第二个 coding task 查询命中该 capability，不重新研究 GitHub
```

**GKD 工作包（§27，每包 实现→test→verify→commit→汇报）**：

| 包    | 内容                                                                                                                             | 依赖    | 是否碰迁移                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------- |
| GKD-1 | `gkd_repo_studies` + `gkd_pattern_sources`（provenance 地基）+ JobQueue kind 骨架 + Scout（复用 fetchApproved 调 GitHub Search） | 无      | **是（迁移 39+）→ 整合方写 SQL** |
| GKD-2 | Evaluator（打分+decision）                                                                                                       | GKD-1   | 否（列已在）                     |
| GKD-3 | Analyzer + `gkd_patterns`（结构化 16 项→Pattern，带 provenance 门禁）                                                            | GKD-1   | 是（迁移）                       |
| GKD-4 | `gkd_pattern_conflicts` + Synthesizer（跨仓综合）                                                                                | GKD-3   | 是（迁移）                       |
| GKD-5 | `experiments` + 晋升闸（PASS→skill_candidates，复用现有生命周期）                                                                | GKD-3   | 是（迁移）                       |
| GKD-6 | capability confidence/版本演进（复用 skill_candidates 列为主）                                                                   | GKD-5   | 视需要                           |
| GKD-7 | coding task 查询接口（用现成 taskStore，薄封装）                                                                                 | GKD-5   | 否                               |
| GKD-8 | Delta Research（复用 research checker 的 next_check_at）                                                                         | GKD-2/5 | 否                               |

> **GKD-1 的现实约束**：本包核心是新表 = 迁移，而迁移按 AGENTS **只由整合方编写**、且测试先行需整合方锁定（B 档：新外发 GitHub API = 隐私/外部面）。所以 **GKD-1 的实际第一交付是「本文 + 提议的 SQL 草稿（交整合方定稿/落迁移）」**，非迁移部分（Scout 纯逻辑、provenance 校验函数、JobQueue handler 骨架）可先带注入式替身测试开工。**我不会自己 register 迁移或 lock。**

---

## 10. License 与代码污染（§10，强制）

- 四级 provenance 标签 `snippet_kind`（§4.3 CHECK）：`idea / derived_design / copied_code / modified_code`。
- **默认蒸馏 idea/derived_design**：`gkd_patterns.core_idea` 只存描述；**除非显式标 copied_code 并带 `license_at_source`，否则不收任何第三方代码正文进 Pattern**（防 §10「来源不清代码入 IXAEON」）。
- copied_code/modified_code 必须：有 study 的 `license`、过 license 兼容检查（写 `recordAudit('gkd.license.checked',…)`）、coding task 落地时保留出处注释。
- 未知 license → `license_risk='unknown'`，MVP 阶段一律不得 deep_analyze 到 copied_code（保守闸）。

---

## 11. Validation pipeline（§11/§25禁止4）

`提取 ≠ 成为能力`。唯一合法路径：`gkd_patterns → experiments(result=pass) → skill_candidates.proposed → evaluated → approved`。晋升函数内**硬性 assert 存在 pass 实验**，否则抛 `IxaError`。实验优先**复用 coding task 的验收测试/benchmark 通道**（§1.5），不自造 benchmark 框架。

---

## 12. 非目标（§22 原样采纳，写死为红线）

不爬全 GitHub、不下几十万仓库、不训练模型、不全量 embedding 索引 GitHub、不建本地 GitHub 镜像、不复制第三方项目整体、**不让系统自动改 IXAEON 核心代码**、不无验证自动采纳、不「一键吸收 GitHub」。要的是高质量知识闭环，不是数据量。

---

## 13. 风险

| 风险                                                       | 缓解                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **重复造轮子**（尤其 capability 表撞 skill_candidates）    | §1.3 已把晋升**定义为复用 skill_candidates**；GKD 不建 capabilities/versions/sources                                                                       |
| **过度工程**（§20 十表、§25禁止7）                         | 压到 5 新表 + 1 复用；MVP 单主题单链跑通再扩                                                                                                               |
| GitHub API 是新外发面（rate limit、token）                 | 走 `assertPublicHttpsUrl`+fetchApproved 既有闸；**token 管理方式待确认**（仓库里未见统一 PAT 约定，见待决项）；低频、缓存 study 去重（UNIQUE repo+commit） |
| Analyzer 让 LLM「总结 repo」→ 低质摘要                     | §5 强制 16 项结构化字段；LLM summary 本身不算知识（§25禁止2），必须挂 provenance                                                                           |
| confidence/权重拍脑袋（§13、AGENTS「ModelPool 编值」教训） | 公式可读出、常量带注释、真实校准后再调，不冒充已验证                                                                                                       |
| 依赖未并入的 GoalEngine                                    | MVP 入口用 research_topic，Goal 关联后置（§1.8/§8）                                                                                                        |
| 蒸馏出的 lease 改动直接上生产队列                          | 一切落码经 coding task 审批（§8/§1.5），Distillery 无写核心权                                                                                              |

---

## 14. 后续演进（§30）

同一条 `Evidence → Pattern → Experiment → Capability → Evolution` 管线，来源类型从 `github_repo` 扩到 `rfc/paper/blog/docs/issue/pr`（`gkd_repo_studies.source_type` 已预留）；IXAEON 自己的开发经验（`work_runs`/`corrections`）也可作为 `source_type` 进同一 provenance，最终成 IXAEON Engineering Intelligence。

---

## 待用户/整合方拍板（开工前）

1. **GKD-1 迁移**：SQL 见 §4，需整合方按 §20 定稿并亲自落迁移（编号 39 起）；执行方不代写迁移。
2. **MVP 主题**：确认「Durable Job Queue」（我推荐，因能立刻反哺我们真实 jobQueue 的 lease 缺口）还是「Agent Memory」。
3. **GitHub 访问方式**：REST API vs `gh` CLI（CI 里有 `gh` 但产品代码无）；**token 从哪来**（未见统一约定）。
4. **档位确认**：本包涉新外发（GitHub API）+ 知识含义 + 迁移 → **整体 B 档**（执行方先只推测试/骨架，整合方锁定后写实现）。

---

## 附：本文的自审（§26 结尾五问，先自查再交）

1. **哪些复用现有 IXAEON**：JobQueue（阶段执行）、ResearchStore+urlSafety+fetchApproved（抓取/安全）、skill_candidates（**直接当 Capability Library**）、items 的 evidence/supersedes/disputed 范式、CodingTaskStore（落地与实验、审批闸）、recordAudit（可观测）、research checker（Delta）。
2. **哪些必须新增**：仅蒸馏中间链 **5 表**（`gkd_repo_studies` / `gkd_patterns` / `gkd_pattern_sources` / `gkd_pattern_conflicts` / `experiments`，见 §4），均为「思想+来源+实验」证据链，现有件不承载。
3. **哪些可能过度工程，已砍**：`capabilities/capability_versions/capability_sources/research_runs/独立实验框架/独立调度器` —— 全砍，复用 skill_candidates + JobQueue + checker + coding task。§20 的 10 概念压到 5 新表。
4. **MVP 最少需要**：Scout（GitHub Search 复用 fetch）+ Evaluate + 3~5 个 Analyzer 出带 provenance 的 Pattern + 1 个实验（借我们真 jobQueue）+ 晋升 skill_candidates + 一次查询复用 —— 一条链跑通。
5. **是否真闭环**：是 —— repo→pattern→实验→能力→coding task 使用→结果回灌 confidence→触发 Delta 升级新版本，且每一跳带来源、无源不晋升、未验证不 adopted 三条闸把死。

**残留不确定（据实标注，不假装有答案）**：GitHub token 管理、confidence 权重数值、SQLite 加列 vs 新表承载 capability→task 使用记录（§12 待整合方）；GoalEngine 关联受 G1 并入阻塞。

## 整合方审稿（2026-10-29）

**结论：设计稿留着，这一阶段不开发；GKD-1 的草稿 SQL 不写成正式迁移。** 许可证当硬闸、默认只蒸馏思路不收代码正文、每条结论带出处，这些设计是对的。暂缓的理由是先后：

- 它是一整套新系统（5 张新表、GitHub API 新外发、把第三方代码片段发给模型分析），和下一阶段的 North Star（陪用户用 7 天、推进真实目标）不在一条线上；
- 整合方同一时间只推进一块主体能力，G1、M1、H1、E1 排在前面。

DS2 / DS3（模型调用层的规范化类型与多轮对话接线）已经写了实现，按待复审的代码处理：排在 G1 之后复审；复审时先看它对现有聊天、编码任务两条调用链有没有行为变化。

**什么时候重新看**：E1 第一次真实 7 天评测之后，和 C1/R1/D1/S1 一起排。
