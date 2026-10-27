# GKD-1 迁移草稿 SQL（执行方提供，**正式迁移由整合方编写**）

> 统筹 2026-10-27 任务书 §9.2：「允许执行方提供 Draft SQL，但正式 migration 必须由整合方完成」。
> 本文件**不是** migrations.ts 的注册项，不改 `packages/core/src/db/migrations.ts`。
> 逐表回答 §9.2 的九问。设计依据：`docs/design/github-knowledge-distillery.md` §4。

## 0. 全局前置决定（整合方先拍）

- **编号**：main 现最新为 `id: 38`（`coding-task-acceptance-and-apply`）。本组建议 **39–41 三个迁移**（表分组、便于分开复审），而非一个巨迁移。
- **可重建性**：蒸馏产物**全部可重建**（重跑 Scout/Analyzer 即可再生）。因此所有 FK 用 `ON DELETE CASCADE` 不会造成不可逆数据损失——这是本 schema 最重要的安全前提，也决定了下面「删除传播」的答案。
- **绝不复制既有表**：不 import `sources/segments/items/research_topics` 的数据，只新建关系列指向它们（见每表「是否错误复制现有数据」）。

## 1. 迁移 39：来源与评估（`gkd_repo_studies`）

```sql
CREATE TABLE gkd_repo_studies (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  license TEXT,                          -- 'Apache-2.0'/'MIT'/'unknown'…抓取当时记录
  fetched_at TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'github_repo'
    CHECK (source_type IN ('github_repo','rfc','paper','blog','docs','issue','pr')),
  origin_ref TEXT,                       -- 为什么研究：research_topic id / (G1 并入后) goal id / 'user'
  relevance REAL CHECK (relevance IS NULL OR (relevance BETWEEN 0 AND 10)),
  innovation REAL  CHECK (innovation IS NULL OR (innovation BETWEEN 0 AND 10)),
  engineering_quality REAL CHECK (engineering_quality IS NULL OR (engineering_quality BETWEEN 0 AND 10)),
  maintainability REAL CHECK (maintainability IS NULL OR (maintainability BETWEEN 0 AND 10)),
  test_quality REAL CHECK (test_quality IS NULL OR (test_quality BETWEEN 0 AND 10)),
  novelty REAL CHECK (novelty IS NULL OR (novelty BETWEEN 0 AND 10)),
  license_risk TEXT CHECK (license_risk IS NULL OR license_risk IN ('low','medium','high','unknown')),
  decision TEXT NOT NULL DEFAULT 'scouted'
    CHECK (decision IN ('scouted','reject','reference_only','deep_analyze','experiment_candidate')),
  reason TEXT NOT NULL DEFAULT '',
  core_share REAL CHECK (core_share IS NULL OR (core_share BETWEEN 0 AND 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_full_name, commit_sha, source_type)
);
CREATE INDEX idx_gkd_studies_decision ON gkd_repo_studies(decision);
CREATE INDEX idx_gkd_studies_origin ON gkd_repo_studies(origin_ref) WHERE origin_ref IS NOT NULL;
```

| §9.2 九问                 | 答                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 谁写                      | Scout（GitHub Search，经 `assertPublicHttpsUrl`+`fetchApproved`）、Evaluator（打分与 decision）。只有 GKD job 写，无 UI 直写 |
| 谁读                      | Analyzer（只读 `deep_analyze`/`experiment_candidate`）、Synthesizer、界面（未来）、审计导出                                  |
| 权威来源                  | 这一行=「某 repo 某 commit 在某时刻被我们评估过」的**唯一权威**；上游 repo 变了不改本行（commit 不可变），新版本=新行        |
| 删除传播                  | 删一行会级联删其 patterns 来源关系（见迁移 40）；**不删别的表的数据**                                                        |
| 授权传播                  | 无个人数据；仓库元数据公开。`reason` 是人读文本，须按公开仓库规则不夹带用户真实内容                                          |
| provenance                | `(repo_full_name, commit_sha, source_type, fetched_at)` 即身份四元组                                                         |
| repo/commit/path identity | commit_sha 必填非空（无它不许入库，代码层拦）                                                                                |
| 可重建                    | 是——重跑 Scout/Evaluator 可再生，评分是模型产物需注明                                                                        |
| 是否错误复制现有数据      | 否。`research_topics` 是「跟踪变化」，本表是「评估快照」，语义不同；不复制其行                                               |

