import type { CoreDatabase } from '../db/database.js';
import {
  isUnadoptedAiAdvice,
  type Item,
  type Project,
  type ProjectRelation,
  type ResearchFinding,
} from '@ixaeon/contracts';
import { RelationService } from '../orchestration/relationStore.js';
import { isEphemeralStatement } from '../memory/ephemeral.js';
import { mentionedDays, pastEventDay } from '../memory/temporal.js';
import { needsUserAttention } from '../storage/needsReview.js';
import { OVERVIEW_FINDINGS_SEEN_AT, getSetting, setSetting } from '../settings.js';
import {
  listMatchedFindings,
  MATCH_WINDOW_DAYS,
  type MatchedFinding,
} from '../research/requirements.js';

export interface PersonalOverview {
  generatedAt: string;
  goals: Item[];
  constraints: Item[];
  unknowns: Item[];
  conflicts: Item[];
  /**
   * E1：看起来已经结束的事——内容里写的日期已经过去，用户还没表态。
   * 首页给一键「确认已结束 / 还没结束」；表过态的不再出现在这里。
   */
  pastSuggestions: Array<{ item: Item; day: string }>;
  /**
   * E1：整份资料里写了日期的事都已经过去、也没有还没到的日期——建议整份归档为过往的事。
   * 单条判断会漏掉「同一件事、但这句没写日期」的条目（真机：同一次出差的安排里，
   * 好几条事项都没写日期），整份归档让它们一起退场，只留一段经验摘要。
   */
  pastSources: Array<{
    sourceId: string;
    title: string;
    lastDay: string;
    pastItems: number;
    totalItems: number;
  }>;
  projects: Array<{
    project: Project;
    goals: Item[];
    constraints: Item[];
  }>;
  relations: ProjectRelation[];
  /** 用户在研究页标过「值得行动」的发现；外部线索，不是用户目标。 */
  researchFollowUps: Array<
    Pick<
      ResearchFinding,
      'id' | 'title' | 'url' | 'excerpt' | 'action_reason' | 'related_project_id'
    >
  >;
  /** W1b：已启用研究主题最近 7 天的发现，最新在前，最多 10 条。 */
  recentFindings: Array<{
    id: string;
    title: string;
    url: string;
    topicQuestion: string;
    fetchedAt: string;
    isNew: boolean;
  }>;
  matchedFindings: MatchedFinding[];
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
      `SELECT i.* FROM items i
       LEFT JOIN sources s ON s.id = i.extracted_from_source_id
       WHERE i.state IN ('current', 'disputed')
         AND i.confirmation != 'rejected'
         AND i.shelved_at IS NULL
         AND (s.archived_at IS NULL OR i.origin = 'user')
         AND NOT (i.origin = 'ai' AND i.type = 'project_summary' AND i.rationale LIKE '归档经验摘要%')
       ORDER BY CASE WHEN i.origin = 'user' THEN 0
                     WHEN i.confirmation = 'confirmed' THEN 1
                     ELSE 2 END, i.updated_at DESC`,
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
    time_status: (row['time_status'] as Item['time_status']) ?? null,
    said_by: (row['said_by'] as Item['said_by']) ?? null,
  });
  const all = items.map(toItem);
  // E6：首页「要你拍板」只放真正需要用户的（冲突、要求继续待处理、编码结果），与待讨论页同一规则
  const needsUser = new Set(
    items
      .filter((r) =>
        needsUserAttention({
          state: String(r['state']),
          origin: String(r['origin']),
          needs_reasons: String(r['needs_reasons'] ?? ''),
        }),
      )
      .map((r) => String(r['id'])),
  );
  // E1：已经结束的事不当作「目标」列出（用户说还没结束的除外）。条目时间戳是导入分析的
  // 日期，不是事情发生的日期——看内容里写的日期（memory/temporal.ts）。
  const pastDay = (i: Item): string | null =>
    i.time_status === 'ongoing' ? null : pastEventDay(i.statement, i.observed_at ?? i.created_at);
  const isOver = (i: Item): boolean => i.time_status === 'ended' || pastDay(i) !== null;

  // 按来源汇总：写了日期的全都过去（至少 2 条）、没有还没到的日期、用户也没说过哪条还没结束。
  // 问答存档（ask_session）不参与：那是聊天本身，之后还可能继续同一个对话。
  const bySource = new Map<string, Item[]>();
  for (const i of all) {
    if (!i.extracted_from_source_id) continue;
    const list = bySource.get(i.extracted_from_source_id) ?? [];
    list.push(i);
    bySource.set(i.extracted_from_source_id, list);
  }
  const sourceInfo = db.prepare('SELECT title, provider, archived_at FROM sources WHERE id = ?');
  const pastSources: PersonalOverview['pastSources'] = [];
  for (const [sourceId, list] of bySource) {
    const src = sourceInfo.get(sourceId) as
      { title: string; provider: string; archived_at: string | null } | undefined;
    if (!src || src.archived_at || src.provider === 'ask_session') continue;
    if (list.some((i) => i.time_status === 'ongoing')) continue;
    const days = list.map((i) => pastDay(i)).filter((d): d is string => d !== null);
    const upcoming = list.some(
      (i) =>
        pastDay(i) === null && mentionedDays(i.statement, i.observed_at ?? i.created_at).length > 0,
    );
    if (days.length < 2 || upcoming) continue;
    pastSources.push({
      sourceId,
      title: src.title,
      lastDay: days.reduce((a, b) => (a > b ? a : b)),
      pastItems: days.length,
      totalItems: list.length,
    });
  }
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Project[];
  const analyzed = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM sources WHERE archived_at IS NULL AND COALESCE(analyzed_revision, 0) >= COALESCE(content_revision, 0) AND COALESCE(content_revision, 0) > 0',
      )
      .get() as { n: number }
  ).n;
  const unanalyzed = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM sources WHERE archived_at IS NULL AND COALESCE(content_revision, 0) > COALESCE(analyzed_revision, 0)',
      )
      .get() as { n: number }
  ).n;
  return {
    generatedAt: new Date().toISOString(),
    goals: all.filter(
      (i) =>
        i.type === 'goal' &&
        (i.scope === 'personal' || i.project_id === null) &&
        (i.origin === 'user' || i.confirmation === 'confirmed') &&
        !isEphemeralStatement(i.statement) &&
        !isOver(i),
    ),
    // E3：AI 在对话里给的建议（用户没采纳）不是用户的约束，也不是用户要处理的事
    constraints: all.filter(
      (i) =>
        i.type === 'constraint' &&
        (i.scope === 'personal' || i.project_id === null) &&
        !isUnadoptedAiAdvice(i),
    ),
    unknowns: all.filter((i) => {
      if (i.state === 'disputed') return true;
      if (!i.needs_review) return false;
      if (isUnadoptedAiAdvice(i)) return false;
      // 普通未整理/未确认提取可在理解页查看，不刷成首页作业（E6：只放真正要用户拍板的）
      return needsUser.has(i.id);
    }),
    conflicts: all.filter((i) => i.state === 'disputed'),
    pastSuggestions: all
      .filter((i) => i.time_status === null)
      .map((item) => ({ item, day: pastDay(item) }))
      .filter((x): x is { item: Item; day: string } => x.day !== null)
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, 20),
    pastSources: pastSources.sort((a, b) => (a.lastDay < b.lastDay ? 1 : -1)),
    projects: projects.map((p) => ({
      project: p,
      goals: all.filter(
        (i) =>
          i.project_id === p.id &&
          i.type === 'goal' &&
          (i.origin === 'user' || i.confirmation === 'confirmed') &&
          !isEphemeralStatement(i.statement) &&
          !isOver(i),
      ),
      constraints: all.filter(
        (i) => i.project_id === p.id && i.type === 'constraint' && !isUnadoptedAiAdvice(i),
      ),
    })),
    relations: new RelationService(db).list({ includeStale: true }),
    researchFollowUps: db
      .prepare(
        `SELECT id, title, url, excerpt, action_reason, related_project_id
           FROM research_findings WHERE action_worthy = 1
           ORDER BY created_at DESC LIMIT 20`,
      )
      .all() as Array<
      Pick<
        ResearchFinding,
        'id' | 'title' | 'url' | 'excerpt' | 'action_reason' | 'related_project_id'
      >
    >,
    recentFindings: listRecentFindings(db),
    matchedFindings: listMatchedFindings(db, {
      since: new Date(Date.now() - MATCH_WINDOW_DAYS * 86_400_000).toISOString(),
    }),
    coverage: {
      projectCount: projects.length,
      analyzedSources: analyzed,
      unanalyzedSources: unanalyzed,
      unassignedItems: all.filter((i) => i.scope === 'unassigned').length,
    },
  };
}

function listRecentFindings(db: CoreDatabase): PersonalOverview['recentFindings'] {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const seenAt = getSetting(db, OVERVIEW_FINDINGS_SEEN_AT)?.value ?? null;
  const rows = db
    .prepare(
      `SELECT f.id, f.title, f.url, t.question AS topicQuestion, f.fetched_at AS fetchedAt
         FROM research_findings f
         JOIN research_topics t ON t.id = f.topic_id
        WHERE t.enabled = 1 AND f.fetched_at >= ?
        ORDER BY f.fetched_at DESC
        LIMIT 10`,
    )
    .all(cutoff) as Array<{
    id: string;
    title: string;
    url: string;
    topicQuestion: string;
    fetchedAt: string;
  }>;
  return rows.map((row) => ({
    ...row,
    isNew: seenAt === null || row.fetchedAt > seenAt,
  }));
}

/** W1b：把「上次看过」设为现在。IPC markFindingsSeen 走这里。 */
export function markOverviewFindingsSeen(db: CoreDatabase, at = new Date().toISOString()): void {
  setSetting(db, OVERVIEW_FINDINGS_SEEN_AT, at);
}
