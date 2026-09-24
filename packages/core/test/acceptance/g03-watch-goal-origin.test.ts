/**
 * G03 验收（规格 docs/委派/G03-关注方向接受你说的目标.md）
 *
 * 条件 1：四种目标各一条，分别作为 relatedGoalId 建主题：
 *   人工建的（origin=user）✓、提炼出的你说的（origin=ai、said_by=user）✓、
 *   采纳过的 AI 建议（said_by=ai、confirmation=confirmed）✓、
 *   没采纳的 AI 建议（isUnadoptedAiAdvice 为真）✗ —— 报错，不建主题。
 * 条件 2：库里只有一条「提炼出的你说的」目标 → 提方向（collectWatchMemories +
 *   mapWatchDirections）→ 点关注（createTopic）成功，主题关联到这条目标。
 *
 * 判断与记忆端同一个：isUnadoptedAiAdvice（contracts/entities）。
 *
 * 整合方复审时补（2026-09-24）：「研究端和记忆端用同一个判断，不各写一套」写成可检验的
 * 性质——W1a（collectWatchMemories）会拿来当依据的目标，点「关注」一定成功；它不会拿的，
 * 一定被拒。原因：从资料里提炼的目标 said_by 为空（不是「你说的」，也不是 AI 建议），W1a
 * 会拿它提方向，但规格的「接受」清单没列它，只按清单实现的话，点「关注」照样被拒——
 * 正是 G03 要修的那种失败。标了「不对」、被取代、已结束的目标 W1a 不拿，研究端也不收。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ErrorCodes,
  IxaError,
  ItemService,
  ResearchStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../src/index.js';
import { collectWatchMemories, mapWatchDirections } from '../../src/research/watchDirections.js';

const dirs: string[] = [];
let db: CoreDatabase;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-g03-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 插入一条目标。提炼器产物的形状用 origin/said_by/confirmation 组合表达。 */
function insertGoal(input: {
  origin: 'user' | 'ai' | 'assistant_suggestion';
  saidBy: 'user' | 'ai' | null;
  confirmation?: 'none' | 'confirmed' | 'rejected';
  state?: 'current' | 'superseded';
  timeStatus?: 'ended' | null;
  statement: string;
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO items (id, type, statement, origin, said_by, confirmation, state, time_status,
                        created_at, updated_at)
     VALUES (?, 'goal', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.statement,
    input.origin,
    input.saidBy,
    input.confirmation ?? 'none',
    input.state ?? 'current',
    input.timeStatus ?? null,
    now,
    now,
  );
  return id;
}

function follow(relatedGoalId: string) {
  return new ResearchStore(db).createTopic({
    question: '这个方向值得持续看吗',
    publicDescription: 'ongoing topic watch',
    relatedGoalId,
    sources: [],
  });
}

describe('G03 关注方向接受你说的目标', () => {
  it('条件 1：人工建的、提炼出的你说的、采纳过的 AI 建议可以关联；没采纳的报错且不建', () => {
    const manual = new ItemService(db).createManual({
      projectId: null,
      type: 'goal',
      statement: '人工建的目标',
      rationale: null,
    });
    const extracted = insertGoal({ origin: 'ai', saidBy: 'user', statement: '提炼出的你说的目标' });
    const adopted = insertGoal({
      origin: 'ai',
      saidBy: 'ai',
      confirmation: 'confirmed',
      statement: '你采纳过的建议',
    });
    const unadopted = insertGoal({ origin: 'ai', saidBy: 'ai', statement: '没采纳的建议' });

    expect(follow(manual.id).related_goal_id).toBe(manual.id);
    expect(follow(extracted).related_goal_id).toBe(extracted);
    expect(follow(adopted).related_goal_id).toBe(adopted);

    const before = db.prepare('SELECT COUNT(*) AS c FROM research_topics').get() as { c: number };
    const err = (() => {
      try {
        follow(unadopted);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IxaError);
    expect((err as IxaError).code).toBe(ErrorCodes.VALIDATION_FAILED);
    const after = db.prepare('SELECT COUNT(*) AS c FROM research_topics').get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('条件 2：只有一条提炼出的你说的目标时，提方向后点关注成功并关联到它', () => {
    const goalId = insertGoal({
      origin: 'ai',
      saidBy: 'user',
      statement: '想用本地模型跑代码',
    });
    const memories = collectWatchMemories(db);
    expect(memories.map((m) => m.id)).toContain(goalId);
    const directions = mapWatchDirections(
      {
        directions: [
          {
            question: '本地模型的新进展',
            publicDescription: 'local model runtime',
            why: [goalId],
          },
        ],
      },
      memories,
      [],
      [],
    );
    expect(directions).toHaveLength(1);
    const topic = new ResearchStore(db).createTopic({
      question: directions[0]!.question,
      publicDescription: directions[0]!.publicDescription,
      relatedGoalId: directions[0]!.relatedGoalId,
      sources: [],
    });
    expect(topic.related_goal_id).toBe(goalId);
  });

  it('整合方补：研究端和 W1a 同一个判断——W1a 会拿来当依据的目标能关注，不会拿的不能', () => {
    type Shape = Omit<Parameters<typeof insertGoal>[0], 'statement'>;
    const shapes: Shape[] = [];
    for (const origin of ['user', 'ai', 'assistant_suggestion'] as const) {
      for (const saidBy of ['user', 'ai', null] as const) {
        for (const confirmation of ['none', 'confirmed', 'rejected'] as const) {
          shapes.push({ origin, saidBy, confirmation });
        }
      }
    }
    shapes.push({ origin: 'user', saidBy: 'user', state: 'superseded' });
    shapes.push({ origin: 'ai', saidBy: 'user', timeStatus: 'ended' });

    const mismatches: string[] = [];
    let proposed = 0;
    for (const [n, shape] of shapes.entries()) {
      const id = insertGoal({ ...shape, statement: `合成目标 ${n}` });
      const proposable = collectWatchMemories(db).some((m) => m.id === id);
      if (proposable) proposed += 1;
      let followed = true;
      try {
        follow(id);
      } catch (e) {
        if (!(e instanceof IxaError)) throw e;
        followed = false;
      }
      if (followed !== proposable) {
        mismatches.push(
          `${JSON.stringify(shape)}：W1a ${proposable ? '会' : '不会'}拿它，关注${followed ? '成功' : '被拒'}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    // 性质不空转：两边都有
    expect(proposed).toBeGreaterThan(0);
    expect(proposed).toBeLessThan(shapes.length);
  });
});