⚠️ **给整合方的一个真问题**：评分是模型给的，`relevance BETWEEN 0 AND 10` 只保证形状不保证诚实。
建议实现层强制：每个分数都必须带 `reason` 非空，否则拒绝写入（对齐 §17 evidence JSON 里
我把 confidence 声明为「自评非测量」的做法）。要不要写进 CHECK 之外作为代码层硬规矩，你定。

## 2. 迁移 40：Pattern 与证据（`gkd_patterns` / `gkd_pattern_sources` / `gkd_pattern_conflicts`）

```sql
CREATE TABLE gkd_patterns (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  problem TEXT NOT NULL CHECK (length(problem) > 0),
  core_idea TEXT NOT NULL CHECK (length(core_idea) > 0),
  benefits TEXT NOT NULL DEFAULT '',
  costs TEXT NOT NULL DEFAULT '',
  applicable TEXT NOT NULL DEFAULT '',
  not_applicable TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'pattern'
    CHECK (kind IN ('pattern','technique','algorithm','architecture_decision',
                    'failure_pattern','anti_pattern','tradeoff')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'extracted'
    CHECK (status IN ('extracted','conflicting','superseded','promoted')),
  superseded_by TEXT REFERENCES gkd_patterns(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_gkd_patterns_status ON gkd_patterns(status, confidence DESC);

-- 来源证据：无源的 Pattern 不许存在（代码层事务拦，见 §4）
CREATE TABLE gkd_pattern_sources (
  pattern_id TEXT NOT NULL REFERENCES gkd_patterns(id) ON DELETE CASCADE,
  study_id TEXT NOT NULL REFERENCES gkd_repo_studies(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL DEFAULT '',
  line_ref TEXT,
  symbol TEXT,
  snippet_kind TEXT NOT NULL DEFAULT 'idea'
    CHECK (snippet_kind IN ('idea','derived_design','copied_code','modified_code')),
  license_at_source TEXT,
  note TEXT,
  PRIMARY KEY (pattern_id, study_id, file_path)
);
CREATE INDEX idx_gkd_sources_study ON gkd_pattern_sources(study_id);

-- 冲突不强行融合（设计 §16/任务书 §16）
CREATE TABLE gkd_pattern_conflicts (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  side_a_pattern TEXT NOT NULL REFERENCES gkd_patterns(id) ON DELETE CASCADE,
  side_b_pattern TEXT NOT NULL REFERENCES gkd_patterns(id) ON DELETE CASCADE,
  conditions_for_a TEXT NOT NULL,
  conditions_for_b TEXT NOT NULL,
  tradeoff TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (side_a_pattern <> side_b_pattern)
);
```

| §9.2         | 答（三表合并说）                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 谁写         | Analyzer 写 patterns/sources；Synthesizer 写 conflicts，并把涉及 pattern 置 `conflicting`                                                                                                       |
| 谁读         | Synthesizer（去重、跨仓聚合）、晋升 job（只读 `promoted` 前置校验）、界面                                                                                                                       |
| 权威来源     | **Pattern 的正文以本表为权威**；「来自哪」以 `gkd_pattern_sources` 为权威，二者都在同一事务写                                                                                                   |
| 删除传播     | 删 pattern → 它的 sources/conflicts 级联删；**不删 study**（一个 repo 还能支撑别的 pattern）。`superseded_by` 用 SET NULL：删新版不留断链，但旧版仍在（历史不蒸发）                             |
| 授权传播     | 全是外部开源思想，无个人数据；但 `note`/`reason` 类文本进公开仓库前需按隐私规矩过                                                                                                               |
| provenance   | `(study_id → repo+commit)` + `(file_path, line_ref, symbol)` + `snippet_kind` + `license_at_source`，四件齐才算有源                                                                             |
| identity     | `slug` 全局唯一，是跨版本演进的稳定标识（`durable-job-lease-v2`）                                                                                                                               |
| 可重建       | 是（重跑 Analyzer）；但 `slug` 是人工/半人工命名，重建可能对不上——建议整合方考虑给 slug 加受控词表或允许重命名策略                                                                              |
| 是否错误复制 | 否。不复制 `items`（个人记忆）也不复制 `research_findings`（研究快照）。**风险点**：若 GKD pattern 与 items 内容重叠会形成两套知识——任务书 §9.3 明令禁止，代码层应拒绝把 pattern 直接写进 items |

