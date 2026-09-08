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
  parseMarkdownDocument,
  parseTextDocument,
  parseJsonDocument,
  parseChatgptConversations,
  tryParseChatgptConversations,
  type ParsedSegment,
  type ParsedSource,
} from './import/parsers.js';
export { readProjectSnapshot, MAX_FILE_BYTES } from './import/projectSnapshot.js';
export { ImportService, MAX_IMPORT_BYTES, type ImportFileResult } from './import/importService.js';
export { JobQueue, type JobHandler, type JobContext } from './jobs/jobQueue.js';
export { ModelError, type ModelProvider } from './extraction/model/provider.js';
export { OpenAIResponsesProvider } from './extraction/model/openai.js';
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
export { syncDerivedNeedsReasons, type NeedsReason } from './storage/needsReview.js';
export { AskService, type AskResult } from './storage/askStore.js';
export { McpService } from './storage/mcpStore.js';
export { ArchiveService } from './storage/archiveStore.js';
