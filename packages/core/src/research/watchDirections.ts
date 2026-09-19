import { z } from 'zod';
import type { CoreDatabase } from '../db/database.js';
import { getSetting, setSetting } from '../settings.js';

export type WatchMemory = { id: string; projectId: string | null; type: string; statement: string };
export type WatchDirection = {
  question: string;
  publicDescription: string;
  basis: Array<{ id: string; statement: string }>;
  relatedGoalId: string | null;
  relatedProjectId: string | null;
};
type Pair = { question: string; publicDescription: string };
const REJECTED_KEY = 'research.watch_directions.rejected';

export function collectWatchMemories(db: CoreDatabase): WatchMemory[] {
  return db
    .prepare(
      `SELECT id, project_id AS projectId, type, statement FROM items
       WHERE type IN ('goal', 'constraint') AND state = 'current'
         AND COALESCE(confirmation, 'none') != 'rejected'
         AND COALESCE(time_status, '') != 'ended'
         AND NOT ((COALESCE(said_by, '') = 'ai' OR origin = 'assistant_suggestion')
                  AND COALESCE(confirmation, 'none') != 'confirmed')
       ORDER BY updated_at DESC LIMIT 40`,
    )
    .all() as WatchMemory[];
}

export const watchDirectionsSchema = z.object({
  directions: z.array(
    z.object({
      question: z.string().min(1),
      publicDescription: z.string().min(1),
      why: z.array(z.string()),
    }),
  ),
});

export function buildWatchPrompt(
  memories: WatchMemory[],
  projects: Array<{ name: string; description: string | null }>,
): { system: string; user: string } {
  return {
    system:
      '从目标、约束、项目提炼 3–5 个持续关注方向。question=内部问题（可带用户背景）；publicDescription=对外检索描述，不许含个人信息（人名/项目名/公司/地名/习惯），只写公开技术词；why=记忆 UUID 数组。只返回 JSON：{"directions":[{"question":"…","publicDescription":"…","why":["…"]}]}',
    user: [
      '目标与约束（每条前面的 UUID 是编号）：',
      ...memories.map((m) => `${m.id}｜${m.type === 'goal' ? '目标' : '约束'}：${m.statement}`),
      '',
      '在做的项目：',
      ...(projects.length
        ? projects.map((p) => `- ${p.name}${p.description ? `：${p.description}` : ''}`)
        : ['-（无）']),
    ].join('\n'),
  };
}

function bigrams(text: string): Set<string> {
  const s = text.replace(/[\s，。、；：,.;:!?！？]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function similar(d: Pair, known: Pair[]): boolean {
  const q = bigrams(d.question);
  const p = bigrams(d.publicDescription);
  const jac = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || b.size === 0) return 0;
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / (a.size + b.size - n);
  };
  return known.some(
    (k) => jac(q, bigrams(k.question)) >= 0.6 || jac(p, bigrams(k.publicDescription)) >= 0.6,
  );
}

export function mapWatchDirections(
  raw: z.infer<typeof watchDirectionsSchema>,
  memories: WatchMemory[],
  rejected: Pair[],
  existing: Pair[],
): WatchDirection[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const out: WatchDirection[] = [];
  for (const d of raw.directions.slice(0, 5)) {
    if (similar(d, rejected) || similar(d, existing)) continue;
    const basis = [...new Set(d.why.filter((id) => byId.has(id)))].map((id) => byId.get(id)!);
    const goal = basis.find((m) => m.type === 'goal');
    out.push({
      question: d.question,
      publicDescription: d.publicDescription,
      basis: basis.map((m) => ({ id: m.id, statement: m.statement })),
      relatedGoalId: goal?.id ?? null,
      relatedProjectId: goal?.projectId ?? basis.find((m) => m.projectId)?.projectId ?? null,
    });
  }
  return out;
}

export function listRejectedWatchDirections(db: CoreDatabase): Pair[] {
  try {
    const parsed = JSON.parse(getSetting(db, REJECTED_KEY)?.value ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (x): x is Pair =>
            !!x &&
            typeof (x as Pair).question === 'string' &&
            typeof (x as Pair).publicDescription === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

export function addRejectedWatchDirection(db: CoreDatabase, input: Pair): void {
  const list = listRejectedWatchDirections(db);
  list.push(input);
  setSetting(db, REJECTED_KEY, JSON.stringify(list.slice(-200)));
}
