import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import type { ModelProvider } from '../extraction/model/provider.js';
import { getSetting, setSetting } from '../settings.js';

export const OVERVIEW_MATCHED_SEEN_AT = 'overview.matched_seen_at';

export type ResearchRequirement = {
  id: string;
  topic_id: string;
  text: string;
  sort_order: number;
  created_at: string;
};
export type MatchedFinding = {
  id: string;
  title: string;
  url: string;
  topicQuestion: string;
  fetchedAt: string;
  isNew: boolean;
  matches: Array<{ requirementId: string; text: string; reason: string }>;
};

const verdictSchema = z.object({
  verdict: z.enum(['meets', 'fails', 'unknown']),
  reason: z.string().min(1).max(60),
});

export function listRequirements(db: CoreDatabase, topicId: string): ResearchRequirement[] {
  return db
    .prepare(
      `SELECT id, topic_id, text, sort_order, created_at FROM research_requirements
        WHERE topic_id = ? ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(topicId) as ResearchRequirement[];
}

export function addRequirement(
  db: CoreDatabase,
  input: { topicId: string; text: string },
): ResearchRequirement {
  const text = input.text.trim();
  if (text.length === 0 || text.length > 200) {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, '要求须为 1–200 字');
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO research_requirements (id, topic_id, text, sort_order, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM research_requirements WHERE topic_id = ?), ?)`,
  ).run(id, input.topicId, text, input.topicId, new Date().toISOString());
  return listRequirements(db, input.topicId).find((r) => r.id === id)!;
}

export function removeRequirement(db: CoreDatabase, id: string): void {
  db.prepare('DELETE FROM research_requirements WHERE id = ?').run(id);
}

export async function judgeFindings(
  db: CoreDatabase,
  provider: ModelProvider | null,
  topicId: string,
): Promise<{ judged: number; failed: number }> {
  const pending = db
    .prepare(
      `SELECT f.id, f.title, f.url, f.excerpt, r.id AS rid, r.text
         FROM research_findings f JOIN research_requirements r ON r.topic_id = f.topic_id
        WHERE f.topic_id = ? AND NOT EXISTS (
          SELECT 1 FROM research_finding_matches m
           WHERE m.finding_id = f.id AND m.requirement_id = r.id)
        ORDER BY f.fetched_at DESC, r.sort_order ASC`,
    )
    .all(topicId) as Array<{
    id: string;
    title: string;
    url: string;
    excerpt: string;
    rid: string;
    text: string;
  }>;
  if (!provider) return { judged: 0, failed: pending.length };
  let judged = 0,
    failed = 0;
  const insert = db.prepare(
    `INSERT INTO research_finding_matches (finding_id, requirement_id, verdict, reason, judged_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const f of pending) {
    try {
      const out = await provider.chatStructured({
        system:
          '你只根据这条发现的标题、摘录和网址，判断它是否满足用户写下的这一条要求。不要使用其它资料。只输出 JSON。',
        user: `标题：${f.title}\n摘录：${f.excerpt}\n网址：${f.url}\n要求：${f.text}`,
        schema: verdictSchema,
      });
      insert.run(f.id, f.rid, out.verdict, out.reason.slice(0, 60), new Date().toISOString());
      judged += 1;
    } catch {
      failed += 1;
    }
  }
  return { judged, failed };
}

export function listMatchedFindings(
  db: CoreDatabase,
  opts?: { since?: string; seenAt?: string | null },
): MatchedFinding[] {
  const seenAt =
    opts?.seenAt !== undefined
      ? opts.seenAt
      : (getSetting(db, OVERVIEW_MATCHED_SEEN_AT)?.value ?? null);
  const rows = db
    .prepare(
      `SELECT f.id, f.title, f.url, t.question AS topicQuestion, f.fetched_at AS fetchedAt
         FROM research_findings f JOIN research_topics t ON t.id = f.topic_id
        WHERE EXISTS (SELECT 1 FROM research_requirements r WHERE r.topic_id = f.topic_id)
          AND NOT EXISTS (
            SELECT 1 FROM research_requirements r WHERE r.topic_id = f.topic_id AND NOT EXISTS (
              SELECT 1 FROM research_finding_matches m
               WHERE m.finding_id = f.id AND m.requirement_id = r.id AND m.verdict = 'meets'))
          ${opts?.since ? 'AND f.fetched_at >= ?' : ''}
        ORDER BY f.fetched_at DESC LIMIT 20`,
    )
    .all(...(opts?.since ? [opts.since] : [])) as Array<Omit<MatchedFinding, 'isNew' | 'matches'>>;
  const matchStmt = db.prepare(
    `SELECT m.requirement_id AS requirementId, r.text, m.reason FROM research_finding_matches m
       JOIN research_requirements r ON r.id = m.requirement_id
      WHERE m.finding_id = ? AND m.verdict = 'meets' ORDER BY r.sort_order ASC`,
  );
  return rows.map((row) => ({
    ...row,
    isNew: seenAt === null || row.fetchedAt > seenAt,
    matches: matchStmt.all(row.id) as MatchedFinding['matches'],
  }));
}

export function markMatchedFindingsSeen(db: CoreDatabase, at = new Date().toISOString()): void {
  setSetting(db, OVERVIEW_MATCHED_SEEN_AT, at);
}
