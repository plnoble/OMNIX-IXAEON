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
});
export type AppState = z.infer<typeof appStateSchema>;

export const setupInputSchema = z.object({
  /** null 表示接受默认数据目录 */
  dataDir: z.string().nullable(),
  modelName: z.string().min(1),
  /** 空字符串表示暂不配置（可稍后在设置中填写） */
  apiKey: z.string(),
  projectName: z.string().min(1),
  projectRootPath: z.string().nullable(),
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const createProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  rootPath: z.string().nullable(),
  description: z.string().max(4000).nullable(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const importPathsInputSchema = z.object({
  /** 用户通过原生对话框明确选择的文件路径（这是授权来源） */
  paths: z.array(z.string().min(1)).min(1).max(200),
  projectId: z.string().uuid().nullable(),
});
export type ImportPathsInput = z.infer<typeof importPathsInputSchema>;

export const registerProjectDirInputSchema = z.object({
  projectId: z.string().uuid(),
  rootPath: z.string().min(1),
});
export type RegisterProjectDirInput = z.infer<typeof registerProjectDirInputSchema>;

export type SourceListItem = {
  source: Source;
  permissionStatus: 'active' | 'revoked';
  segmentCount: number;
  itemCount: number;
  /** 最近一次提取任务状态（M2 起填充） */
  extractState?: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | null;
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
});
export type RestorePreview = z.infer<typeof restorePreviewSchema>;

export const settingsViewSchema = z.object({
  config: z.object({
    modelName: z.string(),
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
  }),
  encryptionNotice: z.string(),
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
  completeSetup(input: SetupInput): Promise<{ ok: true }>;
  // 项目
  listProjects(): Promise<Project[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProjectStatus(input: {
    id: string;
    status: 'active' | 'paused' | 'archived';
  }): Promise<Project>;
  // 导入（文件选择必须经过原生对话框）
  pickFiles(kind: 'documents' | 'chatgptExport' | 'directory'): Promise<string[] | null>;
  pickSaveZip(defaultName: string): Promise<string | null>;
  importPaths(input: ImportPathsInput): Promise<{ jobIds: string[] }>;
  registerProjectDirectory(input: RegisterProjectDirInput): Promise<{ jobId: string }>;
  // 来源
  listSources(input: { projectId: string | null }): Promise<SourceListItem[]>;
  getSource(id: string): Promise<Source | null>;
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
  }): Promise<Item[]>;
  getItemEvidence(itemId: string): Promise<ItemEvidenceView[]>;
  previewCorrection(input: { itemId: string; userText: string }): Promise<CorrectionPreview>;
  correctItem(input: CorrectItemInput): Promise<{
    oldItem: Item;
    newItem: Item;
    correction: Correction;
  }>;
  setItemPendingReview(input: { itemId: string; needsReview: boolean }): Promise<Item>;
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
  saveModelSettings(input: { modelName: string; apiKey?: string }): Promise<{ ok: true }>;
  setCaptureEnabled(enabled: boolean): Promise<{ ok: true }>;
  setAutoAnalyze(enabled: boolean): Promise<{ ok: true }>;
  generatePairingCode(): Promise<{ code: string; expiresAt: string }>;
  getExtensionStatus(): Promise<{
    paired: boolean;
    captureEnabled: boolean;
    lastSyncAt: string | null;
  }>;
  // 导出 / 恢复
  exportData(targetPath: string): Promise<ExportResult>;
  previewRestore(zipPath: string): Promise<RestorePreview>;
  restoreData(zipPath: string): Promise<{ ok: true }>;
  openLogsFolder(): Promise<{ ok: true }>;
  // 审计（设置页“最近操作”）
  listAuditEvents(limit: number): Promise<AuditEvent[]>;
}

declare global {
  interface Window {
    ixaeon?: IxaIpcApi;
  }
}
