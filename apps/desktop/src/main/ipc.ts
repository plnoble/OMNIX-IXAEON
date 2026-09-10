import { app, dialog, ipcMain, shell, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AppRuntime } from './appRuntime.js';
import { getMcpSnippet } from './mcpSnippet.js';
import { listAuditEvents, recordAudit } from '@ixaeon/core';
import {
  ErrorCodes,
  IxaError,
  toApiError,
  type AppState,
  type IxaIpcApi,
  type Item,
  type Job,
  type Permission,
  type PickResult,
  type Project,
  type SearchInput,
  type Source,
  type SourceListItem,
} from '@ixaeon/contracts';

/**
 * IPC 处理器注册：实现 IxaIpcApi 的全部方法。
 *
 * 授权票据（修复 P1-5）：渲染进程不能决定实际读取路径。
 * - pickFiles / pickSaveZip / pickRestoreZip 弹出原生对话框，选择结果存入
 *   主进程票据表（随机票据 → 规范化真实路径，5 分钟有效、单次使用）；
 * - importPaths / registerProjectDirectory / exportData / previewRestore
 *   只接受票据，不接受渲染层声明的路径；伪造 / 过期 / 重复使用一律拒绝；
 * - 使用后立即作废；对话框选中 A 文件不能借票据读取同目录 B 文件
 *   （票据精确绑定所选路径集合，导入前还需与授权范围比对）。
 */
interface PendingTicket {
  /** 票据授权的路径集合（realpath 规范化 + 原始形态双记，用于精确匹配） */
  paths: string[];
  realPaths: string[];
  /** 用途标记（导入 / 导出目标 / 恢复包来源），防止跨用途混用 */
  purpose: 'import' | 'save' | 'restore';
  expiresAt: number;
}

const TICKET_TTL_MS = 5 * 60 * 1000;

/** 测试钩子：IXAEON_TEST_DIALOG_RESPONSES="documents|path1;path2"（仅测试环境生效）。 */
function stubDialogPaths(kind: string): string[] | null {
  const stub = process.env.IXAEON_TEST_DIALOG_RESPONSES;
  if (!stub) return null;
  const sections = new Map<string, string[]>();
  for (const part of stub.split(';')) {
    const sep = part.indexOf('|');
    if (sep > 0) sections.set(part.slice(0, sep), part.slice(sep + 1).split(','));
  }
  return sections.get(kind) ?? null;
}

