# -*- coding: utf-8 -*-
"""M1.1: hint-as-suggestion + migration 3 + merge project carry-over."""
import io

# ---- 1) migration 3: items.suggested_project_id ----
f = "packages/core/src/db/migrations.ts"
c = io.open(f, encoding="utf-8").read()
old = """UPDATE sources SET content_revision = 1, analyzed_revision = 1;
`,
  },
];"""
new = """UPDATE sources SET content_revision = 1, analyzed_revision = 1;
`,
  },
  {
    id: 3,
    name: 'item-suggested-project',
    sql: `
ALTER TABLE items ADD COLUMN suggested_project_id TEXT REFERENCES projects(id);
`,
  },
];"""
assert old in c, "mig3 anchor"
c = c.replace(old, new)
io.open(f, "w", encoding="utf-8", newline="\n").write(c)
print("migration 3 ok")

# ---- 2) extractor: hint = suggestion, never silent assign ----
f = "packages/core/src/extraction/extractor.ts"
c = io.open(f, encoding="utf-8").read()
old = """      // 项目归属：来源绑定项目 → 直接归属；否则尝试 project_hint 匹配名
        let projectId = source.project_id;
        let needsReview = 0;
        if (!projectId && row.project_hint) {
          const m = this.db
            .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE')
            .get(row.project_hint) as { id: string } | undefined;
          if (m) projectId = m.id;
        }
        if (!projectId) needsReview = 1; // 待讨论（计划 5.1.8）
        insertItem.run(
          itemId,
          projectId,"""
new = """      // 项目归属（M1.1）：只有来源被用户/导入明确绑定项目时才直接归属；
      // 模型的 project_hint 猜测只是建议 —— 条目进入待讨论并记录建议项目，
      // 不悄悄加入某个项目的正式背景。
        let projectId = source.project_id;
        let needsReview = 0;
        let suggestedProjectId: string | null = null;
        if (!projectId && row.project_hint) {
          const m = this.db
            .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE')
            .get(row.project_hint) as { id: string } | undefined;
          if (m) suggestedProjectId = m.id;
        }
        if (!projectId) needsReview = 1; // 待讨论（计划 5.1.8）
        insertItem.run(
          itemId,
          projectId,"""
assert old in c, "extractor anchor"
c = c.replace(old, new)

old2 = """          EXTRACT_PROMPT_VERSION,
          this.provider.modelName,
          needsReview,
        );"""
new2 = """          EXTRACT_PROMPT_VERSION,
          this.provider.modelName,
          needsReview,
          suggestedProjectId,
        );"""
assert old2 in c, "insertItem args anchor"
c = c.replace(old2, new2)

old3 = """      const insertItem = this.db.prepare(
      `INSERT INTO items (id, project_id, type, statement, rationale, state, confidence,
         origin, observed_at, created_at, updated_at, extracted_from_source_id,
         prompt_version, model_name, needs_review)
       VALUES (?, ?, ?, ?, ?, 'current', ?, 'ai', ?, ?, ?, ?, ?, ?, ?)`,
    );"""
new3 = """      const insertItem = this.db.prepare(
      `INSERT INTO items (id, project_id, type, statement, rationale, state, confidence,
         origin, observed_at, created_at, updated_at, extracted_from_source_id,
         prompt_version, model_name, needs_review, suggested_project_id)
       VALUES (?, ?, ?, ?, ?, 'current', ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );"""
assert old3 in c, "insertItem stmt anchor"
c = c.replace(old3, new3)
io.open(f, "w", encoding="utf-8", newline="\n").write(c)
print("extractor ok")

# ---- 3) merge: carry temp project_id to formal source ----
f = "apps/desktop/src/main/server/localServer.ts"
c = io.open(f, encoding="utf-8").read()
old4 = """      const temp = db
        .prepare(
          'SELECT s.id, s.permission_id, s.captured_at, s.title, s.metadata_json, s.external_id FROM sources s ' +
            "WHERE s.provider = 'chatgpt_web' AND s.external_id LIKE 'page:%' " +
            'ORDER BY s.imported_at DESC',
        )
        .all() as Array<{
        id: string;
        permission_id: string;
        captured_at: string | null;
        title: string;
        metadata_json: string;
        external_id: string;
      }>;"""
new4 = """      const temp = db
        .prepare(
          'SELECT s.id, s.permission_id, s.captured_at, s.title, s.metadata_json, s.external_id, s.project_id FROM sources s ' +
            "WHERE s.provider = 'chatgpt_web' AND s.external_id LIKE 'page:%' " +
            'ORDER BY s.imported_at DESC',
        )
        .all() as Array<{
        id: string;
        permission_id: string;
        captured_at: string | null;
        title: string;
        metadata_json: string;
        external_id: string;
        project_id: string | null;
      }>;"""
assert old4 in c, "temp query anchor"
c = c.replace(old4, new4)

old5 = """            batch.clientTimestamp,
            now,
            t.permission_id,
            JSON.stringify(mergeMetadata(batch.conversation.sessionId, t.metadata_json)),
          );"""
new5 = """            batch.clientTimestamp,
            now,
            t.permission_id,
            JSON.stringify(mergeMetadata(batch.conversation.sessionId, t.metadata_json)),
          );
          void 0;"""
# actually replace project NULL with carry-over: the INSERT uses NULL for project_id
old5b = """            `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
              captured_at, imported_at, permission_id, project_id, metadata_json)
             VALUES (?, 'conversation', 'chatgpt_web', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,"""
new5b = """            `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
              captured_at, imported_at, permission_id, project_id, metadata_json)
             VALUES (?, 'conversation', 'chatgpt_web', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,"""
assert old5b in c, "merge insert anchor"
c = c.replace(old5b, new5b)
old5c = """            batch.clientTimestamp,
            now,
            t.permission_id,
            JSON.stringify(mergeMetadata(batch.conversation.sessionId, t.metadata_json)),
          );"""
new5c = """            batch.clientTimestamp,
            now,
            t.permission_id,
            t.project_id, // M1.1：草稿的项目绑定随身份转正继承
            JSON.stringify(mergeMetadata(batch.conversation.sessionId, t.metadata_json)),
          );"""
assert old5c in c, "merge args anchor"
c = c.replace(old5c, new5c)
io.open(f, "w", encoding="utf-8", newline="\n").write(c)
print("merge carry ok")
