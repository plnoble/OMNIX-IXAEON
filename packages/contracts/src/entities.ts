import { z } from 'zod';

/** 所有主键使用 UUID；所有时间在数据库中保存为 UTC ISO 8601 字符串。 */
export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

// ---------------------------------------------------------------------------
// permissions：用户允许读取什么
// ---------------------------------------------------------------------------

export const permissionScopeTypeSchema = z.enum(['file', 'folder', 'domain']);
export const permissionModeSchema = z.enum(['once', 'continuous']);
export const permissionStatusSchema = z.enum(['active', 'revoked']);

export const permissionSchema = z.object({
  id: uuidSchema,
  scope_type: permissionScopeTypeSchema,
  locator: z.string().min(1),
  mode: permissionModeSchema,
  status: permissionStatusSchema,
  granted_at: isoDateTimeSchema,
  revoked_at: isoDateTimeSchema.nullable(),
});
export type Permission = z.infer<typeof permissionSchema>;

// ---------------------------------------------------------------------------
// sources：原始资料登记
// ---------------------------------------------------------------------------

export const sourceKindSchema = z.enum([
  'conversation',
  'document',
  'project_snapshot',
  'work_result',
]);
export const sourceProviderSchema = z.enum([
  'chatgpt_export',
  'chatgpt_web',
  'local_file',
  'project',
  'coding_agent',
]);

export const sourceSchema = z.object({
  id: uuidSchema,
  kind: sourceKindSchema,
  provider: sourceProviderSchema,
  external_id: z.string(),
  title: z.string(),
  content_hash: z.string().length(64),
  raw_path: z.string().min(1),
  captured_at: isoDateTimeSchema.nullable(),
  imported_at: isoDateTimeSchema,
  permission_id: uuidSchema,
  /** 来源关联的项目（导入时用户选择；可为空，由提取阶段归属） */
  project_id: uuidSchema.nullable(),
  metadata_json: z.string(),
  /**
   * 内容版本（修复 v0.1.1 M0.2）：可用内容版本。新增/编辑/分支切换等影响
   * 理解的变化递增；完全重复提交不递增。迁移的旧来源为 1。
   */
  content_revision: z.number().int().nonnegative().optional(),
  /** 已成功生成理解的版本（提取失败/取消/引用不合法不得推进） */
  analyzed_revision: z.number().int().nonnegative().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

// ---------------------------------------------------------------------------
// segments：可引用的原文片段
// ---------------------------------------------------------------------------

export const segmentRoleSchema = z.enum(['user', 'assistant', 'system', 'document']);
export type SegmentRole = z.infer<typeof segmentRoleSchema>;

export const segmentSchema = z.object({
  id: uuidSchema,
  source_id: uuidSchema,
  sequence: z.number().int().nonnegative(),
  role: segmentRoleSchema,
  external_node_id: z.string().nullable(),
  external_parent_id: z.string().nullable(),
  is_active_branch: z.boolean(),
  occurred_at: isoDateTimeSchema.nullable(),
  text: z.string(),
  content_hash: z.string().length(64),
  metadata_json: z.string(),
});
export type Segment = z.infer<typeof segmentSchema>;

// ---------------------------------------------------------------------------
// projects：项目
// ---------------------------------------------------------------------------

export const projectStatusSchema = z.enum(['active', 'paused', 'archived']);

export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  root_path: z.string().nullable(),
  description: z.string().nullable(),
  status: projectStatusSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});
export type Project = z.infer<typeof projectSchema>;

// ---------------------------------------------------------------------------
// items：IXAEON 当前理解
// ---------------------------------------------------------------------------

export const itemTypeSchema = z.enum([
  'project_summary',
  'decision',
  'rejected_option',
  'open_loop',
  'goal',
  'constraint',
  'preference',
]);
export const itemStateSchema = z.enum(['current', 'disputed', 'superseded']);
export const itemOriginSchema = z.enum(['ai', 'user', 'work_result']);

export const itemSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema.nullable(),
  type: itemTypeSchema,
  statement: z.string().min(1),
  rationale: z.string().nullable(),
  state: itemStateSchema,
  confidence: z.number().min(0).max(1),
  origin: itemOriginSchema,
  observed_at: isoDateTimeSchema.nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  supersedes_item_id: uuidSchema.nullable(),
  /** AI 提取来源（source id），用户纠正与工作记录为 null */
  extracted_from_source_id: uuidSchema.nullable(),
  /** 提取使用的提示词版本 */
  prompt_version: z.string().nullable(),
  /** 提取使用的模型名称 */
  model_name: z.string().nullable(),
  /** 待讨论标记：冲突 / 归属不明 / 证据不足的候选结论 */
  needs_review: z.boolean(),
  /** 搁置标记：用户主动稍后处理 */
  shelved_at: isoDateTimeSchema.nullable(),
  /** M2 确认维度：none=未表态；confirmed=用户确认正确；rejected=用户不采纳 */
  confirmation: z.enum(['none', 'confirmed', 'rejected']).default('none'),
  /** 确认/不采纳的落库时间 */
  confirmation_at: z.string().nullable().default(null),
});
export type Item = z.infer<typeof itemSchema>;

// ---------------------------------------------------------------------------
// item_evidence：结论依据
// ---------------------------------------------------------------------------

export const itemEvidenceSchema = z.object({
  item_id: uuidSchema,
  segment_id: uuidSchema,
  excerpt: z.string().min(1),
  relevance: z.number().min(0).max(1),
});
export type ItemEvidence = z.infer<typeof itemEvidenceSchema>;

// ---------------------------------------------------------------------------
// corrections：用户纠正
// ---------------------------------------------------------------------------

export const correctionSchema = z.object({
  id: uuidSchema,
  old_item_id: uuidSchema,
  user_text: z.string().min(1),
  new_item_id: uuidSchema,
  created_at: isoDateTimeSchema,
});
export type Correction = z.infer<typeof correctionSchema>;

// ---------------------------------------------------------------------------
// work_runs：编码工作记录
// ---------------------------------------------------------------------------

export const workOutcomeSchema = z.enum(['success', 'partial', 'failed']);
export const workTestResultSchema = z.enum(['passed', 'failed', 'not_run']);

export const workRunTestSchema = z.object({
  name: z.string(),
  result: workTestResultSchema,
});

export const workRunSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  agent_name: z.string().min(1),
  task: z.string().min(1),
  outcome: workOutcomeSchema,
  summary: z.string(),
  changes_json: z.string(),
  tests_json: z.string(),
  open_loops_json: z.string(),
  commit_ref: z.string().nullable(),
  started_at: isoDateTimeSchema.nullable(),
  finished_at: isoDateTimeSchema,
});
export type WorkRun = z.infer<typeof workRunSchema>;

// ---------------------------------------------------------------------------
// jobs：后台任务
// ---------------------------------------------------------------------------

export const jobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export const jobSchema = z.object({
  id: uuidSchema,
  kind: z.string().min(1),
  status: jobStatusSchema,
  payload_json: z.string(),
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  retry_count: z.number().int().nonnegative(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  /** 退避重试的最早执行时间（ISO；NULL 表示立即可执行） */
  not_before: z.string().nullable().optional(),
});
export type Job = z.infer<typeof jobSchema>;

// ---------------------------------------------------------------------------
// audit_events：审计事件
// ---------------------------------------------------------------------------

export const auditEventSchema = z.object({
  id: uuidSchema,
  kind: z.string().min(1),
  detail_json: z.string(),
  created_at: isoDateTimeSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
