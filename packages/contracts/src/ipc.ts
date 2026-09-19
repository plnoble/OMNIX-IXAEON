import type {
  AuditEvent,
  CodingTask,
  Correction,
  Item,
  Job,
  Permission,
  Project,
  ProjectRelation,
  ResearchFinding,
  ResearchRun,
  ResearchSource,
  ResearchTopic,
  Segment,
  Source,
  Todo,
  TodoStatus,
  TodoView,
  WorkRun,
  SkillCandidate,
} from './entities.js';
import { z } from 'zod';
import { itemTypeSchema } from './entities.js';

// ---------------------------------------------------------------------------
// 渲染进程 ↔ 主进程 IPC 契约。
// preload 以 contextBridge 暴露最小 API；类型在这里集中定义，双端共用。
// ---------------------------------------------------------------------------

export const appStateSchema = z.object({
  version: z.string(),
  dataDir: z.string(),
  setupComplete: z.boolean(),
  serverRunning: z.boolean(),
  serverPort: z.number(),
  platform: z.string(),
  /**
   * 数据目录是否被环境变量 IXAEON_DATA_DIR 覆盖（修复 R9）：
   * 由主进程按 resolveDataDir 的实际解析结果返回，渲染层不得用
   * 「目录字符串非空」推断（正常启动也有非空默认目录）。
   */
  envOverride: z.boolean(),
  /** 数据目录来源（与 envOverride 同源，供设置页展示） */
  dataDirSource: z.enum(['env', 'bootstrap', 'default']),
});
export type AppState = z.infer<typeof appStateSchema>;

