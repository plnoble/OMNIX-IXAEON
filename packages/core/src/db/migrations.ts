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