## 3. 迁移 41：实验（`gkd_experiments`）

```sql
CREATE TABLE gkd_experiments (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pattern','capability')),
  subject_id TEXT NOT NULL,              -- pattern_id 或（晋升后）skill_candidates.id
  kind TEXT NOT NULL CHECK (kind IN ('unit','integration','benchmark','load',
      'failure_injection','crash_recovery','security','memory','latency','throughput')),
  spec TEXT NOT NULL,                    -- 怎么测：脚本路径 / 验收测试文件名 / 参数摘要
  result TEXT NOT NULL DEFAULT 'pending'
    CHECK (result IN ('pending','pass','fail')),
  evidence_json TEXT,                    -- 数字与输出摘要；禁真实用户数据
  coding_task_id TEXT REFERENCES coding_tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_gkd_exp_subject ON gkd_experiments(subject_kind, subject_id, result);
```

| §9.2         | 答                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 谁写         | Experimenter job（借 coding task 跑就写 `coding_task_id`，引用**已存在**任务，代码层校验）                                                                                  |
| 谁读         | 晋升闸（硬查 `result='pass'`）、Curator、周审                                                                                                                               |
| 权威来源     | 「某实验在某结果」的唯一权威。`subject_id` 是多态引用，**不能建 FK**（指向两张不同表）→ 必须代码层按 `subject_kind` 分别校验存在性                                          |
| 删除传播     | `coding_task_id` 用 SET NULL：删任务不删实验记录（实验证据要留存）。删 pattern 时实验行**留着**（subject 变悬挂），整合方可决定改成 CASCADE——我倾向留，因为失败实验也是知识 |
| 授权传播     | `evidence_json` 可能含路径/输出——**必须走 `hideWorkspacePath`**，禁贴真实用户数据（公开仓库规矩）                                                                           |
| provenance   | `spec` 指向可复现的测法（脚本/测试文件），不是自由文本                                                                                                                      |
| identity     | `(subject_kind, subject_id, kind)` 可重复多次（不同时间的多次实验），有意为之                                                                                               |
| 可重建       | 实验**不可重建**（结果依赖当时环境），因此删除要格外保守——这是三张表里唯一不可再生的                                                                                        |
| 是否错误复制 | 不复制 coding task 本体，只引用 id                                                                                                                                          |

## 4. 不靠 CHECK 的两条硬规矩（必须代码层，写清楚）

1. **无源不入库**：`gkd_patterns` 的事务里若没有任何 `gkd_pattern_sources` → 抛错回滚（SQLite CHECK 做不到跨表）。
2. **未验证不晋升**：`promoted` 与 `skill_candidates.status='approved'` 的写入路径必须硬查存在 `result='pass'` 的实验行，否则抛 `IxaError(CONFLICT)`。**没有旁路**。

## 5. 我特意没做的（避免越权）

- 没有写进 `migrations.ts`（迁移是整合方关卡）；
- 没有 `ALTER TABLE` 碰 `items`/`coding_tasks`/`research_topics`/`todos`；
- 没有为「capability」新建表——**晋升复用 `skill_candidates`**（设计 §1.3 的架构决定：它已有 status 生命周期、version/approved_version、eval_evidence_json、eval_before/after、benefit，新建 capability 三表就是重复造轮子）；
- 没有加任何删除数据的路径。

## 6. 请整合方一并定的四件事

1. 三个迁移（39/40/41）的拆分是否合适，或要不要合成一个；
2. `gkd_experiments` 在 pattern 删除时的传播方向（留悬挂 vs CASCADE）；
3. 评分必须有 reason 这条，要不要下沉成 CHECK（`reason <> ''`）；
4. `slug` 命名/重命名策略（重建对不上时的口径）。
