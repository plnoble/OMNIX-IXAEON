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
];

/** 应用所有未执行的迁移（每个迁移在独立事务中执行）。 */
export function migrate(db: CoreDatabase): void {
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
