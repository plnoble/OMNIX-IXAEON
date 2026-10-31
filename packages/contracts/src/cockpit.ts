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
export const projectActivitySchema = z.object({
  lastCommitAt: z.string().nullable(),
  commits7d: z.number().int().nullable(),
  readable: z.boolean(),
});
export type ProjectActivity = z.infer<typeof projectActivitySchema>;
export const projectCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  description: z.string().nullable(),
  currentState: z.string().nullable(),
  updatedAt: z.string(),
  // K4：可选——K3 已锁定的页面测试用契约类型拼模拟快照时没有这个字段。
  activity: projectActivitySchema.optional(),
});
export type ProjectCard = z.infer<typeof projectCardSchema>;
export const quotaWindowSchema = z.object({
  name: z.string(),
  usedPercent: z.number().nullable(),
  resetAt: z.string().nullable(),
});
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;
/** K4：一个账号一张卡。只含规格契约列出的字段，QuotaHub 返回里别的字段一律不进快照。 */
export const quotaCardSchema = z.object({
  source: z.enum(['quotahub', 'manual']),
  provider: z.string(),
  account: z.string(),
  status: z.string(),
  plan: z.string().nullable(),
  expiresAt: z.string().nullable(),
  windows: z.array(quotaWindowSchema),
  collectedAt: z.string(),
});
export type QuotaCard = z.infer<typeof quotaCardSchema>;
/** K4：设置页手动登记的一条额度（每项一个窗口）；核心层用同一份 zod 校验。 */
export const manualQuotaSchema = z.object({
  account: z.string().min(1),
  window: z.string().min(1),
  resetAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  registeredAt: z.string().min(1),
  note: z.string().optional(),
});
export type ManualQuota = z.infer<typeof manualQuotaSchema>;
export const cockpitSnapshotSchema = z.object({
  generatedAt: z.string(),
  sources: z.object({
    relay: sourceHealthSchema,
    queue: sourceHealthSchema,
    projects: sourceHealthSchema,
    // K4：可选——K3 已锁定的页面测试用契约类型拼模拟快照时没有这一项；快照运行时总会给。
    quotas: sourceHealthSchema.optional(),
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
  // K4：可选（同上）；没配额度来源时实现返回空数组。
  quotas: z.array(quotaCardSchema).optional(),
});
export type CockpitSnapshot = z.infer<typeof cockpitSnapshotSchema>;
