import { createHash, randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/database.js';
import {
  ErrorCodes,
  IxaError,
  type ProjectRelation,
  type RelationKind,
  type RelationStatus,
  type RelationVerification,
} from '@ixaeon/contracts';

export interface RelationEvidence {
  itemId?: string;
  segmentId?: string;
  note?: string;
}

export interface ProposeRelationInput {
  kind: RelationKind;
  fromProjectId: string;
  toEntityKind: 'project' | 'item';
  toEntityId: string;
  rationale: string;
  evidence: RelationEvidence[];
  proposer?: 'system' | 'user';
  benefit?: string | null;
  cost?: string | null;
  prerequisites?: string | null;
  independentAlternative?: string | null;
}

function fingerprintOf(input: {
  kind: RelationKind;
  fromProjectId: string;
  toEntityKind: string;
  toEntityId: string;
  evidence: RelationEvidence[];
}): string {
  const ids = input.evidence
    .map((e) => `${e.itemId ?? ''}|${e.segmentId ?? ''}|${e.note ?? ''}`)
    .sort()
    .join(';');
  return createHash('sha256')
    .update(`${input.kind}|${input.fromProjectId}|${input.toEntityKind}|${input.toEntityId}|${ids}`)
    .digest('hex');
}

function toRelation(row: Record<string, unknown>): ProjectRelation {
  return {
    id: row['id'] as string,
    kind: row['kind'] as RelationKind,
    from_project_id: row['from_project_id'] as string,
    to_entity_kind: row['to_entity_kind'] as 'project' | 'item',
    to_entity_id: row['to_entity_id'] as string,
    rationale: row['rationale'] as string,
    evidence_json: row['evidence_json'] as string,
    evidence_fingerprint: row['evidence_fingerprint'] as string,
    proposer: row['proposer'] as 'system' | 'user',
    status: row['status'] as RelationStatus,
    verification: row['verification'] as RelationVerification,
    benefit: (row['benefit'] as string | null) ?? null,
    cost: (row['cost'] as string | null) ?? null,
    prerequisites: (row['prerequisites'] as string | null) ?? null,
    independent_alternative: (row['independent_alternative'] as string | null) ?? null,
    stale: (row['stale'] as number) === 1,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    reviewed_at: (row['reviewed_at'] as string | null) ?? null,
    supersedes_id: (row['supersedes_id'] as string | null) ?? null,
  };
}

/**
 * 跨项目关系提案。不移动资料、不改仓库、不把 accepted 当成已联通。
 */
export class RelationService {
  constructor(private readonly db: CoreDatabase) {}

  propose(input: ProposeRelationInput): ProjectRelation | null {
    const from = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(input.fromProjectId) as { id: string } | undefined;
    if (!from) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${input.fromProjectId}`);
    if (input.toEntityKind === 'project') {
      if (input.toEntityId === input.fromProjectId) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, '不能把项目关联到自身');
      }
      const to = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(input.toEntityId) as
        { id: string } | undefined;
      if (!to) throw new IxaError(ErrorCodes.NOT_FOUND, `目标项目不存在: ${input.toEntityId}`);
    } else {
      const item = this.db.prepare('SELECT id FROM items WHERE id = ?').get(input.toEntityId) as
        { id: string } | undefined;
      if (!item) throw new IxaError(ErrorCodes.NOT_FOUND, `目标条目不存在: ${input.toEntityId}`);
    }
    const rationale = input.rationale.trim();
    if (rationale.length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '关系必须说明理由');
    }
    if (input.evidence.length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '没有足够证据时不强行生成连接');
    }
    const fp = fingerprintOf({
      kind: input.kind,
      fromProjectId: input.fromProjectId,
      toEntityKind: input.toEntityKind,
      toEntityId: input.toEntityId,
      evidence: input.evidence,
    });
    const existing = this.db
      .prepare(
        `SELECT * FROM project_relations
         WHERE evidence_fingerprint = ? AND from_project_id = ? AND to_entity_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(fp, input.fromProjectId, input.toEntityId) as Record<string, unknown> | undefined;
    if (existing) {
      const rel = toRelation(existing);
      // 同样依据被拒绝后不再催促
      if (rel.status === 'rejected') return null;
      if (rel.status === 'proposed' || rel.status === 'accepted') return rel;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO project_relations (
           id, kind, from_project_id, to_entity_kind, to_entity_id, rationale,
           evidence_json, evidence_fingerprint, proposer, status, verification,
           benefit, cost, prerequisites, independent_alternative, stale,
           created_at, updated_at, reviewed_at, supersedes_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'unverified', ?, ?, ?, ?, 0, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        input.kind,
        input.fromProjectId,
        input.toEntityKind,
        input.toEntityId,
        rationale,
        JSON.stringify(input.evidence),
        fp,
        input.proposer ?? 'system',
        input.benefit ?? null,
        input.cost ?? null,
        input.prerequisites ?? null,
        input.independentAlternative ?? null,
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): ProjectRelation {
    const row = this.db.prepare('SELECT * FROM project_relations WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `关系不存在: ${id}`);
    return toRelation(row);
  }

  list(filter?: { status?: RelationStatus; includeStale?: boolean }): ProjectRelation[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (!filter?.includeStale) {
      where.push('stale = 0');
    }
    const sql = `SELECT * FROM project_relations ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map(toRelation);
  }

  accept(id: string): ProjectRelation {
    return this.setStatus(id, 'accepted');
  }

  reject(id: string): ProjectRelation {
    return this.setStatus(id, 'rejected');
  }

  /**
   * 出现新实质证据时提出带说明的新版本；旧提案标 superseded。
   * 指纹必须与旧提案不同，否则视为重复催促。
   */
  proposeRevision(oldId: string, input: ProposeRelationInput): ProjectRelation | null {
    const old = this.get(oldId);
    const next = this.propose(input);
    if (!next) return null;
    if (next.id === old.id) return next;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE project_relations SET status = 'superseded', updated_at = ?, reviewed_at = ? WHERE id = ? AND status = 'proposed'`,
      )
      .run(now, now, oldId);
    this.db
      .prepare('UPDATE project_relations SET supersedes_id = ? WHERE id = ?')
      .run(oldId, next.id);
    return this.get(next.id);
  }

  setVerification(id: string, verification: RelationVerification): ProjectRelation {
    const rel = this.get(id);
    if (rel.status !== 'accepted') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '只有已接受的关系才能记录联通验证结果');
    }
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE project_relations SET verification = ?, updated_at = ? WHERE id = ?')
      .run(verification, now, id);
    return this.get(id);
  }

  /** 纠正/撤销依据后，旧关系标记待复核，不继续作为确定事实。 */
  markStaleForItem(itemId: string): number {
    const rows = this.db
      .prepare('SELECT id, evidence_json FROM project_relations WHERE stale = 0 AND status != ?')
      .all('superseded') as Array<{ id: string; evidence_json: string }>;
    let n = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      let evidence: RelationEvidence[] = [];
      try {
        evidence = JSON.parse(row.evidence_json) as RelationEvidence[];
      } catch {
        continue;
      }
      if (evidence.some((e) => e.itemId === itemId)) {
        this.db
          .prepare('UPDATE project_relations SET stale = 1, updated_at = ? WHERE id = ?')
          .run(now, row.id);
        n += 1;
      }
    }
    return n;
  }

  private setStatus(id: string, status: 'accepted' | 'rejected'): ProjectRelation {
    const rel = this.get(id);
    if (rel.status !== 'proposed') {
      throw new IxaError(
        ErrorCodes.VALIDATION_FAILED,
        `只有提案状态可以${status === 'accepted' ? '确认' : '不采纳'}`,
      );
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE project_relations SET status = ?, updated_at = ?, reviewed_at = ? WHERE id = ?',
      )
      .run(status, now, now, id);
    return this.get(id);
  }
}

