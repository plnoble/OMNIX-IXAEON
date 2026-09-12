import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import {
  ErrorCodes,
  IxaError,
  type ResearchFinding,
  type ResearchRun,
  type ResearchSource,
  type ResearchSourceKind,
  type ResearchTopic,
} from '@ixaeon/contracts';
import { assertPublicHttpsUrl } from './urlSafety.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function bool(v: unknown): boolean {
  return v === 1 || v === true;
}

function toTopic(row: Record<string, unknown>): ResearchTopic {
  return {
    id: row['id'] as string,
    question: row['question'] as string,
    public_description: row['public_description'] as string,
    related_goal_id: (row['related_goal_id'] as string | null) ?? null,
    related_project_id: (row['related_project_id'] as string | null) ?? null,
    enabled: bool(row['enabled']),
    paused: bool(row['paused']),
    interval_ms: row['interval_ms'] as number,
    max_pages_per_run: row['max_pages_per_run'] as number,
    paid_budget_mode: row['paid_budget_mode'] as ResearchTopic['paid_budget_mode'],
    request_cap: row['request_cap'] as number,
    generation: row['generation'] as number,
    last_success_at: (row['last_success_at'] as string | null) ?? null,
    last_failure_at: (row['last_failure_at'] as string | null) ?? null,
    last_failure: (row['last_failure'] as string | null) ?? null,
    consecutive_failures: row['consecutive_failures'] as number,
    next_check_at: (row['next_check_at'] as string | null) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
  };
}

function toSource(row: Record<string, unknown>): ResearchSource {
  return {
    id: row['id'] as string,
    topic_id: row['topic_id'] as string,
    url: row['url'] as string,
    kind: row['kind'] as ResearchSourceKind,
    last_fingerprint: (row['last_fingerprint'] as string | null) ?? null,
    last_checked_at: (row['last_checked_at'] as string | null) ?? null,
    last_success_at: (row['last_success_at'] as string | null) ?? null,
    last_error: (row['last_error'] as string | null) ?? null,
    created_at: row['created_at'] as string,
  };
}

function toFinding(row: Record<string, unknown>): ResearchFinding {
  return {
    id: row['id'] as string,
    topic_id: row['topic_id'] as string,
    source_id: row['source_id'] as string,
    title: row['title'] as string,
    url: row['url'] as string,
    excerpt: row['excerpt'] as string,
    content_fingerprint: row['content_fingerprint'] as string,
    evidence_class: row['evidence_class'] as ResearchFinding['evidence_class'],
    claimed_published_at: (row['claimed_published_at'] as string | null) ?? null,
    fetched_at: row['fetched_at'] as string,
    related_goal_id: (row['related_goal_id'] as string | null) ?? null,
    related_project_id: (row['related_project_id'] as string | null) ?? null,
    speculation: (row['speculation'] as string | null) ?? null,
    action_worthy: bool(row['action_worthy']),
    action_reason: (row['action_reason'] as string | null) ?? null,
    limitations: (row['limitations'] as string | null) ?? null,
    next_experiment: (row['next_experiment'] as string | null) ?? null,
    notified: bool(row['notified']),
    created_at: row['created_at'] as string,
  };
}

function toRun(row: Record<string, unknown>): ResearchRun {
  return {
    id: row['id'] as string,
    topic_id: row['topic_id'] as string,
    generation: row['generation'] as number,
    status: row['status'] as ResearchRun['status'],
    pages_fetched: row['pages_fetched'] as number,
    findings_new: row['findings_new'] as number,
    error: (row['error'] as string | null) ?? null,
    started_at: row['started_at'] as string,
    finished_at: (row['finished_at'] as string | null) ?? null,
    lease_until: (row['lease_until'] as string | null) ?? null,
  };
}

export class ResearchStore {
  constructor(private readonly db: CoreDatabase) {}

