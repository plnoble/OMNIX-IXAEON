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
  /** 用户自命名的本地账户命名空间；跨账号相同标题/ID 不合并。 */
  account_namespace: z.string().min(1).default('local'),
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
  /** 归档时间；非空表示档案，不再当现行工作分析 */
  archived_at: isoDateTimeSchema.nullable().optional(),
  /** 归档时留下的短经验摘要（非现行目标） */
  archive_summary: z.string().nullable().optional(),
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
  /** 项目建立目的（构想也可无目录登记）。 */
  purpose: z.string().nullable().optional(),
  current_state: z.string().nullable().optional(),
  primary_io: z.string().nullable().optional(),
  capabilities: z.string().nullable().optional(),
  related_goals: z.string().nullable().optional(),
  unknowns: z.string().nullable().optional(),
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
export const itemOriginSchema = z.enum([
  'ai',
  'user',
  'work_result',
  'research',
  'assistant_suggestion',
]);
/** S1：语义范围与项目归属正交。personal ≠ 缺项目；unassigned 才是未整理。 */
export const memoryScopeSchema = z.enum(['personal', 'project', 'unassigned']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const itemSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema.nullable(),
  /** 语义范围。旧库空归属保守映射为 unassigned，不自动升级为 personal。 */
  scope: memoryScopeSchema.default('unassigned'),
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
  /** G5：人工单独归属标记（来源级批量重绑不搬动） */
  manual_project: z.boolean().default(false),
});
export type Item = z.infer<typeof itemSchema>;

// ---------------------------------------------------------------------------
// item_links：条目与项目/主题的关联（不复制原文、不等于共享权限）
// ---------------------------------------------------------------------------

export const itemLinkKindSchema = z.enum(['project', 'topic']);

export const itemLinkSchema = z.object({
  id: uuidSchema,
  item_id: uuidSchema,
  kind: itemLinkKindSchema,
  target_id: uuidSchema,
  created_at: isoDateTimeSchema,
});
export type ItemLink = z.infer<typeof itemLinkSchema>;

// ---------------------------------------------------------------------------
// disclosure_grants：把指定条目分享给编码客户端等受众（有期限、可撤销）
// ---------------------------------------------------------------------------

export const disclosureAudienceSchema = z.enum(['coding_client', 'model', 'research']);

export const disclosureGrantSchema = z.object({
  id: uuidSchema,
  item_id: uuidSchema,
  audience: disclosureAudienceSchema,
  granted_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema.nullable(),
  revoked_at: isoDateTimeSchema.nullable(),
  note: z.string().nullable(),
});
export type DisclosureGrant = z.infer<typeof disclosureGrantSchema>;

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
// coding_tasks：获准编码执行（S5）
// ---------------------------------------------------------------------------

export const codingTaskStatusSchema = z.enum([
  'draft',
  'waiting_approval',
  'queued',
  'running',
  'pending_verify',
  'pending_accept',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);
export type CodingTaskStatus = z.infer<typeof codingTaskStatusSchema>;

export const codingTaskSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  goal: z.string().min(1),
  scope_json: z.string(),
  workspace_path: z.string().nullable(),
  snapshot_ref: z.string().nullable(),
  context_digest: z.string(),
  allowed_commands_json: z.string(),
  timeout_ms: z.number().int().positive(),
  status: codingTaskStatusSchema,
  version: z.number().int().positive(),
  approval_id: uuidSchema.nullable(),
  dispatch_key: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  executor_name: z.string().nullable(),
  executor_report_json: z.string().nullable(),
  verify_status: z.enum(['passed', 'failed', 'not_run']).nullable(),
  verify_exit_code: z.number().int().nullable(),
  verify_output: z.string().nullable(),
  tests_modified: z.boolean(),
  accepted_at: isoDateTimeSchema.nullable(),
  error: z.string().nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});
export type CodingTask = z.infer<typeof codingTaskSchema>;

export const codingApprovalSchema = z.object({
  id: uuidSchema,
  task_id: uuidSchema,
  task_version: z.number().int().positive(),
  digest: z.string().min(1),
  workspace_path: z.string().min(1),
  snapshot_ref: z.string().nullable(),
  allowed_commands_json: z.string(),
  granted_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema.nullable(),
  revoked_at: isoDateTimeSchema.nullable(),
});
export type CodingApproval = z.infer<typeof codingApprovalSchema>;

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

// ---------------------------------------------------------------------------
// project_relations：有状态的跨项目提案（S3）
// ---------------------------------------------------------------------------