export const setupInputSchema = z.object({
  /** null 表示接受默认数据目录 */
  dataDir: z.string().nullable(),
  modelName: z.string().min(1),
  /** OpenAI 兼容 API 地址；空串表示官方默认 */
  apiBaseUrl: z.string().default(''),
  /** 空字符串表示暂不配置（可稍后在设置中填写） */
  apiKey: z.string(),
  /** 空字符串表示跳过建项目（进入主界面后在项目页创建） */
  projectName: z.string(),
  projectRootPath: z.string().nullable(),
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const setupResultSchema = z.object({
  ok: z.literal(true),
  /** true 表示数据目录已切换，本进程运行时已失效，需要重启应用 */
  restartRequired: z.boolean(),
  /** API Key 保存失败原因（设置完成但 Key 未保存；null=无警告） */
  apiKeyWarning: z.string().nullable().default(null),
});
export type SetupResult = z.infer<typeof setupResultSchema>;

export const createProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  rootPath: z.string().nullable(),
  description: z.string().max(4000).nullable(),
  purpose: z.string().max(2000).nullable().optional(),
  currentState: z.string().max(2000).nullable().optional(),
  primaryIo: z.string().max(2000).nullable().optional(),
  capabilities: z.string().max(2000).nullable().optional(),
  relatedGoals: z.string().max(2000).nullable().optional(),
  unknowns: z.string().max(2000).nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

/**
 * 原生对话框选择结果：ticket 是主进程签发的一次性授权票据。
 * 渲染进程只拿到票据（与对话框返回的真实路径），不能自行声明任意路径。
 * 后续 import/export/restore IPC 只接受票据，不接受渲染层传入的路径。
 */
export const pickResultSchema = z.object({
  ticket: z.string().min(8),
  paths: z.array(z.string().min(1)).min(1),
});
export type PickResult = z.infer<typeof pickResultSchema>;

export const importPickedInputSchema = z.object({
  /** pickFiles 返回的一次性票据（使用后立即作废） */
  ticket: z.string().min(8),
  projectId: z.string().uuid().nullable(),
  /** 用户自命名的本地账户命名空间；默认 local。不读取密码/Cookie。 */
  accountNamespace: z.string().min(1).max(80).optional(),
});
export type ImportPickedInput = z.infer<typeof importPickedInputSchema>;

export const importFailureSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ImportFailure = z.infer<typeof importFailureSchema>;

export const registerProjectDirInputSchema = z.object({
  /** pickFiles('directory') 返回的一次性票据 */
  ticket: z.string().min(8),
  projectId: z.string().uuid(),
});
export type RegisterProjectDirInput = z.infer<typeof registerProjectDirInputSchema>;

export const exportDataInputSchema = z.object({
  /** pickSaveZip 返回的一次性票据（导出目标只能来自原生保存对话框） */
  ticket: z.string().min(8),
});
export type ExportDataInput = z.infer<typeof exportDataInputSchema>;

export type SourceAnalysisStatusView = {
  /** 可用内容版本（收到/编辑/分支切换递增） */
  contentRevision: number;
  /** 已成功生成理解的版本 */
  analyzedRevision: number;
  /** 最后成功分析时间（未分析过为 null） */
  analyzedAt: string | null;
  /** 最近一次提取任务状态 */
  lastJobStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
  lastJobError: string | null;
  /** 任务成功但有话要说（如「本次丢弃 N 条依据对不上的结论」） */
  lastJobNote: string | null;
  lastJobAt: string | null;
  lastJobRetryCount: number;
  lastJobNextAt: string | null;
};

export type SourceListItem = {
  source: Source;
  permissionStatus: 'active' | 'revoked';
  segmentCount: number;
  itemCount: number;
  /** 最近一次提取任务状态（M2 起填充） */
  extractState?: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | null;
  /** 所属项目名（未归属为 null；M1.2） */
  projectName: string | null;
  /** 真实状态数据（M1.2） */
  analysis: SourceAnalysisStatusView;
};

/** 片段搜索结果（渲染进程来源页/搜索用，字段比 MCP SearchResult 精简）。 */
export type SegmentHit = {
  segmentId: string;
  sourceId: string;
  sourceTitle: string;
  excerpt: string;
  role: string;
  occurredAt: string | null;
  projectId: string | null;
};

export const bindSourceProjectInputSchema = z.object({
  sourceId: z.string().uuid(),
  /** null 表示解绑（回到未归属） */
  projectId: z.string().uuid().nullable(),
});
export type BindSourceProjectInput = z.infer<typeof bindSourceProjectInputSchema>;

export const searchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  projectId: z.string().uuid().nullable(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

/** 条目依据（含片段与来源标题，供界面展开核验）。 */
export type ItemEvidenceView = {
  segment_id: string;
  excerpt: string;
  relevance: number;
  segment: {
    id: string;
    source_id: string;
    sequence: number;
    role: string;
    text: string;
  };
  sourceTitle: string;
};

export const correctionPreviewSchema = z.object({
  oldStatement: z.string(),
  newStatement: z.string(),
  type: itemTypeSchema,
  evidence: z.array(z.object({ segment_id: z.string(), excerpt: z.string() })),
});
export type CorrectionPreview = z.infer<typeof correctionPreviewSchema>;

export const correctItemInputSchema = z.object({
  itemId: z.string().uuid(),
  userText: z.string().min(1).max(4000),
  newType: itemTypeSchema.optional(),
});
export type CorrectItemInput = z.infer<typeof correctItemInputSchema>;

export const askQuestionInputSchema = z.object({
  /**
   * D4：提问所属的对话。不传 = 新建一个对话。
   * 没有「对话之外的提问」：每条消息都要有归属，重启后才找得回来。
   */
  conversationId: z.string().uuid().nullable().optional(),
  /** null = 个人视角（不强制选项目）；uuid = 项目视角 */
  projectId: z.string().uuid().nullable(),
  question: z.string().min(1).max(4000),
});
export type AskQuestionInput = z.infer<typeof askQuestionInputSchema>;

export const citationSchema = z.object({
  /** 引用编号（如 R3，与回答文本中的 [R3] 对应） */
  ref: z.string(),
  segmentId: z.string(),
  sourceTitle: z.string(),
  role: z.string(),
  excerpt: z.string(),
  /** true 表示该结论来自用户纠正（优先于旧 AI 推断） */
  isUserCorrection: z.boolean(),
});
export type Citation = z.infer<typeof citationSchema>;

export const askAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(citationSchema),
  modelName: z.string(),
  /** 例如“不同来源存在冲突”或“资料不足”的提示 */
  notice: z.string().nullable(),
  usedChars: z.number().int(),
  coverage: z
    .object({
      generatedAt: z.string(),
      includedProjects: z.array(z.string()),
      omittedProjects: z.array(z.string()),
      unanalyzedSources: z.number().int(),
      unassignedItems: z.number().int(),
      budgetLimited: z.boolean(),
    })
    .optional(),
  engine: z.enum(['hermes', 'core-bounded', 'missing', 'ask']).optional(),
  runId: z.string().optional(),
  steps: z
    .array(
      z.object({
        round: z.number().int(),
        tool: z.string(),
        ok: z.boolean(),
        detail: z.string(),
      }),
    )
    .optional(),
  /** P1-A：在对话期间由 Agent 提出的待批准行动任务 */
  proposedTasks: z
    .array(
      z.object({
        id: z.string(),
        goal: z.string(),
        status: z.string(),
        scope: z.array(z.string()),
      }),
    )
    .optional(),
  /** D4：本轮所属对话（不传 conversationId 提问时，这里返回新建的那个）。 */
  conversationId: z.string(),
  /** 本轮用户消息与回答消息的 id，供界面定位与后续流式更新。 */
  userMessageId: z.string(),
  messageId: z.string(),
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;

/** S1/S2：回答正文的一段增量（不含思考过程）。 */
export interface AskDeltaEvent {
  conversationId: string;
  messageId: string;
  delta: string;
}

/**
 * E5：这一轮回答前注入给模型的一条记忆（存在助手消息的 meta.memoryUsed 里）。
 * 两个用处：回答下面列出「用到的记忆」，觉得不对当场点掉；提炼这段回答时
 * 认出哪些话只是在复述这些记忆（回声），不再存一遍。
 */
export interface MemoryUsedItem {
  id: string;
  statement: string;
  /** 出处标签，如「用户指定」「系统推断」「AI 当时的建议，不是用户的决定」 */
  tag: string;
}

/** P2：等待回答时的阶段（事件里不带思考内容）。 */
export type AskPhase = 'preparing' | 'thinking' | 'answering';
export interface AskProgressEvent {
  conversationId: string;
  messageId: string;
  phase: AskPhase;
}

// --- D2/D4：对话与消息（迁移 26） ---

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  /** 最近一次使用的引擎；engineSessionId 进程内有效，重启后为 null */
  engine: z.string().nullable(),
  engineSessionId: z.string().nullable(),
  sourceId: z.string().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationSummarySchema = conversationSchema.extend({
  messageCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  /**
   * cancelled / failed 必须在界面上看得见——半截回答和失败不能渲染成
   * 空气泡，否则用户不知道发生了什么。
   */
  status: z.enum(['streaming', 'complete', 'failed', 'cancelled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  runId: z.string().nullable(),
  engine: z.string().nullable(),
  modelName: z.string().nullable(),
  citations: z.array(citationSchema),
  /** steps / notice / coverage / usedChars / proposedTasks 等渲染用元数据 */
  meta: z.record(z.string(), z.unknown()),
  errorMessage: z.string().nullable(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const createConversationInputSchema = z.object({
  title: z.string().max(200).optional(),
  projectId: z.string().uuid().nullable().optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;

export const renameConversationInputSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
});
export type RenameConversationInput = z.infer<typeof renameConversationInputSchema>;

export const restorePreviewSchema = z.object({
  manifestVersion: z.number(),
  exportedAt: z.string(),
  appVersion: z.string(),
  counts: z.record(z.string(), z.number()),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  warnings: z.array(z.string()),
  /** 恢复凭证：previewRestore 签发，restoreData 必须携带（防止绕过预览直接恢复） */
  previewToken: z.string(),
});
export type RestorePreview = z.infer<typeof restorePreviewSchema>;

export const restoreDataInputSchema = z.object({
  previewToken: z.string().min(8),
});
export type RestoreDataInput = z.infer<typeof restoreDataInputSchema>;

export const settingsViewSchema = z.object({
  config: z.object({
    modelName: z.string(),
    /** 聊天用的模型名；空串 = 跟随 modelName */
    chatModelName: z.string().default(''),
    apiBaseUrl: z.string().default(''),
    apiKeyPresent: z.boolean(),
    captureEnabled: z.boolean(),
    autoAnalyze: z.boolean(),
    extensionPaired: z.boolean(),
    extensionLastSyncAt: z.string().nullable(),
    /** 受控网页搜索（B3）：provider 与 Key 状态（Key 永不回传渲染进程） */
    webSearchProvider: z.enum(['none', 'brave', 'tavily', 'tinyfish']).default('none'),
    webSearchKeyPresent: z.boolean().default(false),
  }),
  dataDir: z.string(),
  /** A03（审核 2026-09-13）：桌面问答存档授权状态（enabled / revoked） */
  askCaptureStatus: z.enum(['enabled', 'revoked']).default('enabled'),
  mcp: z.object({
    serverName: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    snippet: z.string(),
    /** localToken（MCP 端点认证用，供配置片段复制） */
    localToken: z.string().nullable(),
  }),
  encryptionNotice: z.string(),
  /** Chrome「加载已解压」应选的目录；安装包会同步到此。 */
  extensionLoadDir: z.string().nullable().default(null),
  /** RF08：旧明文密钥因系统加密不可用被清除，需要用户重新输入 */
  apiKeyNeedsReentry: z.boolean().default(false),
  hermesFound: z.boolean().default(false),
  hermesNotice: z.string().default(''),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

export const exportResultSchema = z.object({
  zipPath: z.string(),
  fileCount: z.number().int(),
  totalChars: z.number().int(),
});
export type ExportResult = z.infer<typeof exportResultSchema>;

/** window.ixaeon 的完整形状（preload 暴露的最小 API）。 */
export interface IxaIpcApi {
  // 应用状态
  getState(): Promise<AppState>;
  completeSetup(input: SetupInput): Promise<SetupResult>;
  // 项目
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  createProjects(inputs: CreateProjectInput[]): Promise<Project[]>;
  updateProjectStatus(input: {
    id: string;
    status: 'active' | 'paused' | 'archived';
  }): Promise<Project>;
  deleteProject(id: string): Promise<{ sourcesUnassigned: number; itemsRemoved: number }>;
  // 导入（文件选择必须经过原生对话框；渲染进程只持有一次性票据）
  pickFiles(kind: 'documents' | 'chatgptExport' | 'directory'): Promise<PickResult | null>;
  pickSaveZip(defaultName: string): Promise<PickResult | null>;
  pickRestoreZip(): Promise<PickResult | null>;
  importPaths(input: ImportPickedInput): Promise<{
    jobIds: string[];
    failed: ImportFailure[];
  }>;
  /** 文件夹导入（递归白名单 .md/.txt/.json；逐文件失败隔离） */
  importFolder(input: ImportPickedInput): Promise<{
    jobIds: string[];
    failed: ImportFailure[];
    /** 实际纳入导入的文件数 */
    scanned: number;
  }>;
  registerProjectDirectory(input: RegisterProjectDirInput): Promise<{ jobId: string }>;
  // 来源
  listSources(input: { projectId: string | null }): Promise<SourceListItem[]>;
  getSource(id: string): Promise<Source | null>;
  /** 绑定/重新绑定/解绑来源的项目（M1.1：一次归属，后续继承；人工条目不搬） */
  bindSourceProject(input: BindSourceProjectInput): Promise<{ movedItems: number }>;
  getSourceSegments(input: {
    sourceId: string;
    offset: number;
    limit: number;
  }): Promise<{ segments: Segment[]; total: number }>;
  getSegmentContext(input: {
    segmentId: string;
    beforeChars: number;
    afterChars: number;
  }): Promise<{
    segment: Segment;
    before: string;
    after: string;
    sourceTitle: string;
  } | null>;
  searchSegments(input: SearchInput): Promise<SegmentHit[]>;
  reextractSource(sourceId: string): Promise<{ jobId: string }>;
  /** 批量重新分析（「资料」页一次重跑所有分析失败的来源）。已归档的跳过。 */
  reextractSources(sourceIds: string[]): Promise<{ queued: number; skipped: number }>;
  archiveSource(input: {
    sourceId: string;
    /** 空则用标题+开头原文自动生成一句经验摘要 */
    summary?: string | null;
  }): Promise<{ archivedAt: string; summary: string; withdrawnItems: number }>;
  unarchiveSource(sourceId: string): Promise<{ ok: true }>;
  revokeSourceReading(sourceId: string): Promise<Permission>;
  deleteSourceDerived(sourceId: string): Promise<{ deletedItems: number }>;
  deleteSource(sourceId: string): Promise<{ ok: true }>;
  // 后台任务
  listJobs(limit: number): Promise<Job[]>;
  retryJob(jobId: string): Promise<Job>;
  // 理解 / Inbox / 纠正
  listItems(input: {
    projectId: string | null;
    state?: 'current' | 'disputed' | 'superseded';
    needsReview?: boolean;
    shelved?: boolean;
    type?: string;
    /** N01：Inbox 可处理范围排除已被替代的历史条目（默认 false 不排除） */
    excludeSuperseded?: boolean;
    scope?: 'personal' | 'project' | 'unassigned';
    /** E6：true = 只要需要用户拍板的（冲突、要求继续待处理、编码结果）；false = 其余 */
    needsUser?: boolean;
  }): Promise<Item[]>;
  getItemEvidence(itemId: string): Promise<ItemEvidenceView[]>;
  previewCorrection(input: { itemId: string; userText: string }): Promise<CorrectionPreview>;
  correctItem(input: CorrectItemInput): Promise<{
    oldItem: Item;
    newItem: Item;
    correction: Correction;
  }>;
  setItemPendingReview(input: { itemId: string; needsReview: boolean }): Promise<Item>;
  /** M2：用户确认该 AI 理解正确（不改 origin，清除待讨论） */
  confirmItem(itemId: string): Promise<Item>;
  /** M2：用户不采纳该建议（保留可追溯，从当前理解/简报/问答排除） */
  rejectItem(itemId: string): Promise<Item>;
  shelveItem(input: { itemId: string; shelved: boolean }): Promise<Item>;
  assignItemToProject(input: { itemId: string; projectId: string }): Promise<Item>;
  /** S1：显式校正语义范围。标为 personal 只消除 no_project，不清除其它待处理原因。 */
  setItemScope(input: {
    itemId: string;
    scope: 'personal' | 'project' | 'unassigned';
  }): Promise<Item>;
  listItemLinks(itemId: string): Promise<
    Array<{
      id: string;
      item_id: string;
      kind: 'project' | 'topic';
      target_id: string;
      created_at: string;
    }>
  >;
  addItemLink(input: { itemId: string; kind: 'project' | 'topic'; targetId: string }): Promise<{
    id: string;
    item_id: string;
    kind: 'project' | 'topic';
    target_id: string;
    created_at: string;
  }>;
  removeItemLink(linkId: string): Promise<{ ok: true }>;
  grantItemDisclosure(input: {
    itemId: string;
    audience: 'coding_client' | 'model' | 'research';
    expiresAt?: string | null;
    note?: string | null;
  }): Promise<{
    id: string;
    item_id: string;
    audience: 'coding_client' | 'model' | 'research';
    granted_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    note: string | null;
  }>;
  revokeItemDisclosure(grantId: string): Promise<{ ok: true }>;
  createManualItem(input: {
    projectId: string | null;
    type: z.infer<typeof itemTypeSchema>;
    statement: string;
    rationale: string | null;
    scope?: 'personal' | 'project' | 'unassigned';
  }): Promise<Item>;
  listCorrections(input: {
    projectId: string | null;
  }): Promise<Array<Correction & { oldItem: Item; newItem: Item }>>;
  // 问答
  askQuestion(input: AskQuestionInput): Promise<AskAnswer>;
  /** 传 conversationId 只取消该对话；不传时仅当全局恰好一个回合在跑才生效。 */
  cancelAsk(conversationId?: string | null): Promise<{ cancelled: boolean; runId: string | null }>;
  /**
   * P1：预热聊天会话（打开问答页、切换项目时调用）。提前建好 Hermes 会话，新对话第一问
   * 省掉 5–9 秒组装。没装 Hermes、正在答题、已经备好时直接返回。失败不影响提问。
   */
  prewarmChat(input: { projectId: string | null }): Promise<{ warmed: boolean }>;
  /** S1/S2：回答正文分段；返回取消订阅。 */
  onAskDelta(listener: (e: AskDeltaEvent) => void): () => void;
  /** P2：等待阶段；返回取消订阅。 */
  onAskProgress(listener: (e: AskProgressEvent) => void): () => void;
  // 对话（D2/D4）
  listConversations(input?: {
    includeArchived?: boolean;
    limit?: number;
  }): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<{
    conversation: Conversation;
    messages: ConversationMessage[];
  }>;
  createConversation(input?: CreateConversationInput): Promise<Conversation>;
  renameConversation(input: RenameConversationInput): Promise<Conversation>;
  archiveConversation(id: string): Promise<Conversation>;
  unarchiveConversation(id: string): Promise<Conversation>;
  deleteConversation(id: string): Promise<{ deleted: true }>;
  /** T3：待办列表（带底下编码任务的实时状态）；不传 status = 全部 */
  listTodos(input?: { status?: TodoStatus[] }): Promise<TodoView[]>;
  addTodo(input: { title: string }): Promise<Todo>;
  acceptTodo(id: string): Promise<Todo>;
  rejectTodo(id: string): Promise<Todo>;
  completeTodo(id: string): Promise<Todo>;
  /** E1：用户对「这件事结束没有」的判断；null = 回到按内容日期自动判断。 */
  setItemTimeStatus(input: { id: string; status: 'ongoing' | 'ended' | null }): Promise<Item>;
  getPersonalOverview(): Promise<{
    generatedAt: string;
    goals: Item[];
    constraints: Item[];
    unknowns: Item[];
    conflicts: Item[];
    /** E1：看起来已经结束的事（内容里的日期已过、用户还没表态）。 */
    pastSuggestions: Array<{ item: Item; day: string }>;
    /** E1：整份资料里的事看起来都已结束，建议整份归档为过往的事。 */
    pastSources: Array<{
      sourceId: string;
      title: string;
      lastDay: string;
      pastItems: number;
      totalItems: number;
    }>;
    projects: Array<{ project: Project; goals: Item[]; constraints: Item[] }>;
    relations: ProjectRelation[];
    researchFollowUps: Array<{
      id: string;
      title: string;
      url: string;
      excerpt: string;
      action_reason: string | null;
      related_project_id: string | null;
    }>;
    coverage: {
      projectCount: number;
      analyzedSources: number;
      unanalyzedSources: number;
      unassignedItems: number;
    };
  }>;
  listProjectRelations(input?: {
    status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  }): Promise<ProjectRelation[]>;
  proposeProjectRelations(): Promise<Array<ProjectRelation | null>>;
  rejectProjectRelation(id: string): Promise<ProjectRelation>;
  acceptProjectRelation(id: string): Promise<ProjectRelation>;
  listResearchTopics(): Promise<{
    mode: 'approved-sources-only' | 'approved-sources-plus-search';
    searchConfigured: boolean;
    notice: string;
    topics: Array<
      ResearchTopic & {
        sources: ResearchSource[];
        findings: ResearchFinding[];
        runs: ResearchRun[];
      }
    >;
  }>;
  createResearchTopic(input: {
    question: string;
    publicDescription?: string;
    relatedGoalId?: string | null;
    relatedProjectId?: string | null;
    sources: Array<{ url: string; kind: 'page' | 'feed' }>;
    /** D04：无人值守预批搜索预算模式（默认 none） */
    paidBudgetMode?: 'none' | 'request_cap';
    /** D04：预批搜索调用次数上限 */
    requestCap?: number;
    intervalMs?: number;
  }): Promise<ResearchTopic>;
  setResearchTopicEnabled(input: { id: string; enabled: boolean }): Promise<ResearchTopic>;
  setResearchTopicPaused(input: { id: string; paused: boolean }): Promise<ResearchTopic>;
  /** D04：为研究主题设置/补充预批搜索预算 */
  setResearchBudget(input: {
    id: string;
    paidBudgetMode: 'none' | 'request_cap';
    requestCap: number;
  }): Promise<ResearchTopic>;
  checkResearchTopicNow(id: string): Promise<{
    run: ResearchRun;
    findings: ResearchFinding[];
    mode: 'approved-sources-only' | 'approved-sources-plus-search';
    searchUsed: boolean;
    /** 本轮搜索候选 URL（仅手动检查返回；不是发现，批准后才成为来源） */
    searchCandidates: Array<{ title: string; url: string; snippet: string }>;
    /** 搜索失败不毁掉批准来源轮次，如实带回 */
    searchError: string | null;
  }>;
  addResearchSource(input: {
    topicId: string;
    url: string;
    kind: 'page' | 'feed';
  }): Promise<ResearchSource>;
  setResearchFindingAction(input: {
    findingId: string;
    actionWorthy: boolean;
    actionReason?: string | null;
    nextExperiment?: string | null;
  }): Promise<ResearchFinding>;
  previewWatchDirections(): Promise<{ memoryCount: number }>;
  suggestWatchDirections(): Promise<{
    searchConfigured: boolean;
    directions: Array<{
      question: string;
      publicDescription: string;
      basis: Array<{ id: string; statement: string }>;
      relatedGoalId: string | null;
      relatedProjectId: string | null;
    }>;
  }>;
  followWatchDirection(input: {
    question: string;
    publicDescription: string;
    relatedGoalId: string | null;
    relatedProjectId: string | null;
  }): Promise<{ id: string }>;
  skipWatchDirection(input: { question: string; publicDescription: string }): Promise<{ ok: true }>;
  listCodingTasks(projectId?: string): Promise<{
    executor: 'fake' | 'codex-cli';
    realDispatchEnabled: boolean;
    notice: string;
    tasks: CodingTask[];
  }>;
  createCodingTask(input: {
    projectId: string;
    goal: string;
    scope: string[];
    allowedCommands: string[][];
  }): Promise<CodingTask>;
  createCodingDraftFromFinding(input: {
    findingId: string;
    projectId?: string | null;
  }): Promise<CodingTask>;
  approveCodingTask(id: string): Promise<CodingTask>;
  dispatchCodingTask(id: string): Promise<CodingTask>;
  cancelCodingTask(id: string): Promise<CodingTask>;
  acceptCodingTask(id: string): Promise<CodingTask>;
  deleteCodingTask(id: string): Promise<CodingTask>;
  // 工作记录
  listWorkRuns(input: { projectId: string; limit: number }): Promise<WorkRun[]>;
  // 设置
  getSettings(): Promise<SettingsView>;
  getSemanticIndexStatus(): Promise<{
    enabled: boolean;
    model: string | null;
    indexed: number;
    total: number;
    lastError: string | null;
  }>;
  rebuildSemanticIndex(): Promise<{ embedded: number; remaining: number }>;
  saveModelSettings(input: {
    modelName: string;
    /** 聊天用的模型名；空串 = 跟随 modelName。不传 = 保持原值 */
    chatModelName?: string;
    /** OpenAI 兼容 API 地址；空串表示官方默认 */
    apiBaseUrl?: string;
    apiKey?: string;
  }): Promise<{ ok: true }>;
  /** 保存网页搜索设置（B3）。Key 用 safeStorage 加密落盘，留空表示保持不变。 */
  /**
   * E6：个人记忆给 IXAEON 自己的聊天用（默认关）。personalItems = 没归到项目下、
   * 当前有效的记忆条数（关着时它们进不了聊天）。编码客户端不受这个开关影响。
   */
  getPersonalMemoryToChat(): Promise<{ enabled: boolean; personalItems: number }>;
  setPersonalMemoryToChat(enabled: boolean): Promise<{ enabled: boolean; personalItems: number }>;
  /** 记忆桥（F1）当前状态：开着没有；关着的话能不能开、为什么不能。 */
  getHermesBridgeStatus(): Promise<{ enabled: boolean; blockedReason: string | null }>;
  /**
   * 开关记忆桥。开之前检查 Hermes 的模型网关是否 HTTPS；会在 Hermes 的 config.yaml 里
   * 登记/停用 mcp_servers.ixaeon（先备份，令牌不写进去）。
   */
  setHermesBridge(
    enabled: boolean,
  ): Promise<{ enabled: boolean; backupPath: string | null; warning: string | null }>;
  saveWebSearchSettings(input: {
    provider: 'none' | 'brave' | 'tavily' | 'tinyfish';
    apiKey?: string;
  }): Promise<{ ok: true }>;
  /**
   * 真实搜索连通性测试（设置页「测试搜索」）：用已保存（或本次输入）的 Key
   * 发一次真实查询。消耗 1 次额度；结果只回标题/URL，不落库。
   */
  testWebSearch(input: { query: string; apiKey?: string }): Promise<{
    provider: 'brave' | 'tavily' | 'tinyfish';
    hits: Array<{ title: string; url: string; snippet: string }>;
  }>;
  /**
   * 从上游拉取可用模型列表（GET {apiBaseUrl}/models，Bearer 鉴权）。
   * 地址为空时用官方默认。失败抛 IXA0011（含上游错误信息）。
   */
  listAvailableModels(input: {
    apiBaseUrl: string;
    apiKey: string;
  }): Promise<{ models: Array<{ id: string }> }>;
  setCaptureEnabled(enabled: boolean): Promise<{ ok: true }>;
  setAutoAnalyze(enabled: boolean): Promise<{ ok: true }>;
  /** A03：桌面问答存档显式启用/恢复入口（记录审计） */
  enableAskCapture(): Promise<{ status: 'enabled' }>;
  /** A03：桌面问答存档显式停用/撤销入口（撤销授权，后续提问不自动恢复） */
  disableAskCapture(): Promise<{ status: 'revoked' }>;
  generatePairingCode(): Promise<{ code: string; expiresAt: string }>;
  getExtensionStatus(): Promise<{
    paired: boolean;
    captureEnabled: boolean;
    lastSyncAt: string | null;
  }>;
  // 导出 / 恢复（目标与来源路径都只能来自原生对话框票据）
  exportData(input: ExportDataInput): Promise<ExportResult>;
  previewRestore(input: { ticket: string }): Promise<RestorePreview>;
  restoreData(input: RestoreDataInput): Promise<{ ok: true; restartRequired: true }>;
  openLogsFolder(): Promise<{ ok: true }>;
  // 审计（设置页“最近操作”）
  listAuditEvents(limit: number): Promise<AuditEvent[]>;
  // Skill 候选（A09：证据不可改写 + 真实入口版本批准）
  listSkillCandidates(projectId?: string | null): Promise<
    Array<{
      id: string;
      project_id: string | null;
      title: string;
      problem: string;
      method: string;
      status: string;
      version: number;
      eval_before: string | null;
      eval_after: string | null;
      benefit: string | null;
      eval_evidence_json: string | null;
      approved_version: number | null;
      created_at: string;
      updated_at: string;
    }>
  >;
  approveSkillCandidate(input: { id: string; version?: number }): Promise<{ ok: true }>;
  retireSkillCandidate(input: { id: string }): Promise<{ ok: true }>;
  proposeSkillCandidate(input: {
    projectId: string | null;
    workRunId?: string | null;
    task: string;
    summary: string;
  }): Promise<{ id: string }>;
  /**
   * S2-02（审核 2026-09-15）：受控对照评测。验证命令由主进程沙箱真实执行，
   * 调用方自报的退出码/输出/时间一律不采信；失败基线取自候选关联的真实失败运行。
   */
  evaluateSkillWithEvidence(input: {
    id: string;
    method?: string;
    command: string[];
    /** 可选：在该编码任务的隔离工作区内执行（服务端解析，渲染层不传裸路径） */
    taskId?: string | null;
    benefit: string;
  }): Promise<{ ok: true }>;
  /** Mobius 启发：从历史连续失败中自动反思并提炼 Skill 候选 */
  autoEvolveSkillCandidates(input?: { projectId?: string | null }): Promise<SkillCandidate[]>;
}

/** 更新状态（electron-updater 推送与手动查询共用形状）。 */
export interface UpdateStatusView {
  available: boolean;
  version: string | null;
  state: 'none' | 'downloading' | 'ready' | 'error';
  error: string | null;
  releaseNotes: string | null;
  /** 下载进度 0–100；未开始或已完成时为 null */
  downloadPercent: number | null;
}

declare global {
  interface Window {
    ixaeon?: IxaIpcApi;
    /** 更新能力（生产构建存在；开发运行 preload 未加载时 undefined） */
    ixaeonUpdates?: {
      get: () => Promise<UpdateStatusView>;
      check: () => Promise<UpdateStatusView>;
      install: () => Promise<{ ok: boolean; reason?: string }>;
      onStatus: (listener: (status: UpdateStatusView) => void) => () => void;
    };
  }
}
