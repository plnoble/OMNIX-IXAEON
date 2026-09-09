import type { CoreDatabase } from '../db/database.js';
import type { Item, Project, ProjectRelation } from '@ixaeon/contracts';
import { RelationService } from '../orchestration/relationStore.js';

export interface PersonalOverview {
  generatedAt: string;
  goals: Item[];
  constraints: Item[];
  unknowns: Item[];
  conflicts: Item[];
  projects: Array<{
    project: Project;
    goals: Item[];
    constraints: Item[];
  }>;
  relations: ProjectRelation[];
  coverage: {
    projectCount: number;
    analyzedSources: number;
    unanalyzedSources: number;
    unassignedItems: number;
  };
}

/**
 * 个人总览：从全部获准候选按类型筛选，不把「最近 60 条」包装成完整理解。
 */
export function buildPersonalOverview(db: CoreDatabase): PersonalOverview {
  const items = db
    .prepare(
      `SELECT * FROM items
       WHERE state IN ('current', 'disputed')
         AND confirmation != 'rejected'
         AND shelved_at IS NULL
       ORDER BY CASE WHEN origin = 'user' THEN 0
                     WHEN confirmation = 'confirmed' THEN 1
                     ELSE 2 END, updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const toItem = (row: Record<string, unknown>): Item => ({
    id: row['id'] as string,
    project_id: (row['project_id'] as string | null) ?? null,
    scope: (row['scope'] as Item['scope']) ?? 'unassigned',
    type: row['type'] as Item['type'],
    statement: row['statement'] as string,
    rationale: (row['rationale'] as string | null) ?? null,
    state: row['state'] as Item['state'],
    confidence: row['confidence'] as number,
    origin: row['origin'] as Item['origin'],
    observed_at: (row['observed_at'] as string | null) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    supersedes_item_id: (row['supersedes_item_id'] as string | null) ?? null,
    extracted_from_source_id: (row['extracted_from_source_id'] as string | null) ?? null,
    prompt_version: (row['prompt_version'] as string | null) ?? null,
    model_name: (row['model_name'] as string | null) ?? null,
    needs_review: (row['needs_review'] as number) === 1,
    shelved_at: (row['shelved_at'] as string | null) ?? null,
    confirmation: (row['confirmation'] as Item['confirmation']) ?? 'none',
    confirmation_at: (row['confirmation_at'] as string | null) ?? null,
    manual_project: (row['manual_project'] as number) === 1,
  });
  const all = items.map(toItem);
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Project[];
  const analyzed = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM sources WHERE COALESCE(analyzed_revision, 0) >= COALESCE(content_revision, 0) AND COALESCE(content_revision, 0) > 0',
      )
      .get() as { n: number }
  ).n;
  const unanalyzed = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM sources WHERE COALESCE(content_revision, 0) > COALESCE(analyzed_revision, 0)',
      )
      .get() as { n: number }
  ).n;
  return {
    generatedAt: new Date().toISOString(),
    goals: all.filter(
      (i) => i.type === 'goal' && (i.scope === 'personal' || i.project_id === null),
    ),
    constraints: all.filter(
      (i) => i.type === 'constraint' && (i.scope === 'personal' || i.project_id === null),
    ),
    unknowns: all.filter(
      (i) => i.needs_review || i.scope === 'unassigned' || i.confirmation === 'none',
    ),
    conflicts: all.filter((i) => i.state === 'disputed'),
    projects: projects.map((p) => ({
      project: p,
      goals: all.filter((i) => i.project_id === p.id && i.type === 'goal'),
      constraints: all.filter((i) => i.project_id === p.id && i.type === 'constraint'),
    })),
    relations: new RelationService(db).list({ includeStale: true }),
    coverage: {
      projectCount: projects.length,
      analyzedSources: analyzed,
      unanalyzedSources: unanalyzed,
      unassignedItems: all.filter((i) => i.scope === 'unassigned').length,
    },
  };
}