/**
 * 基于当前理解生成候选关系。不靠项目名称硬编码，不自动移动资料。
 * 证据不足则不生成。
 */
export function proposeObviousRelations(db: CoreDatabase): Array<ProjectRelation | null> {
  const relations = new RelationService(db);
  const out: Array<ProjectRelation | null> = [];
  const projects = db
    .prepare('SELECT id, name FROM projects WHERE status != ?')
    .all('archived') as Array<{ id: string; name: string }>;
  const goals = db
    .prepare(
      `SELECT id, project_id, statement FROM items
       WHERE type = 'goal' AND state IN ('current', 'disputed')
         AND confirmation != 'rejected' AND shelved_at IS NULL`,
    )
    .all() as Array<{ id: string; project_id: string | null; statement: string }>;
  const constraints = db
    .prepare(
      `SELECT id, project_id, statement FROM items
       WHERE type = 'constraint' AND state IN ('current', 'disputed')
         AND confirmation != 'rejected' AND shelved_at IS NULL`,
    )
    .all() as Array<{ id: string; project_id: string | null; statement: string }>;

  // 项目条目服务于个人目标：用陈述 token 重叠，而不是项目名。
  const personalGoals = goals.filter((g) => g.project_id === null);
  for (const project of projects) {
    const projectGoals = goals.filter((g) => g.project_id === project.id);
    for (const pg of projectGoals) {
      for (const personal of personalGoals) {
        if (!sharesToken(pg.statement, personal.statement)) continue;
        out.push(
          relations.propose({
            kind: 'serves_goal',
            fromProjectId: project.id,
            toEntityKind: 'item',
            toEntityId: personal.id,
            rationale: `项目目标「${pg.statement}」与个人目标「${personal.statement}」有共同主题，可能服务于同一方向。`,
            evidence: [
              { itemId: pg.id, note: pg.statement },
              { itemId: personal.id, note: personal.statement },
            ],
            benefit: '减少重复建设、统一方向',
            cost: '过早合并可能绑死独立节奏',
            independentAlternative: '保持独立，只在个人总览对照目标',
            proposer: 'system',
          }),
        );
      }
    }
  }

  // 疑似重复：两个项目的目标陈述有实质重叠（仍不靠项目名）。
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i]!;
      const b = projects[j]!;
      const aGoals = goals.filter((g) => g.project_id === a.id);
      const bGoals = goals.filter((g) => g.project_id === b.id);
      for (const ag of aGoals) {
        for (const bg of bGoals) {
          if (!sharesToken(ag.statement, bg.statement)) continue;
          out.push(
            relations.propose({
              kind: 'suspected_duplicate',
              fromProjectId: a.id,
              toEntityKind: 'project',
              toEntityId: b.id,
              rationale: `「${ag.statement}」与「${bg.statement}」主题接近，可能存在重复建设。`,
              evidence: [
                { itemId: ag.id, note: ag.statement },
                { itemId: bg.id, note: bg.statement },
              ],
              benefit: '合并后少维护一套目标',
              cost: '误合并会丢掉独立约束',
              independentAlternative: '保持独立，只共享个人层目标',
              proposer: 'system',
            }),
          );
        }
      }
      const aCons = constraints.filter((c) => c.project_id === a.id);
      const bCons = constraints.filter((c) => c.project_id === b.id);
      for (const ac of aCons) {
        for (const bc of bCons) {
          if (!opposing(ac.statement, bc.statement)) continue;
          out.push(
            relations.propose({
              kind: 'conflict',
              fromProjectId: a.id,
              toEntityKind: 'project',
              toEntityId: b.id,
              rationale: `约束「${ac.statement}」与「${bc.statement}」可能冲突，需要核实而不是强行连接。`,
              evidence: [
                { itemId: ac.id, note: ac.statement },
                { itemId: bc.id, note: bc.statement },
              ],
              independentAlternative: '保持独立，分别遵守各自约束',
              proposer: 'system',
            }),
          );
        }
      }
    }
  }
  return out;
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const ascii = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  for (const w of ascii) out.add(w);
  const cjk = [...text].filter((ch) => /[\u4e00-\u9fff]/.test(ch)).join('');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  return out;
}

function sharesToken(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  let n = 0;
  for (const t of ta) if (tb.has(t)) n += 1;
  return n >= 2;
}

function opposing(a: string, b: string): boolean {
  const pair = [
    ['必须云端', '必须本地'],
    ['禁止联网', '需要联网'],
    ['公开', '保密'],
  ];
  const x = `${a}|${b}`;
  return pair.some(
    ([p, q]) =>
      (a.includes(p!) && b.includes(q!)) ||
      (a.includes(q!) && b.includes(p!)) ||
      x.includes(`${p}|${q}`),
  );
}
