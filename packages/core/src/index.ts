// IXAEON core — 导入、存储、提取、检索、纠正、简报逻辑
export { ErrorCodes, IxaError, toApiError } from '@ixaeon/contracts';
export { openDatabase, type CoreDatabase } from './db/database.js';
export { migrate, currentMigrationVersion, MIGRATIONS } from './db/migrations.js';
export { Vault, sha256 } from './vault.js';
export { normalizeLocalPath, isPathInside, assertInside, safeJoin } from './paths.js';
export {
  isSourceAuthorized,
  assertSourceAuthorized,
  assertSegmentAuthorized,
  PROJECT_ISOLATION_RULE,
  codingClientMayReadItem,
  assertCodingClientMayReadItem,
  codingClientMayReadSegment,
  assertCodingClientMayReadSegment,
  modelMayReadItem,
  isItemDisclosedTo,
} from './access.js';
export {
  defaultDataDir,
  resolveDataDir,
  setDataDirChoice,
  ensureDataDirLayout,
  wipeDataDirForTests,
} from './dataDir.js';
export { Logger, redactValue, type LogLevel } from './logging/logger.js';
export { recordAudit, listAuditEvents } from './audit.js';
export { loadConfig, saveConfig } from './config.js';
export { PermissionService } from './permissions.js';
export { ProjectService } from './projects.js';
export { SourceStore, type SourceWithStats } from './storage/sourceStore.js';
export { SearchService, type SegmentSearchHit } from './storage/search.js';
export {
  createRetrievalAdapter,
  KeywordRetrievalAdapter,
  LanceDbRetrievalAdapter,
  type RetrievalAdapter,
  type RetrievalHit,
} from './storage/retrieval.js';
export {
  parseMarkdownDocument,
  parseTextDocument,
  parseJsonDocument,
  parseChatgptConversations,
  tryParseChatgptConversations,
  normalizeAccountNamespace,
  DEFAULT_ACCOUNT_NAMESPACE,
  type ParsedSegment,
  type ParsedSource,
} from './import/parsers.js';
export { readProjectSnapshot, MAX_FILE_BYTES } from './import/projectSnapshot.js';
export { ImportService, MAX_IMPORT_BYTES, type ImportFileResult } from './import/importService.js';
export { JobQueue, type JobHandler, type JobContext } from './jobs/jobQueue.js';
export { ModelError, type ModelProvider } from './extraction/model/provider.js';
export { OpenAIResponsesProvider, listUpstreamModels } from './extraction/model/openai.js';
export { FakeProvider } from './extraction/model/fake.js';
export {
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM_PROMPT,
  ASK_SYSTEM_PROMPT,
} from './extraction/prompts.js';
export {
  Extractor,
  extractionOutputSchema,
  splitTextToFit,
  isExcerptGroundedInSegment,
  MAX_BLOCK_CHARS,
  type ExtractionOutput,
  type ExtractStats,
} from './extraction/extractor.js';
export { ItemService } from './storage/itemStore.js';
export {
  syncDerivedNeedsReasons,
  derivedNeedsReasons,
  type NeedsReason,
} from './storage/needsReview.js';
export { AskService, type AskResult } from './storage/askStore.js';
export { McpService } from './storage/mcpStore.js';
export { ArchiveService } from './storage/archiveStore.js';
export {
  RelationService,
  proposeObviousRelations,
  type ProposeRelationInput,
} from './orchestration/relationStore.js';
export {
  Orchestrator,
  type OrchestratorResult,
  type OrchestratorStep,
} from './orchestration/orchestrator.js';
export { buildPersonalOverview, type PersonalOverview } from './personal/overview.js';
export { ResearchStore } from './research/researchStore.js';
export { ResearchChecker, systemClock, type CheckResult, type Clock } from './research/checker.js';
export {
  assertPublicHttpsUrl,
  isBlockedIpLiteral,
  isBlockedResolvedAddress,
} from './research/urlSafety.js';
export { fetchApprovedSource, type FetchDeps } from './research/fetchApproved.js';
export {
  createWebSearchExecutor,
  type WebSearchExecutor,
  type WebSearchHit,
  type WebSearchOutcome,
  type WebSearchProvider,
  type WebSearchExecutorDeps,
} from './research/webSearch.js';
export { parseFeed, parsePage, fingerprintText } from './research/parse.js';
export { CodingTaskStore, approvalDigest, DEFAULT_TASK_TIMEOUT_MS } from './execution/taskStore.js';
export { copyProjectWorkspace, type WorkspaceSnapshot } from './execution/workspaceCopy.js';
export {
  CodingOrchestrator,
  FakeCodingExecutor,
  CodexCliExecutor,
  resolveCodexLocator,
  DEFAULT_NOTE_VERIFY,
  isPlaceholderVerifyCommand,
  type CodingExecutor,
  type ExecutorReport,
  type IndependentCheck,
} from './execution/executor.js';
export { locateHermes, hermesSpawnEnv, type HermesLocator } from './runtime/hermesLocator.js';
export {
  HermesRuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeRunInput,
  type RuntimeEvent,
  type HermesRunResult,
} from './runtime/adapter.js';
export {
  TuiGatewaySession,
  hermesGatewayArgs,
  type TuiTransport,
  type TuiSpawnOptions,
} from './runtime/tuiGateway.js';
export { JsonRpcStdio } from './runtime/jsonrpcStdio.js';
export { CoreToolBroker, CORE_TOOL_NAMES, type CoreToolName } from './runtime/broker.js';
export { AgentSession, type AgentSessionResult, type AgentStep } from './runtime/session.js';
export { SkillCandidateStore, type SkillCandidate, type SkillStatus } from './runtime/skills.js';
export {
  isEphemeralStatement,
  demoteEphemeralType,
  questionLooksEventSpecific,
} from './memory/ephemeral.js';
export { sanitizePublicQuery, type SanitizedQuery } from './memory/querySanitize.js';
export {
  MEMORY_EVAL_SCENARIOS,
  runDeterministicMemoryEval,
  type MemoryEvalScenario,
  type MemoryEvalReport,
  type MemoryEvalCategoryResult,
  type EvalCategory,
} from './memory/evalScenarios.js';
