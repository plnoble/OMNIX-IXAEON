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
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
    });
    run();
  }
}

/** 当前迁移版本号（测试与诊断用）。 */
export function currentMigrationVersion(db: CoreDatabase): number {
  const row = db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}
