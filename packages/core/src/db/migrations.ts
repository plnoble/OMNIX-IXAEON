import type { CoreDatabase } from './database.js';

/**
 * 编号 SQL 迁移。只能追加，不能修改或删除已有迁移。
 * 数据库 schema 只能通过这里的迁移升级，禁止启动时重建用户数据库。
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init-core-schema',
    sql: `
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('file', 'folder', 'domain')),
  locator TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('once', 'continuous')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'document', 'project_snapshot', 'work_result')),
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt_export', 'chatgpt_web', 'local_file', 'project', 'coding_agent')),
  external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  captured_at TEXT,
  imported_at TEXT NOT NULL,
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_sources_dedup ON sources(provider, external_id, content_hash);
CREATE INDEX idx_sources_permission ON sources(permission_id);
CREATE INDEX idx_sources_project ON sources(project_id);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'document')),
  external_node_id TEXT,
  external_parent_id TEXT,
  is_active_branch INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_id, sequence)
);
CREATE INDEX idx_segments_source ON segments(source_id, sequence);
CREATE INDEX idx_segments_hash ON segments(source_id, content_hash);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('project_summary', 'decision', 'rejected_option', 'open_loop', 'goal', 'constraint', 'preference')),
  statement TEXT NOT NULL,
  rationale TEXT,
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'disputed', 'superseded')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  origin TEXT NOT NULL CHECK (origin IN ('ai', 'user', 'work_result')),
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  supersedes_item_id TEXT REFERENCES items(id),
  extracted_from_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  prompt_version TEXT,
  model_name TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  shelved_at TEXT
);
CREATE INDEX idx_items_project_state ON items(project_id, state);
CREATE INDEX idx_items_review ON items(needs_review) WHERE needs_review = 1;
CREATE INDEX idx_items_shelved ON items(shelved_at) WHERE shelved_at IS NOT NULL;
CREATE INDEX idx_items_source ON items(extracted_from_source_id);

CREATE TABLE item_evidence (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 0.5,
  PRIMARY KEY (item_id, segment_id)
);
CREATE INDEX idx_evidence_segment ON item_evidence(segment_id);

CREATE TABLE corrections (
  id TEXT PRIMARY KEY,
  old_item_id TEXT NOT NULL REFERENCES items(id),
  user_text TEXT NOT NULL,
  new_item_id TEXT NOT NULL REFERENCES items(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_corrections_old ON corrections(old_item_id);
CREATE INDEX idx_corrections_new ON corrections(new_item_id);

CREATE TABLE work_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  task TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'failed')),
  summary TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]',
  tests_json TEXT NOT NULL DEFAULT '[]',
  open_loops_json TEXT NOT NULL DEFAULT '[]',
  commit_ref TEXT,
  started_at TEXT,
  finished_at TEXT NOT NULL
);
CREATE INDEX idx_work_runs_project ON work_runs(project_id, finished_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_events(created_at);

CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER segments_fts_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER segments_fts_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER segments_fts_au AFTER UPDATE OF text ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`,
  },
  {
    id: 2,
    name: 'source-revisions-and-job-scheduling',
    sql: `
ALTER TABLE sources ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN analyzed_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN not_before TEXT;
CREATE INDEX idx_jobs_due ON jobs(status, not_before);

CREATE TABLE session_aliases (
  external_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 迁移旧行为：既有来源视为「内容版本 1、已按旧规则分析过」（避免升级后
-- 为全部历史来源批量触发补分析）；此后新增/追加内容正常递增 content_revision。
UPDATE sources SET content_revision = 1, analyzed_revision = 1;
`,
  },
  {
    id: 3,
    name: 'item-suggested-project',
    sql: `
ALTER TABLE items ADD COLUMN suggested_project_id TEXT REFERENCES projects(id);
`,
  },
  {
    id: 4,
    name: 'source-analyzed-at',
    sql: `
ALTER TABLE sources ADD COLUMN analyzed_at TEXT;
`,
  },
  {
    id: 5,
    name: 'item-confirmation',
    sql: `
-- M2：确认维度（与「谁提取的 origin」「是否有效 state」正交）。
-- none=未表态；confirmed=用户确认正确；rejected=用户不采纳（不是确认正确）。
ALTER TABLE items ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'none'
  CHECK (confirmation IN ('none', 'confirmed', 'rejected'));
ALTER TABLE items ADD COLUMN confirmation_at TEXT;
`,
  },
  {
    id: 6,
    name: 'work-run-client-ref',
    sql: `
-- M3：回写幂等键（客户端提交 ID）。复用 id 主键存 client_ref（沿用
-- work_run_id 返回语义），旧客户端不传时仍为 UUID。唯一约束防重复入库。
ALTER TABLE work_runs ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX idx_work_runs_client_ref ON work_runs(client_ref) WHERE client_ref IS NOT NULL;
`,
  },
  {
    id: 7,
    name: 'fix-fabricated-analyzed-backfill',
    sql: `
-- 修复 G3c：迁移 2 曾把全部旧来源统一写成 content_revision=1, analyzed_revision=1
-- ——从未分析过的来源被伪造为已分析。本迁移按「成功证据」修正：
-- 无 items 且无 succeeded extract 任务的来源，analyzed_revision 回退为 0（待分析）。
-- 是否真的自动补分析由启动扫描受用户开关/权限/暂停/重试预算控制，
-- 迁移本身绝不调用模型。
UPDATE sources SET analyzed_revision = 0, analyzed_at = NULL
WHERE analyzed_revision >= content_revision
  AND NOT EXISTS (
    SELECT 1 FROM items i WHERE i.extracted_from_source_id = sources.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.kind = 'extract'
      AND j.status = 'succeeded'
      AND j.payload_json LIKE '%"' || sources.id || '"%'
  );
`,
  },
  {
    id: 8,
    name: 'item-manual-project-flag',
    sql: `
-- 修复 G5/V08：单独人工归属标记。assignToProject / correct 等人工操作置 1；
-- 来源级批量重绑不搬动这些条目（单独归属优先于来源绑定）。
ALTER TABLE items ADD COLUMN manual_project INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 9,
    name: 'item-needs-review-reasons',
    sql: `
-- 修复 F01/RF03：待处理原因集合。needs_review 只读自 needs_reasons
--（非空 = 待处理），每个归属/确认/解除操作只增删自己负责的原因，
-- 不再整体覆写 —— 「选项目」只解决 no_project，不顺便抹掉
-- manual（用户显式要求）、conflict（人工约束冲突）、unconfirmed。
-- 原因代码：no_project / unconfirmed / conflict / manual。
ALTER TABLE items ADD COLUMN needs_reasons TEXT NOT NULL DEFAULT '';
-- 旧数据迁移规则（非空旧库）：needs_review=1 的行无法追溯真实原因
-- —— 保守回填全部当前成立的派生原因 + manual（宁可多留在待讨论，
-- 不静默清掉历史待处理状态）；needs_review=0 的行原因留空（保持原状）。
UPDATE items SET needs_reasons = (
  (CASE WHEN project_id IS NULL THEN 'no_project,' ELSE '' END)
  || (CASE WHEN origin = 'ai' AND state = 'current'
            AND confirmation = 'none'
            AND type IN ('decision','rejected_option','project_summary')
           THEN 'unconfirmed,' ELSE '' END)
  || (CASE WHEN state = 'disputed' THEN 'conflict,' ELSE '' END)
  || 'manual'
)
WHERE needs_review = 1;
`,
  },
  {
    id: 10,
    name: 'retire-superseded-pending-reasons',
    sql: `
-- 修复 N01（历史残留）：纠正发生后旧条目应为 superseded 并退出待处理，
-- 但 F01 之前的 correct() 没有清理其 needs_reasons / needs_review ——
-- 已被替代的旧条目继续占据待讨论列表且不能再正常确认/不采纳。
-- 本迁移只清「state='superseded' 且仍待处理」的行（原因集与标记），
-- 不触碰任何 current/disputed 条目，也不删除任何数据（旧条目、纠正链、
-- 依据与历史全部保留）。
UPDATE items SET needs_reasons = '', needs_review = 0
WHERE state = 'superseded' AND needs_review = 1;
`,
  },
  {
    id: 11,
    name: 'memory-scope-and-disclosure',
    sql: `
-- S1：语义范围与项目归属正交。personal 是合法的个人记忆，不再用
-- project_id IS NULL 同时表示「个人」和「归属失败」。
-- 旧 project_id != null → scope=project；旧空归属 → unassigned（保守，
-- 不自动升级为 personal、不扩权、不清待处理、不改纠正链）。
ALTER TABLE items ADD COLUMN scope TEXT NOT NULL DEFAULT 'unassigned'
  CHECK (scope IN ('personal', 'project', 'unassigned'));
UPDATE items SET scope = 'project' WHERE project_id IS NOT NULL;

-- 关联不复制原文、不移动所有者、不等于共享权限。
CREATE TABLE item_links (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'topic')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (item_id, kind, target_id)
);
CREATE INDEX idx_item_links_item ON item_links(item_id);
CREATE INDEX idx_item_links_target ON item_links(kind, target_id);

-- 把指定条目分享给编码客户端等受众。旧 localToken 不自动解锁个人资料。
CREATE TABLE disclosure_grants (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('coding_client', 'model', 'research')),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  note TEXT
);
CREATE INDEX idx_disclosure_item ON disclosure_grants(item_id, audience);
`,
  },
  {
    id: 12,
    name: 'source-account-namespace',
    sql: `
-- S2：导入标识含平台 + 本地账户命名空间，跨账号相同标题/对话 ID 不误合并。
-- 命名空间由用户自命名，不读取密码或 Cookie。旧来源映射为 local（不扩权）。
ALTER TABLE sources ADD COLUMN account_namespace TEXT NOT NULL DEFAULT 'local';
DROP INDEX IF EXISTS idx_sources_dedup;
CREATE UNIQUE INDEX idx_sources_dedup ON sources(provider, account_namespace, external_id, content_hash);

-- 项目登记卡：构想可以没有目录；有目录时根路径身份关联，不凭同名合并。
ALTER TABLE projects ADD COLUMN purpose TEXT;
ALTER TABLE projects ADD COLUMN current_state TEXT;
ALTER TABLE projects ADD COLUMN primary_io TEXT;
ALTER TABLE projects ADD COLUMN capabilities TEXT;
ALTER TABLE projects ADD COLUMN related_goals TEXT;
ALTER TABLE projects ADD COLUMN unknowns TEXT;
`,
  },
  {
    id: 13,
    name: 'project-relations',
    sql: `
-- S3：项目关系是有状态的提案，不是已联通的事实。
-- accepted ≠ 接口已存在；实际联通用 verification 另存。
-- 同样证据被拒绝后不得每次刷新再催促（evidence_fingerprint）。
CREATE TABLE project_relations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'serves_goal', 'depends_on', 'provides_capability',
    'reusable', 'suspected_duplicate', 'conflict'
  )),
  from_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  to_entity_kind TEXT NOT NULL CHECK (to_entity_kind IN ('project', 'item')),
  to_entity_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  evidence_fingerprint TEXT NOT NULL,
  proposer TEXT NOT NULL CHECK (proposer IN ('system', 'user')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  verification TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification IN ('unverified', 'verified', 'failed')),
  benefit TEXT,
  cost TEXT,
  prerequisites TEXT,
  independent_alternative TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  supersedes_id TEXT REFERENCES project_relations(id)
);
CREATE INDEX idx_relations_from ON project_relations(from_project_id, status);
CREATE INDEX idx_relations_fingerprint ON project_relations(evidence_fingerprint, status);
`,
  },
  {
    id: 14,
    name: 'research-topics',
    sql: `
-- S4：主动研究。第一版只检查用户批准的 HTTPS 来源，不接搜索 API。
-- 自动关注默认关闭；失败不得写成「无变化」；accepted 研究不改用户偏好。
CREATE TABLE research_topics (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  public_description TEXT NOT NULL,
  related_goal_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  related_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  interval_ms INTEGER NOT NULL DEFAULT 86400000,
  max_pages_per_run INTEGER NOT NULL DEFAULT 10,
  paid_budget_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (paid_budget_mode IN ('none', 'request_cap')),
  request_cap INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_failure TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE research_sources (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'feed')),
  last_fingerprint TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_research_sources_topic_url ON research_sources(topic_id, url);
CREATE TABLE research_findings (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES research_sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  evidence_class TEXT NOT NULL DEFAULT 'publisher'
    CHECK (evidence_class IN ('publisher', 'third_party', 'cross_check', 'local_experiment')),
  claimed_published_at TEXT,
  fetched_at TEXT NOT NULL,
  related_goal_id TEXT,
  related_project_id TEXT,
  speculation TEXT,
  action_worthy INTEGER NOT NULL DEFAULT 0,
  action_reason TEXT,
  limitations TEXT,
  next_experiment TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_research_findings_fp ON research_findings(topic_id, content_fingerprint);
CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  findings_new INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  lease_until TEXT
);
CREATE INDEX idx_research_topics_next ON research_topics(enabled, paused, next_check_at);
CREATE INDEX idx_research_findings_topic ON research_findings(topic_id, created_at);
`,
  },
  {
    id: 15,
    name: 'coding-tasks',
    sql: `
-- S5：获准编码任务。执行器自报成功 ≠ 用户验收；独立验证器核对范围与测试。
-- 批准绑定任务版本/工作区/快照/允许命令；变更后旧批准失效。
CREATE TABLE coding_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  workspace_path TEXT,
  snapshot_ref TEXT,
  context_digest TEXT NOT NULL,
  allowed_commands_json TEXT NOT NULL DEFAULT '[]',
  timeout_ms INTEGER NOT NULL DEFAULT 900000,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'waiting_approval', 'queued', 'running',
    'pending_verify', 'pending_accept', 'completed', 'failed', 'cancelled', 'unknown'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  approval_id TEXT,
  dispatch_key TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  executor_name TEXT,
  executor_report_json TEXT,
  verify_status TEXT CHECK (verify_status IS NULL OR verify_status IN ('passed', 'failed', 'not_run')),
  verify_exit_code INTEGER,
  verify_output TEXT,
  tests_modified INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_coding_tasks_dispatch ON coding_tasks(dispatch_key) WHERE dispatch_key IS NOT NULL;
CREATE TABLE coding_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES coding_tasks(id) ON DELETE CASCADE,
  task_version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  snapshot_ref TEXT,
  allowed_commands_json TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_coding_tasks_status ON coding_tasks(status, updated_at);
`,
  },
  {
    id: 16,
    name: 'item-origin-roles-and-restore-defaults',
    sql: `
-- A04：助手建议 / 外部研究 / 用户决定分开。未知不写成用户目标。
-- SQLite 不能放宽 CHECK：重建表。PRAGMA foreign_keys 由 migrate() 在本迁移内关闭。
CREATE TABLE items_v16 (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'unassigned' CHECK (scope IN ('personal', 'project', 'unassigned')),
  type TEXT NOT NULL CHECK (type IN ('project_summary', 'decision', 'rejected_option', 'open_loop', 'goal', 'constraint', 'preference')),
  statement TEXT NOT NULL,
  rationale TEXT,
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'disputed', 'superseded')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  origin TEXT NOT NULL CHECK (origin IN ('ai', 'user', 'work_result', 'research', 'assistant_suggestion')),
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  supersedes_item_id TEXT,
  extracted_from_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  prompt_version TEXT,
  model_name TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  needs_reasons TEXT NOT NULL DEFAULT '',
  suggested_project_id TEXT REFERENCES projects(id),
  shelved_at TEXT,
  confirmation TEXT NOT NULL DEFAULT 'none' CHECK (confirmation IN ('none', 'confirmed', 'rejected')),
  confirmation_at TEXT,
  manual_project INTEGER NOT NULL DEFAULT 0
);
INSERT INTO items_v16 (
  id, project_id, scope, type, statement, rationale, state, confidence, origin,
  observed_at, created_at, updated_at, supersedes_item_id, extracted_from_source_id,
  prompt_version, model_name, needs_review, needs_reasons, suggested_project_id,
  shelved_at, confirmation, confirmation_at, manual_project
) SELECT
  id, project_id, scope, type, statement, rationale, state, confidence, origin,
  observed_at, created_at, updated_at, supersedes_item_id, extracted_from_source_id,
  prompt_version, model_name, needs_review, needs_reasons, suggested_project_id,
  shelved_at, confirmation, confirmation_at, manual_project
FROM items;
DROP TABLE items;
ALTER TABLE items_v16 RENAME TO items;
CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);
CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope);
CREATE INDEX IF NOT EXISTS idx_items_origin ON items(origin, type);
`,
  },
  {
    id: 17,
    name: 'source-archive-with-experience-summary',
    sql: `
-- 来源归档：原文可查，不再自动分析、不进现行理解/待讨论。
-- 归档时留下短经验摘要（非用户目标）。
ALTER TABLE sources ADD COLUMN archived_at TEXT;
ALTER TABLE sources ADD COLUMN archive_summary TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_archived ON sources(archived_at);
`,
  },
  {
    id: 18,
    name: 'runtime-runs-and-skill-candidates',
    sql: `
-- B1 运行账本：Hermes 或 Core 有界循环的事件。收到事件不等于完成。
CREATE TABLE runtime_runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  engine TEXT NOT NULL CHECK (engine IN ('hermes', 'core-bounded', 'missing')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'blocked')),
  events_json TEXT NOT NULL DEFAULT '[]',
  notice TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runtime_runs_created ON runtime_runs(created_at);

-- B4 经验→Skill 候选。批准前不得当能力升级；无对照结果不得标 approved。
CREATE TABLE skill_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  method TEXT NOT NULL,
  eval_case TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'evaluated', 'approved', 'rejected', 'retired')),
  eval_before TEXT,
  eval_after TEXT,
  benefit TEXT,
  created_from_work_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_candidates_project ON skill_candidates(project_id, status);
`,
  },
  {
    id: 19,
    name: 'source-provider-b5-platforms',
    sql: `
-- B5 三平台导入器（2026-09-13 口径：公开格式+合成验证，真实数据随用随填）：
-- sources.provider 枚举扩展。SQLite 不能直接改 CHECK，重建表继承全部
-- 既有列与索引（核对自迁移 1+10+11+13+15+17 后的真实结构；sources 无触发器）。
CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'document', 'project_snapshot', 'work_result')),
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt_export', 'chatgpt_web', 'claude_export', 'gemini_export', 'grok_export', 'local_file', 'project', 'coding_agent')),
  account_namespace TEXT NOT NULL DEFAULT 'local',
  external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  captured_at TEXT,
  imported_at TEXT NOT NULL,
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_revision INTEGER NOT NULL DEFAULT 0,
  analyzed_revision INTEGER NOT NULL DEFAULT 0,
  analyzed_at TEXT,
  archived_at TEXT,
  archive_summary TEXT
);
INSERT INTO sources_new (id, kind, provider, account_namespace, external_id, title, content_hash, raw_path, captured_at, imported_at, permission_id, project_id, metadata_json, content_revision, analyzed_revision, analyzed_at, archived_at, archive_summary)
  SELECT id, kind, provider, account_namespace, external_id, title, content_hash, raw_path, captured_at, imported_at, permission_id, project_id, metadata_json, content_revision, analyzed_revision, analyzed_at, archived_at, archive_summary FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE UNIQUE INDEX idx_sources_dedup ON sources(provider, account_namespace, external_id, content_hash);
CREATE INDEX idx_sources_permission ON sources(permission_id);
CREATE INDEX idx_sources_project ON sources(project_id);
CREATE INDEX idx_sources_archived ON sources(archived_at);
`,
  },
  {
    id: 20,
    name: 'source-provider-ask-session',
    sql: `
-- 用户指示（2026-09-13）：所有问答内容都进 Core。
-- 新增 provider 'ask_session'：桌面问答（Hermes/Core 循环）的问答对落库为
-- 来源，走既有提取管线生成理解候选。同迁移 19 的重建方式（列不变，
-- 仅扩 provider CHECK；外键关停防 DROP 悬挂引用）。
CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'document', 'project_snapshot', 'work_result')),
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt_export', 'chatgpt_web', 'claude_export', 'gemini_export', 'grok_export', 'local_file', 'project', 'coding_agent', 'ask_session')),
  account_namespace TEXT NOT NULL DEFAULT 'local',
  external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  captured_at TEXT,
  imported_at TEXT NOT NULL,
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_revision INTEGER NOT NULL DEFAULT 0,
  analyzed_revision INTEGER NOT NULL DEFAULT 0,
  analyzed_at TEXT,
  archived_at TEXT,
  archive_summary TEXT
);
INSERT INTO sources_new (id, kind, provider, account_namespace, external_id, title, content_hash, raw_path, captured_at, imported_at, permission_id, project_id, metadata_json, content_revision, analyzed_revision, analyzed_at, archived_at, archive_summary)
  SELECT id, kind, provider, account_namespace, external_id, title, content_hash, raw_path, captured_at, imported_at, permission_id, project_id, metadata_json, content_revision, analyzed_revision, analyzed_at, archived_at, archive_summary FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE UNIQUE INDEX idx_sources_dedup ON sources(provider, account_namespace, external_id, content_hash);
CREATE INDEX idx_sources_permission ON sources(permission_id);
CREATE INDEX idx_sources_project ON sources(project_id);
CREATE INDEX idx_sources_archived ON sources(archived_at);
`,
  },
  {
    id: 21,
    name: 'skill-candidates-immutable-evidence',
    sql: `
-- A09（审核 2026-09-13）：Skill 候选证据绑定不可由候选改写 + 具体版本批准。
ALTER TABLE skill_candidates ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE skill_candidates ADD COLUMN eval_evidence_json TEXT;
ALTER TABLE skill_candidates ADD COLUMN approved_version INTEGER;
`,
  },
  {
    id: 22,
    name: 'research-source-discovery-origin',
    sql: `
-- S2-05（审核 2026-09-15）：自动发现来源的身份与错误状态分离持久保存。
-- 此前 auto_discovered 标记借用 last_error，首次成功抓取即被清空，
-- 导致跨周期后自动候选被误当作用户显式批准来源。
ALTER TABLE research_sources ADD COLUMN discovered_by TEXT NOT NULL DEFAULT 'user'
  CHECK (discovered_by IN ('user', 'auto'));
`,
  },
  {
    id: 23,
    name: 'research-source-provenance-repair',
    sql: `
-- Q07（审核 2026-09-15）：修复旧数据库中带有 auto_discovered 标记的历史来源，
-- 迁移 22 将所有旧来源默认赋予 'user'，此处安全修正有可靠旧标记的来源为 'auto'。
UPDATE research_sources
SET discovered_by = 'auto'
WHERE last_error = 'auto_discovered';
`,
  },
  {
    id: 24,
    name: 'door-devices-persistence',
    sql: `
-- P4 自查审核修复（2026-09-16）：Door 设备身份、遥测、实测与任务租约持久化。
-- 此前 DoorService 为内存 Map，重启即失，违背配对持久与心跳状态要求。
-- 2026-09-17：Door 已降级为设计稿（见 docs/design/door-设备能力感知.md）。
-- 这三张表保留不动（迁移只追加不改写），当前无代码读写。重新启用时复用。
CREATE TABLE door_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linux','darwin','win32','android','ios')),
  status TEXT NOT NULL CHECK (status IN ('online','offline','restricted','revoked')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  cpu_cores INTEGER NOT NULL,
  total_ram_mb INTEGER NOT NULL,
  storage_gb INTEGER NOT NULL,
  local_models_json TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL,
  telemetry_json TEXT,
  paired_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL
);
CREATE TABLE door_benchmarks (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES door_devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ram_stress','inference_speed')),
  result_value REAL NOT NULL,
  tested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (device_id, kind)
);
CREATE TABLE door_task_leases (
  task_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES door_devices(id) ON DELETE CASCADE,
  lease_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'dispatched',
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 25,
    name: 'connector-registry',
    sql: `
-- P3-A 自查审核修复（2026-09-16）：从「支持导入」变成「知道接入到哪里」。
-- 每个连接器保存：平台、账号命名空间、采集方式、同步游标、覆盖区间、
-- 最后成功时间、失败原因与撤销状态。
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  account_namespace TEXT NOT NULL DEFAULT 'local',
  capture_method TEXT NOT NULL CHECK (capture_method IN ('history_export', 'live_capture', 'local_file')),
  sync_cursor TEXT,
  coverage_start TEXT,
  coverage_end TEXT,
  last_success_at TEXT,
  last_failure_reason TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, account_namespace, capture_method)
);
`,
  },
  {
    id: 26,
    name: 'conversations-and-messages',
    sql: `
-- 三周任务单 D1（2026-09-17）：连续对话。
-- 此前问答是单轮无状态（AskService.ask(projectId, question) 不带任何历史），
-- 数据库里没有对话表，界面每问一次覆盖上一次。愿景第 1、2 条
-- （「我照常聊天你逐渐理解我」「换个窗口你记得相关的事」）在交互层没有载体。
--
-- 设计决定：
-- 1. messages 是权威记录；ask_session 来源从对话派生（D5），不再每问一次建一条来源。
-- 2. engine_session_id 只在进程内有效，重启后为空；重开旧对话时新建引擎会话并
--    重喂最近几轮消息。它「记得」的就是这里存着的、用户看得见的消息，不假装没断过。
-- 3. 不做分支/重生成（无 parent_message_id）：当前不需要，避免规格填空式的提前抽象。
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  -- 最近一次使用的引擎会话（进程内有效，重启后失效）
  engine TEXT,
  engine_session_id TEXT,
  -- 本对话派生出的 ask_session 来源（追加式，不是每轮一条）
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  -- streaming：正在逐段写入；cancelled/failed 必须可见，不留空白气泡
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('streaming', 'complete', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 本轮运行标识（对应 runtime_runs 与审计）
  run_id TEXT,
  engine TEXT,
  model_name TEXT,
  -- 引用单列保存：回答可核验是产品硬要求，不与其他元数据混在一起
  citations_json TEXT NOT NULL DEFAULT '[]',
  -- steps / notice / coverage / usedChars 等渲染用元数据
  meta_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);
CREATE INDEX idx_conversations_updated ON conversations(archived_at, updated_at DESC);
`,
  },
  {
    id: 27,
    name: 'item-embeddings',
    sql: `
-- 三周任务单 R1（2026-09-17）：本机语义检索的向量表。
-- 起因：首次真机使用时，聊天预注入的记忆靠关键词两字片段匹配，「正式系统名」
-- 里的「正式」撞上了「正式开业」，注入了毫不相干的资料。
--
-- 设计决定：
-- 1. 向量是可重建的派生数据，权威仍是 items；丢了重算即可，不参与导出恢复的正确性。
-- 2. 按（条目, 模型）存：换模型后旧向量不被误用，自动视为缺失。
-- 3. text_hash 记录生成向量时的原文指纹：原文变了即过期重算。
-- 4. 不引入向量数据库：1 万到 10 万条规模暴力计算余弦足够快，
--    多一个索引只会多一份需要对账的状态（原 LanceDB 欠项据此结清）。
-- 5. 检索时的权限过滤不在这张表上做，沿用候选条目查询的既有规则——
--    有向量不代表可以被取用。
CREATE TABLE item_embeddings (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, model)
);
`,
  },
  {
    id: 28,
    name: 'job-note',
    sql: `
-- 2026-09-18：任务「成功了，但有事要说」的通道。
-- 起因：引用校验从「一条对不上就整份作废」放宽为「丢掉对不上的那几条」后，
-- 任务是成功的，但用户有权知道这次丢了几条——error 只在失败时才有意义，
-- 不能拿来装成功任务的说明。
ALTER TABLE jobs ADD COLUMN note TEXT;
`,
  },
  {
    id: 29,
    name: 'item-time-status',
    sql: `
-- 三周任务单 E1（2026-09-18）：已结束的事自动退场。
-- 「过没过去」由内容里写的日期自动判断（memory/temporal.ts），不落库；这里只存用户的判断，
-- 用来盖过自动判断：ongoing = 用户说还没结束（自动判断认错了，以后别再当成过去的事）；
-- ended = 用户确认已结束（内容里没日期也算过去）。NULL = 按内容日期自动判断。
-- 不用「搁置」：搁置会让条目从记忆里整个消失，而结束了的事问到时仍要能查到（当历史）。
ALTER TABLE items ADD COLUMN time_status TEXT CHECK (time_status IS NULL OR time_status IN ('ongoing', 'ended'));
`,
  },
  {
    id: 30,
    name: 'remove-ask-session-echoes',
    sql: `
-- 三周任务单 E2（用户 2026-09-18 定：聊天存档只从我说的话里提炼）。
-- 之前 IXAEON 自己的聊天存档（ask_session）连同模型的回答一起提炼：模型在回答里复述了
-- 注入给它的旧记忆，提炼又把复述当成新结论存了回来（回声）。提炼已改为只看用户的原话
-- （extraction/extractor.ts），本迁移清掉已经存回来的：依据全部来自模型回答的 AI 条目。
-- 只清没经过用户处理的——未确认也未否决、没单独改过项目、不在纠正链上，
-- 与重新提炼时替换旧理解的范围一致（extractor.ts 的 deleteOld）。
-- 依据、向量、披露授权随外键级联删除；删了哪几条记进审计。
CREATE TEMP TABLE ask_echoes AS
SELECT i.id FROM items i
WHERE i.origin = 'ai' AND i.state = 'current' AND i.confirmation = 'none' AND i.manual_project = 0
  AND i.extracted_from_source_id IN (SELECT id FROM sources WHERE provider = 'ask_session')
  AND EXISTS (
    SELECT 1 FROM item_evidence e JOIN segments g ON g.id = e.segment_id
    WHERE e.item_id = i.id AND g.role = 'assistant')
  AND NOT EXISTS (
    SELECT 1 FROM item_evidence e JOIN segments g ON g.id = e.segment_id
    WHERE e.item_id = i.id AND g.role = 'user')
  AND NOT EXISTS (SELECT 1 FROM corrections c WHERE c.old_item_id = i.id OR c.new_item_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM items x WHERE x.supersedes_item_id = i.id);
INSERT INTO audit_events (id, kind, detail_json, created_at)
SELECT lower(hex(randomblob(16))), 'migration.ask_echoes_removed',
       (SELECT json_object('count', COUNT(*), 'itemIds', json_group_array(id)) FROM ask_echoes),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM ask_echoes);
DELETE FROM items WHERE id IN (SELECT id FROM ask_echoes);
DROP TABLE ask_echoes;
`,
  },
  {
    id: 31,
    name: 'item-said-by',
    sql: `
-- 三周任务单 E3（用户 2026-09-18 定做法 B：AI 给的建议有用，要留，但记在 AI 名下）。
-- 真机：从导入聊天提炼出的 91 条里 58 条依据全是 ChatGPT 的回答，却被记成用户的决定、偏好、约束。
-- said_by = 这条是谁说的：user = 用户的原话；ai = AI 在对话里说的（建议、方案、说法）；
-- NULL = 没有对话说话人（文档、手工条目、纠正等）。按依据片段的说话人确定，不由模型判断。
ALTER TABLE items ADD COLUMN said_by TEXT CHECK (said_by IS NULL OR said_by IN ('user', 'ai'));
UPDATE items SET said_by = 'user'
WHERE origin = 'ai' AND EXISTS (
  SELECT 1 FROM item_evidence e JOIN segments g ON g.id = e.segment_id
  WHERE e.item_id = items.id AND g.role = 'user');
UPDATE items SET said_by = 'ai'
WHERE origin = 'ai' AND said_by IS NULL AND EXISTS (
  SELECT 1 FROM item_evidence e JOIN segments g ON g.id = e.segment_id
  WHERE e.item_id = items.id AND g.role = 'assistant');
-- AI 的建议不是用户的决定，不再要用户逐条确认「对不对」：只去掉 unconfirmed 这一个待处理原因，
-- 其余原因（缺项目、冲突、用户要求继续待处理）原样保留。想用哪条，在记忆页「采纳」。
UPDATE items
SET needs_reasons = trim(replace(',' || needs_reasons || ',', ',unconfirmed,', ','), ','),
    needs_review = CASE
      WHEN trim(replace(',' || needs_reasons || ',', ',unconfirmed,', ','), ',') = '' THEN 0
      ELSE 1 END
WHERE said_by = 'ai' AND (',' || needs_reasons || ',') LIKE '%,unconfirmed,%';
`,
  },
  {
    id: 32,
    name: 'app-settings',
    sql: `
-- 三周任务单 E6（2026-09-18）：核心层要读的少量全局设置（键值）。
-- 第一项 memory.personal_to_chat：个人记忆给 IXAEON 自己的聊天用（默认没有这一行 = 关闭）。
-- 放数据库而不是 config.json：权限判断在核心层（access.ts），各个读记忆的入口要看到同一个值。
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];

/** 应用所有未执行的迁移（每个迁移在独立事务中执行）。 */
export function migrate(db: CoreDatabase, upTo?: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);
  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{
    id: number;
  }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const m of MIGRATIONS) {
    if (upTo !== undefined && m.id > upTo) continue;
    if (applied.has(m.id)) continue;
    const apply = (): void => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
    };
    if (m.id === 16 || m.id === 19 || m.id === 20) {
      // 重建 sources/items 时必须先关闭外键（SQLite 事务内改 PRAGMA 无效）。
      // 19/20 重建 sources：segments/audit 引用旧表名，关闭外键避免 DROP 悬挂引用。
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('BEGIN');
        try {
          apply();
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      db.transaction(apply)();
    }
  }
}

/** 当前迁移版本号（测试与诊断用）。 */
export function currentMigrationVersion(db: CoreDatabase): number {
  const row = db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}
