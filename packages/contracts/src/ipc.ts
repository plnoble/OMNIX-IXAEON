import type {
  AuditEvent,
  Correction,
  Item,
  Job,
  Permission,
  Project,
  Segment,
  Source,
  WorkRun,
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
  lastJobAt: string | null;
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
  projectId: z.string().uuid(),
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
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;

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
    apiBaseUrl: z.string().default(''),
    apiKeyPresent: z.boolean(),
    captureEnabled: z.boolean(),
    autoAnalyze: z.boolean(),
    extensionPaired: z.boolean(),
    extensionLastSyncAt: z.string().nullable(),
  }),
  dataDir: z.string(),
  mcp: z.object({
    serverName: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    snippet: z.string(),
    /** localToken（MCP 端点认证用，供配置片段复制） */
    localToken: z.string().nullable(),
  }),
  encryptionNotice: z.string(),
  /** RF08：旧明文密钥因系统加密不可用被清除，需要用户重新输入 */
  apiKeyNeedsReentry: z.boolean().default(false),
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
  updateProjectStatus(input: {
    id: string;
    status: 'active' | 'paused' | 'archived';
  }): Promise<Project>;
  // 导入（文件选择必须经过原生对话框；渲染进程只持有一次性票据）
  pickFiles(kind: 'documents' | 'chatgptExport' | 'directory'): Promise<PickResult | null>;
  pickSaveZip(defaultName: string): Promise<PickResult | null>;
  pickRestoreZip(): Promise<PickResult | null>;
  importPaths(input: ImportPickedInput): Promise<{
    jobIds: string[];
    failed: ImportFailure[];
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
  createManualItem(input: {
    projectId: string | null;
    type: z.infer<typeof itemTypeSchema>;
    statement: string;
    rationale: string | null;
  }): Promise<Item>;
  listCorrections(input: {
    projectId: string | null;
  }): Promise<Array<Correction & { oldItem: Item; newItem: Item }>>;
  // 问答
  askQuestion(input: AskQuestionInput): Promise<AskAnswer>;
  // 工作记录
  listWorkRuns(input: { projectId: string; limit: number }): Promise<WorkRun[]>;
  // 设置
  getSettings(): Promise<SettingsView>;
  saveModelSettings(input: {
    modelName: string;
    /** OpenAI 兼容 API 地址；空串表示官方默认 */
    apiBaseUrl?: string;
    apiKey?: string;
  }): Promise<{ ok: true }>;
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
}

/** 更新状态（electron-updater 推送与手动查询共用形状）。 */
export interface UpdateStatusView {
  available: boolean;
  version: string | null;
  state: 'none' | 'downloading' | 'ready' | 'error';
  error: string | null;
  releaseNotes: string | null;
}

declare global {
  interface Window {
    ixaeon?: IxaIpcApi;
    /** 更新能力（生产构建存在；开发运行 preload 未加载时 undefined） */
    ixaeonUpdates?: {
      check: () => Promise<UpdateStatusView>;
      install: () => Promise<{ ok: boolean; reason?: string }>;
      onStatus: (listener: (status: UpdateStatusView) => void) => () => void;
    };
  }
}