function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function registerIpc(runtime: AppRuntime): void {
  const wrap = (err: unknown): Error => {
    const api = toApiError(err);
    return new Error(`${api.code} ${api.message}`);
  };

  // --- 票据表（主进程内存；随进程生命周期） ---
  const tickets = new Map<string, PendingTicket>();

  const issueTicket = (paths: string[], purpose: PendingTicket['purpose']): PickResult => {
    const ticket = randomBytes(24).toString('hex');
    tickets.set(ticket, {
      paths,
      realPaths: paths.map(realPath),
      purpose,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return { ticket, paths };
  };

  /** 消费票据（单次使用）：返回其路径集合；伪造/过期/重复/用途不符一律拒绝。 */
  const consumeTicket = (ticket: unknown, purpose: PendingTicket['purpose']): string[] => {
    if (typeof ticket !== 'string' || ticket.length === 0) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        '缺少有效的选择票据（请通过文件对话框选择）',
      );
    }
    const entry = tickets.get(ticket);
    if (!entry) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        '选择票据无效或已使用（请重新通过对话框选择）',
      );
    }
    tickets.delete(ticket); // 一次性使用：无论后续成功与否都作废
    if (Date.now() > entry.expiresAt) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '选择票据已过期（请重新选择）');
    }
    if (entry.purpose !== purpose) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        '选择票据用途不符（导入 / 导出 / 恢复票据不可混用）',
      );
    }
    return entry.paths;
  };

  const enqueueExtractions = (
    sources: Array<{ id: string }>,
    projectId: string | null,
  ): string[] => {
    const jobIds: string[] = [];
    for (const source of sources) {
      const job = runtime.jobs.enqueue('extract', { sourceId: source.id, projectId });
      jobIds.push(job.id);
    }
    runtime.jobs.kick();
    return jobIds;
  };

  const handlers: IxaIpcApi = {
    // --- 应用状态 ---
    getState: async (): Promise<AppState> => runtime.state,
    completeSetup: async (input) => runtime.completeSetup(input),

    // --- 项目 ---
    listProjects: async (): Promise<Project[]> => runtime.projects.list(),
    createProject: async (input) => runtime.projects.create(input),
    createProjects: async (inputs) => runtime.projects.createMany(inputs),
    updateProjectStatus: async (input) => runtime.projects.updateStatus(input.id, input.status),
    deleteProject: async (id) => {
      const result = runtime.projects.delete(id);
      recordAudit(runtime.db, 'project.deleted', {
        projectId: id,
        sourcesUnassigned: result.sourcesUnassigned,
        itemsRemoved: result.itemsRemoved,
      });
      return result;
    },

    // --- 导入（票据制） ---
    pickFiles: async (kind): Promise<PickResult | null> => {
      // 测试钩子：仅当环境变量存在时生效，正常用户运行不受影响
      const stub = stubDialogPaths(kind);
      if (stub !== null) {
        if (stub.length === 0) return null;
        return issueTicket(stub, 'import');
      }
      let paths: string[] | null = null;
      if (kind === 'directory') {
        const result = await dialog.showOpenDialog({
          title: '选择项目目录',
          properties: ['openDirectory'],
        });
        paths = result.canceled ? null : result.filePaths;
      } else {
        const filters =
          kind === 'chatgptExport'
            ? [{ name: 'ChatGPT 导出 conversations.json', extensions: ['json'] }]
            : [
                { name: '支持的文档', extensions: ['md', 'txt', 'json'] },
                { name: '所有文件', extensions: ['*'] },
              ];
        const result = await dialog.showOpenDialog({
          title: '选择要导入的文件',
          properties: ['openFile', 'multiSelections'],
          filters,
        });
        paths = result.canceled ? null : result.filePaths;
      }
      if (!paths || paths.length === 0) return null;
      return issueTicket(paths, 'import');
    },
    pickSaveZip: async (defaultName): Promise<PickResult | null> => {
      const result = await dialog.showSaveDialog({
        title: '导出 IXAEON 数据',
        defaultPath: defaultName,
        filters: [{ name: 'ZIP 导出包', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return null;
      return issueTicket([result.filePath], 'save');
    },
    pickRestoreZip: async (): Promise<PickResult | null> => {
      const result = await dialog.showOpenDialog({
        title: '选择 IXAEON 导出包',
        properties: ['openFile'],
        filters: [{ name: 'IXAEON 导出包', extensions: ['zip'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return issueTicket(result.filePaths, 'restore');
    },
    importPaths: async (input) => {
      // 票据消费（单次）：拿到对话框选择的真实路径集合；渲染层无法自报路径
      const paths = consumeTicket(input.ticket, 'import');
      let pending: Array<{ id: string }> = [];
      const failed: Array<{ path: string; message: string }> = [];
      for (const p of paths) {
        try {
          // 主进程为每个对话框选中的文件创建授权记录（file），
          // 然后带着 permissionId 调用核心层导入（核心层不再自行授权）
          const permission = runtime.permissions.grantFile(p);
          const result = runtime.imports.importFile(p, {
            projectId: input.projectId,
            permissionId: permission.id,
            accountNamespace: input.accountNamespace,
          });
          pending = pending.concat(result.pendingExtraction);
        } catch (err) {
          const api = toApiError(err);
          failed.push({ path: p, message: `${api.code} ${api.message}` });
        }
      }
      const jobIds = enqueueExtractions(pending, input.projectId);
      return { jobIds, failed };
    },
    // 文件夹导入（2026-09-08）：目录票据 → folder 授权（覆盖全部子路径）→
    // 核心层递归白名单导入；逐文件失败隔离，坏文件不拖垮其他导入。
    importFolder: async (input) => {
      const paths = consumeTicket(input.ticket, 'import');
      const rootPath = paths[0]!;
      const permission = runtime.permissions.grantFolder(rootPath);
      const result = runtime.imports.importFolder(rootPath, {
        projectId: input.projectId,
        permissionId: permission.id,
        accountNamespace: input.accountNamespace,
      });
      const jobIds = enqueueExtractions(result.pendingExtraction, input.projectId);
      return { jobIds, failed: result.failed, scanned: result.scanned };
    },
    registerProjectDirectory: async (input) => {
      // 目录票据（Setup / Projects 页的目录选择）→ folder 授权 → 快照导入
      const paths = consumeTicket(input.ticket, 'import');
      const rootPath = paths[0]!;
      runtime.projects.get(input.projectId);
      const permission = runtime.permissions.grantFolder(rootPath);
      const result = runtime.imports.importProjectSnapshot(rootPath, {
        projectId: input.projectId,
        permissionId: permission.id,
      });
      const jobIds = enqueueExtractions(result.pendingExtraction, input.projectId);
      return { jobId: jobIds[0] ?? '' };
    },

    // --- 来源 ---
    listSources: async (input): Promise<SourceListItem[]> =>
      runtime.sources.list({ projectId: input.projectId }),
    getSource: async (id): Promise<Source | null> => runtime.sources.get(id),
    bindSourceProject: async (input) => {
      const result = runtime.sources.bindProject(input.sourceId, input.projectId);
      recordAudit(runtime.db, 'source.project_bound', {
        sourceId: input.sourceId,
        projectId: input.projectId,
        movedItems: result.movedItems,
      });
      return result;
    },
    getSourceSegments: async (input) =>
      runtime.sources.getSegments(input.sourceId, input.offset, input.limit),
    getSegmentContext: async (input) =>
      runtime.sources.getSegmentContext(input.segmentId, input.beforeChars, input.afterChars),
    searchSegments: async (input: SearchInput) =>
      input.projectId
        ? runtime.search.searchSegments(input.query, {
            projectId: input.projectId,
            limit: input.limit,
          })
        : runtime.search.searchSegments(input.query, { limit: input.limit }),
    reextractSource: async (sourceId) => {
      if (runtime.sources.isArchived(sourceId)) {
        throw new IxaError(ErrorCodes.CONFLICT, '已归档来源请先恢复为活跃，再重新分析');
      }
      const job = runtime.jobs.enqueue('extract', { sourceId, reextract: true });
      runtime.jobs.kick();
      return { jobId: job.id };
    },
    archiveSource: async (input) => {
      const summary =
        input.summary && input.summary.trim().length > 0
          ? input.summary.trim()
          : runtime.sources.composeArchiveSummary(input.sourceId);
      runtime.jobs.cancelExtractJobsForSource(input.sourceId);
      const result = runtime.sources.archive(input.sourceId, summary);
      recordAudit(runtime.db, 'source.archived', {
        sourceId: input.sourceId,
        withdrawnItems: result.withdrawnItems,
      });
      return result;
    },
    unarchiveSource: async (sourceId) => {
      runtime.sources.unarchive(sourceId);
      recordAudit(runtime.db, 'source.unarchived', { sourceId });
      return { ok: true as const };
    },
    revokeSourceReading: async (sourceId): Promise<Permission> => {
      const source = runtime.sources.get(sourceId);
      if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, '来源不存在');
      return runtime.permissions.revoke(source.permission_id);
    },
    deleteSourceDerived: async (sourceId) => {
      const source = runtime.sources.get(sourceId);
      if (!source) throw new IxaError(ErrorCodes.NOT_FOUND, '来源不存在');
      const deletedItems = runtime.sources.deleteDerivedItems(sourceId);
      return { deletedItems };
    },
    deleteSource: async (sourceId) => {
      runtime.sources.deleteSource(sourceId);
      return { ok: true as const };
    },

    // --- 后台任务 ---
    listJobs: async (limit): Promise<Job[]> => runtime.jobs.list(limit),
    retryJob: async (jobId): Promise<Job> => runtime.jobs.retry(jobId),

    // --- 理解 / Inbox / 纠正（M2） ---
    listItems: async (input): Promise<Item[]> =>
      runtime.items.list({
        projectId: input.projectId,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.needsReview !== undefined ? { needsReview: input.needsReview } : {}),
        ...(input.shelved !== undefined ? { shelved: input.shelved } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.excludeSuperseded !== undefined
          ? { excludeSuperseded: input.excludeSuperseded }
          : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      }),
    getItemEvidence: async (itemId) => runtime.items.getEvidence(itemId),
    previewCorrection: async (input) => {
      const base = runtime.items.previewCorrection(input.itemId, input.userText);
      const evidence = runtime.items.getEvidence(input.itemId);
      return {
        oldStatement: base.oldStatement,
        newStatement: base.newStatement,
        type: base.type,
        evidence: evidence.map((e) => ({ segment_id: e.segment_id, excerpt: e.excerpt })),
      };
    },
    correctItem: async (input) => runtime.items.correct(input),
    setItemPendingReview: async (input) =>
      runtime.items.setPendingReview(input.itemId, input.needsReview),
    confirmItem: async (itemId) => {
      const item = runtime.items.confirm(itemId);
      recordAudit(runtime.db, 'item.confirmed', { itemId, origin: item.origin });
      return item;
    },
    rejectItem: async (itemId) => {
      const item = runtime.items.reject(itemId);
      recordAudit(runtime.db, 'item.rejected', { itemId, origin: item.origin });
      return item;
    },
    shelveItem: async (input) => runtime.items.shelve(input.itemId, input.shelved),
    assignItemToProject: async (input) =>
      runtime.items.assignToProject(input.itemId, input.projectId),
    setItemScope: async (input) => runtime.items.setScope(input.itemId, input.scope),
    listItemLinks: async (itemId) => runtime.items.listLinks(itemId),
    addItemLink: async (input) =>
      runtime.items.addLink({ itemId: input.itemId, kind: input.kind, targetId: input.targetId }),
    removeItemLink: async (linkId) => runtime.items.removeLink(linkId),
    grantItemDisclosure: async (input) =>
      runtime.items.grantDisclosure({
        itemId: input.itemId,
        audience: input.audience,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? null,
      }),
    revokeItemDisclosure: async (grantId) => runtime.items.revokeDisclosure(grantId),
    createManualItem: async (input) => runtime.items.createManual(input),
    listCorrections: async (input) => runtime.items.listCorrections(input.projectId),

    // --- 问答（M2） ---
    askQuestion: async (input) => runtime.ask(input.projectId, input.question),
    getPersonalOverview: async () => runtime.personalOverview(),
    listProjectRelations: async (input) => runtime.relations.list(input),
    proposeProjectRelations: async () => runtime.proposeRelations(),
    acceptProjectRelation: async (id) => runtime.relations.accept(id),
    rejectProjectRelation: async (id) => runtime.relations.reject(id),
    listResearchTopics: async () => runtime.researchSnapshot(),
    createResearchTopic: async (input) => runtime.research.createTopic(input),
    setResearchTopicEnabled: async (input) =>
      runtime.research.store.setEnabled(input.id, input.enabled),
    setResearchTopicPaused: async (input) =>
      runtime.research.store.setPaused(input.id, input.paused),
    checkResearchTopicNow: async (id) => runtime.research.checkNow(id),
    listCodingTasks: async (projectId) => {
      const name = runtime.codingExecutorName();
      const real = name === 'codex-cli';
      return {
        executor: (real ? 'codex-cli' : 'fake') as 'fake' | 'codex-cli',
        realDispatchEnabled: real,
        notice: real
          ? '真机 Codex 已按你确认的隔离默认开启：workspace-write、隔离工作区、忽略更宽用户配置。不自动合并或部署。走你的 Codex 订阅额度。'
          : '未找到 Codex CLI，仍用 Fake 执行器（只在隔离目录写模拟文件）。安装 Codex 或设置 IXAEON_CODEX_EXE 后重启。',
        tasks: runtime.coding.store.list(projectId),
      };
    },
    createCodingTask: async (input) => runtime.coding.create(input),
    approveCodingTask: async (id) => runtime.coding.approveAndQueue(id),
    dispatchCodingTask: async (id) => runtime.coding.dispatch(id),
    cancelCodingTask: async (id) => runtime.coding.cancel(id),
    acceptCodingTask: async (id) => runtime.coding.accept(id),

    // --- 工作记录（M3） ---
    listWorkRuns: async (input) => runtime.listWorkRuns(input.projectId, input.limit),

    // --- 设置 ---
    getSettings: async () => {
      const config = runtime.getConfig();
      return {
        config: {
          modelName: config.model.modelName,
          apiBaseUrl: config.model.apiBaseUrl,
          apiKeyPresent: config.model.apiKeyPresent,
          captureEnabled: config.capture.enabled,
          autoAnalyze: config.capture.autoAnalyze,
          extensionPaired: config.extension.token !== null,
          extensionLastSyncAt: runtime.lastCaptureAt(),
        },
        dataDir: runtime.state.dataDir,
        mcp: getMcpSnippet(app.getPath('exe'), config.localToken),
        encryptionNotice:
          '应用未实现全库加密：数据库与原文保存在本地文件中，建议开启 Windows BitLocker。',
        // RF08：旧明文密钥因系统加密不可用被清除 → 提示重新输入
        apiKeyNeedsReentry: runtime.apiKeyNeedsReentry(),
      };
    },
    saveModelSettings: async (input) => {
      runtime.updateConfig((c) => ({
        ...c,
        model: {
          ...c.model,
          modelName: input.modelName,
          ...(input.apiBaseUrl !== undefined ? { apiBaseUrl: input.apiBaseUrl.trim() } : {}),
          ...(input.apiKey !== undefined && input.apiKey.length > 0
            ? { apiKeyEncrypted: encryptApiKey(input.apiKey), apiKeyPresent: true }
            : {}),
        },
      }));
      return { ok: true as const };
    },
    // 设置向导/设置页「获取可用模型」：上游拉取，Key 仅本次请求内存使用
    listAvailableModels: async (input) => runtime.listAvailableModels(input),
    setCaptureEnabled: async (enabled) => {
      runtime.updateConfig((c) => ({
        ...c,
        capture: { ...c.capture, enabled },
      }));
      // 修复 M0.2：重新允许采集后，处理「欠分析」的最新版本（持久化版本差）
      if (enabled) runtime.sweepPendingAnalysis();
      return { ok: true as const };
    },
    setAutoAnalyze: async (enabled) => {
      runtime.updateConfig((c) => ({
        ...c,
        capture: { ...c.capture, autoAnalyze: enabled },
      }));
      // 修复 M0.2：重新开启自动分析后，补齐窗口期间积累的待分析内容
      if (enabled) runtime.sweepPendingAnalysis();
      return { ok: true as const };
    },
    generatePairingCode: async () => runtime.localServer.generatePairingCode(),
    getExtensionStatus: async () => {
      const config = runtime.getConfig();
      return {
        paired: config.extension.token !== null,
        captureEnabled: config.capture.enabled,
        lastSyncAt: runtime.lastCaptureAt(),
      };
    },

    // --- 导出 / 恢复（M5；票据制 + 预览凭证） ---
    exportData: async (input) => {
      const paths = consumeTicket(input.ticket, 'save');
      const targetPath = paths[0]!;
      if (!targetPath.toLowerCase().endsWith('.zip')) {
        throw new IxaError(ErrorCodes.VALIDATION_FAILED, '导出目标必须是 .zip 文件');
      }
      return runtime.exportData(targetPath);
    },
    previewRestore: async (input) => {
      const paths = consumeTicket(input.ticket, 'restore');
      return runtime.previewRestore(paths[0]!);
    },
    restoreData: async (input) => {
      // 恢复必须持有预览凭证：绕过预览直接恢复一律拒绝（修复 P1-7.9）
      return runtime.restoreData(input.previewToken);
    },
    openLogsFolder: async () => {
      await shell.openPath(join(runtime.state.dataDir, 'logs'));
      return { ok: true as const };
    },

    // --- 审计 ---
    listAuditEvents: async (limit) => listAuditEvents(runtime.db, limit),
  };

  // 注册（统一错误序列化：渲染进程收到 "IXAxxxx 消息" 形式）
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`ixaeon:${name}`, async (_event, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        throw wrap(err);
      }
    });
  }
}

/** API Key 加密（safeStorage 可用时）。 */
export function encryptApiKey(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64');
  }
  // C11/RF08：系统加密不可用时拒绝持久化——Base64 是可逆编码不是加密，
  // 静默降级违反「API Key 永不明文落盘」契约。当前没有仅本次会话的
  // 密钥方案（不承诺不存在的功能）：保存失败即未保存；已配置的密钥不受影响。
  throw new IxaError(
    ErrorCodes.VALIDATION_FAILED,
    '系统加密存储不可用：API Key 未能保存（本应用不提供明文落盘）。请稍后在系统加密可用时重新保存。',
  );
}

/** RF08：解码旧版 plain:（Base64 可逆编码）密钥 —— 仅供启动迁移使用。 */
export function decodeLegacyPlainApiKey(encrypted: string): string | null {
  if (!encrypted.startsWith('plain:')) return null;
  try {
    const decoded = Buffer.from(encrypted.slice('plain:'.length), 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function decryptApiKey(encrypted: string): string | null {
  // RF08：旧 plain: 格式已由启动迁移处理（可用时升级为系统加密，不可用
  // 时清除）。运行期读取路径不再直接解码明文 —— 迁移被跳过（如迁移写
  // 盘失败）时按「密钥不可用」处理，用户在设置页重新输入。
  if (encrypted.startsWith('plain:')) {
    return null;
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null;
    }
  }
  return null;
}