export const relationKindSchema = z.enum([
  'serves_goal',
  'depends_on',
  'provides_capability',
  'reusable',
  'suspected_duplicate',
  'conflict',
]);
export type RelationKind = z.infer<typeof relationKindSchema>;

export const relationStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'superseded']);
export type RelationStatus = z.infer<typeof relationStatusSchema>;

export const relationVerificationSchema = z.enum(['unverified', 'verified', 'failed']);
export type RelationVerification = z.infer<typeof relationVerificationSchema>;

export const projectRelationSchema = z.object({
  id: uuidSchema,
  kind: relationKindSchema,
  from_project_id: uuidSchema,
  to_entity_kind: z.enum(['project', 'item']),
  to_entity_id: z.string().min(1),
  rationale: z.string().min(1),
  evidence_json: z.string(),
  evidence_fingerprint: z.string().min(1),
  proposer: z.enum(['system', 'user']),
  status: relationStatusSchema,
  verification: relationVerificationSchema,
  benefit: z.string().nullable(),
  cost: z.string().nullable(),
  prerequisites: z.string().nullable(),
  independent_alternative: z.string().nullable(),
  stale: z.boolean(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  reviewed_at: isoDateTimeSchema.nullable(),
  supersedes_id: uuidSchema.nullable(),
});
export type ProjectRelation = z.infer<typeof projectRelationSchema>;

// ---------------------------------------------------------------------------
// research：批准来源检查（S4；无搜索 API 时不得声称全网搜索）
// ---------------------------------------------------------------------------

export const researchSourceKindSchema = z.enum(['page', 'feed']);
export type ResearchSourceKind = z.infer<typeof researchSourceKindSchema>;

export const researchEvidenceClassSchema = z.enum([
  'publisher',
  'third_party',
  'cross_check',
  'local_experiment',
]);
export type ResearchEvidenceClass = z.infer<typeof researchEvidenceClassSchema>;

export const researchTopicSchema = z.object({
  id: uuidSchema,
  question: z.string().min(1),
  /** 选填。当前抓取不外发；空串表示未写出门说法。 */
  public_description: z.string(),
  related_goal_id: uuidSchema.nullable(),
  related_project_id: uuidSchema.nullable(),
  enabled: z.boolean(),
  paused: z.boolean(),
  interval_ms: z.number().int().positive(),
  max_pages_per_run: z.number().int().positive(),
  paid_budget_mode: z.enum(['none', 'request_cap']),
  request_cap: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  last_success_at: isoDateTimeSchema.nullable(),
  last_failure_at: isoDateTimeSchema.nullable(),
  last_failure: z.string().nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  next_check_at: isoDateTimeSchema.nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});
export type ResearchTopic = z.infer<typeof researchTopicSchema>;

export const researchSourceSchema = z.object({
  id: uuidSchema,
  topic_id: uuidSchema,
  url: z.string().min(1),
  kind: researchSourceKindSchema,
  last_fingerprint: z.string().nullable(),
  last_checked_at: isoDateTimeSchema.nullable(),
  last_success_at: isoDateTimeSchema.nullable(),
  last_error: z.string().nullable(),
  created_at: isoDateTimeSchema,
});
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchFindingSchema = z.object({
  id: uuidSchema,
  topic_id: uuidSchema,
  source_id: uuidSchema,
  title: z.string().min(1),
  url: z.string().min(1),
  excerpt: z.string(),
  content_fingerprint: z.string().min(1),
  evidence_class: researchEvidenceClassSchema,
  claimed_published_at: isoDateTimeSchema.nullable(),
  fetched_at: isoDateTimeSchema,
  related_goal_id: uuidSchema.nullable(),
  related_project_id: uuidSchema.nullable(),
  speculation: z.string().nullable(),
  action_worthy: z.boolean(),
  action_reason: z.string().nullable(),
  limitations: z.string().nullable(),
  next_experiment: z.string().nullable(),
  notified: z.boolean(),
  created_at: isoDateTimeSchema,
});
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const researchRunSchema = z.object({
  id: uuidSchema,
  topic_id: uuidSchema,
  generation: z.number().int().nonnegative(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'skipped']),
  pages_fetched: z.number().int().nonnegative(),
  findings_new: z.number().int().nonnegative(),
  error: z.string().nullable(),
  started_at: isoDateTimeSchema,
  finished_at: isoDateTimeSchema.nullable(),
  lease_until: isoDateTimeSchema.nullable(),
});
export type ResearchRun = z.infer<typeof researchRunSchema>;