  createTopic(input: {
    question: string;
    publicDescription?: string | null;
    relatedGoalId?: string | null;
    relatedProjectId?: string | null;
    sources: Array<{ url: string; kind: ResearchSourceKind }>;
    now?: string;
  }): ResearchTopic {
    const question = input.question.trim();
    const publicDescription = (input.publicDescription ?? '').trim();
    if (question.length === 0) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '研究问题不能为空');
    if (input.relatedGoalId) {
      const goal = this.db
        .prepare(`SELECT id, origin, type FROM items WHERE id = ?`)
        .get(input.relatedGoalId) as { id: string; origin: string; type: string } | undefined;
      if (!goal) throw new IxaError(ErrorCodes.NOT_FOUND, '关联目标不存在');
      if (goal.origin !== 'user' || goal.type !== 'goal') {
        throw new IxaError(
          ErrorCodes.VALIDATION_FAILED,
          '研究只能关联用户确认的目标，不能把助手建议或外部事实写成用户目标',
        );
      }
    }
    const now = input.now ?? new Date().toISOString();
    const id = randomUUID();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO research_topics (
             id, question, public_description, related_goal_id, related_project_id,
             enabled, paused, interval_ms, max_pages_per_run, paid_budget_mode, request_cap,
             generation, last_success_at, last_failure_at, last_failure, consecutive_failures,
             next_check_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, 10, 'none', 0, 0, NULL, NULL, NULL, 0, NULL, ?, ?)`,
        )
        .run(
          id,
          question,
          publicDescription,
          input.relatedGoalId ?? null,
          input.relatedProjectId ?? null,
          DEFAULT_INTERVAL_MS,
          now,
          now,
        );
      const insertSrc = this.db.prepare(
        `INSERT INTO research_sources (id, topic_id, url, kind, last_fingerprint, last_checked_at, last_success_at, last_error, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      );
      for (const src of input.sources) {
        const url = assertPublicHttpsUrl(src.url).toString();
        insertSrc.run(randomUUID(), id, url, src.kind, now);
      }
    });
    tx();
    return this.getTopic(id);
  }

  getTopic(id: string): ResearchTopic {
    const row = this.db.prepare('SELECT * FROM research_topics WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `关注主题不存在: ${id}`);
    return toTopic(row);
  }

  listTopics(): ResearchTopic[] {
    return (
      this.db.prepare('SELECT * FROM research_topics ORDER BY created_at DESC').all() as Array<
        Record<string, unknown>
      >
    ).map(toTopic);
  }

  addSource(
    topicId: string,
    input: { url: string; kind: ResearchSourceKind },
    now = new Date().toISOString(),
  ): ResearchSource {
    this.getTopic(topicId);
    const url = assertPublicHttpsUrl(input.url).toString();
    const existing = this.db
      .prepare('SELECT id FROM research_sources WHERE topic_id = ? AND url = ?')
      .get(topicId, url) as { id: string } | undefined;
    if (existing) {
      throw new IxaError(ErrorCodes.CONFLICT, '该关注已有这个来源');
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research_sources (id, topic_id, url, kind, last_fingerprint, last_checked_at, last_success_at, last_error, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(id, topicId, url, input.kind, now);
    const row = this.db.prepare('SELECT * FROM research_sources WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toSource(row);
  }

  setFindingAction(
    findingId: string,
    input: { actionWorthy: boolean; actionReason?: string | null; nextExperiment?: string | null },
  ): ResearchFinding {
    const row = this.db.prepare('SELECT * FROM research_findings WHERE id = ?').get(findingId) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `研究发现不存在: ${findingId}`);
    this.db
      .prepare(
        `UPDATE research_findings SET action_worthy = ?, action_reason = ?, next_experiment = ? WHERE id = ?`,
      )
      .run(
        input.actionWorthy ? 1 : 0,
        input.actionReason?.trim() || null,
        input.nextExperiment?.trim() || null,
        findingId,
      );
    return toFinding(
      this.db.prepare('SELECT * FROM research_findings WHERE id = ?').get(findingId) as Record<
        string,
        unknown
      >,
    );
  }

  listSources(topicId: string): ResearchSource[] {
    return (
      this.db
        .prepare('SELECT * FROM research_sources WHERE topic_id = ? ORDER BY created_at')
        .all(topicId) as Array<Record<string, unknown>>
    ).map(toSource);
  }

  listFindings(topicId?: string): ResearchFinding[] {
    const rows = topicId
      ? (this.db
          .prepare('SELECT * FROM research_findings WHERE topic_id = ? ORDER BY created_at DESC')
          .all(topicId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM research_findings ORDER BY created_at DESC LIMIT 100')
          .all() as Array<Record<string, unknown>>);
    return rows.map(toFinding);
  }

  listRuns(topicId: string): ResearchRun[] {
    return (
      this.db
        .prepare('SELECT * FROM research_runs WHERE topic_id = ? ORDER BY started_at DESC LIMIT 20')
        .all(topicId) as Array<Record<string, unknown>>
    ).map(toRun);
  }

  /** 启用自动检查。默认关闭；启用后才排期。 */
  setEnabled(id: string, enabled: boolean, now = new Date().toISOString()): ResearchTopic {
    const topic = this.getTopic(id);
    const next = enabled && !topic.paused ? now : topic.next_check_at;
    this.db
      .prepare(
        `UPDATE research_topics SET enabled = ?, next_check_at = ?, generation = generation + 1, updated_at = ? WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, enabled ? next : null, now, id);
    return this.getTopic(id);
  }

  setPaused(id: string, paused: boolean, now = new Date().toISOString()): ResearchTopic {
    const topic = this.getTopic(id);
    this.db
      .prepare(
        `UPDATE research_topics SET paused = ?, next_check_at = ?, generation = generation + 1, updated_at = ? WHERE id = ?`,
      )
      .run(paused ? 1 : 0, paused ? null : topic.enabled ? now : null, now, id);
    return this.getTopic(id);
  }

  bumpGeneration(id: string, now = new Date().toISOString()): number {
    this.db
      .prepare(
        'UPDATE research_topics SET generation = generation + 1, updated_at = ? WHERE id = ?',
      )
      .run(now, id);
    return this.getTopic(id).generation;
  }

  dueTopics(now: string): ResearchTopic[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM research_topics
           WHERE enabled = 1 AND paused = 0 AND next_check_at IS NOT NULL AND next_check_at <= ?
           ORDER BY next_check_at`,
        )
        .all(now) as Array<Record<string, unknown>>
    ).map(toTopic);
  }

  runningCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM research_runs WHERE status = 'running'`).get() as {
        n: number;
      }
    ).n;
  }

  startRun(topicId: string, now: string, leaseUntil: string): ResearchRun {
    const topic = this.getTopic(topicId);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research_runs (id, topic_id, generation, status, pages_fetched, findings_new, error, started_at, finished_at, lease_until)
         VALUES (?, ?, ?, 'running', 0, 0, NULL, ?, NULL, ?)`,
      )
      .run(id, topicId, topic.generation, now, leaseUntil);
    return this.getRun(id);
  }

  getRun(id: string): ResearchRun {
    const row = this.db.prepare('SELECT * FROM research_runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `研究运行不存在: ${id}`);
    return toRun(row);
  }

  finishRun(
    runId: string,
    input: {
      status: ResearchRun['status'];
      pagesFetched: number;
      findingsNew: number;
      error?: string | null;
      now: string;
    },
  ): ResearchRun {
    this.db
      .prepare(
        `UPDATE research_runs SET status = ?, pages_fetched = ?, findings_new = ?, error = ?, finished_at = ?, lease_until = NULL WHERE id = ?`,
      )
      .run(
        input.status,
        input.pagesFetched,
        input.findingsNew,
        input.error ?? null,
        input.now,
        runId,
      );
    return this.getRun(runId);
  }

  markSuccess(topicId: string, now: string, intervalMs: number): void {
    const next = new Date(Date.parse(now) + intervalMs).toISOString();
    this.db
      .prepare(
        `UPDATE research_topics SET last_success_at = ?, last_failure = NULL, consecutive_failures = 0, next_check_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, next, now, topicId);
  }

  markFailure(topicId: string, now: string, error: string, intervalMs: number): void {
    const next = new Date(Date.parse(now) + intervalMs).toISOString();
    this.db
      .prepare(
        `UPDATE research_topics SET last_failure_at = ?, last_failure = ?, consecutive_failures = consecutive_failures + 1, next_check_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, error.slice(0, 500), next, now, topicId);
  }

  insertFinding(input: {
    topicId: string;
    sourceId: string;
    title: string;
    url: string;
    excerpt: string;
    fingerprint: string;
    claimedPublishedAt: string | null;
    fetchedAt: string;
    relatedGoalId: string | null;
    relatedProjectId: string | null;
    expectedGeneration?: number;
  }): ResearchFinding | null {
    const topic = this.getTopic(input.topicId);
    if (input.expectedGeneration !== undefined && topic.generation !== input.expectedGeneration) {
      return null;
    }
    const existing = this.db
      .prepare('SELECT id FROM research_findings WHERE topic_id = ? AND content_fingerprint = ?')
      .get(input.topicId, input.fingerprint) as { id: string } | undefined;
    if (existing) return null;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO research_findings (
           id, topic_id, source_id, title, url, excerpt, content_fingerprint, evidence_class,
           claimed_published_at, fetched_at, related_goal_id, related_project_id, speculation,
           action_worthy, action_reason, limitations, next_experiment, notified, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'publisher', ?, ?, ?, ?, NULL, 0, NULL, '外部发布方声明，未经本机验证', NULL, 0, ?)`,
      )
      .run(
        id,
        input.topicId,
        input.sourceId,
        input.title.slice(0, 300),
        input.url,
        input.excerpt.slice(0, 800),
        input.fingerprint,
        input.claimedPublishedAt,
        input.fetchedAt,
        input.relatedGoalId,
        input.relatedProjectId,
        input.fetchedAt,
      );
    this.recordResearchCandidate(input);
    return toFinding(
      this.db.prepare('SELECT * FROM research_findings WHERE id = ?').get(id) as Record<
        string,
        unknown
      >,
    );
  }

  /**
   * 外部发现入 items，origin=research，永不写成用户目标/偏好。
   * 候选保持 needs_review，不自动确认。
   */
  private recordResearchCandidate(input: {
    title: string;
    excerpt: string;
    relatedProjectId: string | null;
  }): void {
    const now = new Date().toISOString();
    const itemId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO items (id, project_id, scope, type, statement, rationale, state, confidence,
           origin, observed_at, created_at, updated_at, needs_review, needs_reasons)
         VALUES (?, ?, ?, 'open_loop', ?, ?, 'current', 0.4, 'research', ?, ?, ?, 1, 'unconfirmed')`,
      )
      .run(
        itemId,
        input.relatedProjectId,
        input.relatedProjectId ? 'project' : 'unassigned',
        input.title.slice(0, 300),
        `外部研究摘录，未经用户确认：${input.excerpt.slice(0, 400)}`,
        now,
        now,
        now,
      );
  }

  markNotified(findingId: string): void {
    this.db.prepare('UPDATE research_findings SET notified = 1 WHERE id = ?').run(findingId);
  }

  updateSourceCheck(
    sourceId: string,
    input: { fingerprint?: string | null; error?: string | null; now: string; ok: boolean },
  ): void {
    if (input.ok) {
      this.db
        .prepare(
          `UPDATE research_sources SET last_fingerprint = ?, last_checked_at = ?, last_success_at = ?, last_error = NULL WHERE id = ?`,
        )
        .run(input.fingerprint ?? null, input.now, input.now, sourceId);
    } else {
      this.db
        .prepare('UPDATE research_sources SET last_checked_at = ?, last_error = ? WHERE id = ?')
        .run(input.now, input.error ?? '未知错误', sourceId);
    }
  }

  cancelRunning(topicId: string, now: string, reason: string): number {
    const info = this.db
      .prepare(
        `UPDATE research_runs SET status = 'cancelled', error = ?, finished_at = ?, lease_until = NULL
         WHERE topic_id = ? AND status = 'running'`,
      )
      .run(reason, now, topicId);
    return info.changes;
  }
}
