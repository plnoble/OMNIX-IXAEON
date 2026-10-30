import { z } from 'zod';
/** K2 驾驶舱快照（规格 docs/委派/K2-驾驶舱快照.md）：只读汇总，不含密钥、inbox 正文。 */
export const sourceHealthSchema = z.object({
  status: z.enum(['ok', 'stale', 'missing', 'error']),
  readAt: z.string(),
  lastEventAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;
export const attentionItemSchema = z.object({
  kind: z.enum(['relay_down', 'turn_unfinished', 'relay_stale', 'relay_stopped', 'queue_user']),
  project: z.string().nullable(),
  text: z.string(),
  since: z.string().nullable(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export const runningItemSchema = z.object({
  kind: z.enum(['relay', 'turn', 'paused_role']),
  role: z.string().nullable(),
  taskId: z.string().nullable(),
  startedAt: z.string().nullable(),
  until: z.string().nullable(),
  text: z.string(),
});
export type RunningItem = z.infer<typeof runningItemSchema>;
export const recentEventSchema = z.object({
  at: z.string(),
  role: z.string(),
  taskId: z.string().nullable(),
  outcome: z.enum(['done', 'failed', 'timeout', 'quota', 'other']),
  text: z.string(),
});
export type RecentEvent = z.infer<typeof recentEventSchema>;
export const projectCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  description: z.string().nullable(),
  currentState: z.string().nullable(),
  updatedAt: z.string(),
});
export type ProjectCard = z.infer<typeof projectCardSchema>;
export const cockpitSnapshotSchema = z.object({
  generatedAt: z.string(),
  sources: z.object({
    relay: sourceHealthSchema,
    queue: sourceHealthSchema,
    projects: sourceHealthSchema,
  }),
  attention: z.array(attentionItemSchema),
  running: z.array(runningItemSchema),
  projects: z.object({
    active: z.array(projectCardSchema),
    paused: z.array(projectCardSchema),
    archived: z.array(projectCardSchema),
  }),
  recent: z.array(recentEventSchema).max(20),
  today: z.object({ finishedTurns: z.number().int() }),
});
export type CockpitSnapshot = z.infer<typeof cockpitSnapshotSchema>;
