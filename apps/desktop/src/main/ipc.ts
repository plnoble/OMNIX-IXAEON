import { app, dialog, ipcMain, shell, safeStorage } from 'electron';
import { join } from 'node:path';
import type { AppRuntime } from './appRuntime.js';
import { getMcpSnippet } from './mcpSnippet.js';
import { listAuditEvents } from '@ixaeon/core';
import {
  ErrorCodes,
  IxaError,
  toApiError,
  type AppState,
  type IxaIpcApi,
  type Item,
  type Job,
  type Permission,
  type Project,
  type SearchInput,
  type Source,
  type SourceListItem,
} from '@ixaeon/contracts';

/**
 * IPC 处理器注册：实现 IxaIpcApi 的全部方法。
 * 渲染进程只能通过这里的受控入口访问本地能力；
 * 文件选择必须经过原生对话框（授权来源）。
 * 未到里程碑的功能返回明确的 DISABLED 错误，不静默造假数据。
 */
export function registerIpc(runtime: AppRuntime): void {
  const wrap = (err: unknown): Error => {
    const api = toApiError(err);
    return new Error(`${api.code} ${api.message}`);
  };

  const notReady = (feature: string): never => {
    throw new IxaError(ErrorCodes.DISABLED, `${feature}将在后续里程碑启用`);
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
    updateProjectStatus: async (input) => runtime.projects.updateStatus(input.id, input.status),

    // --- 导入 ---
    pickFiles: async (kind) => {
      // 测试钩子：IXAEON_TEST_DIALOG_RESPONSES="docs|path1;path2" 直接返回固定选择，
      // 避免测试依赖真实原生对话框（仅当环境变量存在时生效，正常用户运行不受影响）
      const stub = process.env.IXAEON_TEST_DIALOG_RESPONSES;
      if (stub) {
        const sections = new Map<string, string[]>();
        for (const part of stub.split(';')) {
          const sep = part.indexOf('|');
          if (sep > 0) sections.set(part.slice(0, sep), part.slice(sep + 1).split(','));
        }
        return sections.get(kind) ?? null;
      }
      if (kind === 'directory') {
        const result = await dialog.showOpenDialog({
          title: '选择项目目录',
          properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths;
      }
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
      return result.canceled ? null : result.filePaths;
    },
    pickSaveZip: async (defaultName) => {
      const result = await dialog.showSaveDialog({
        title: '导出 IXAEON 数据',
        defaultPath: defaultName,
        filters: [{ name: 'ZIP 导出包', extensions: ['zip'] }],
      });
      return result.canceled ? null : result.filePath;
    },
    importPaths: async (input) => {
      // importFile 内部识别 conversations.json（多场对话）与普通文档，均幂等；
      // 输入路径集合本身就是用户通过对话框选择的授权来源
      let pending: Array<{ id: string }> = [];
      for (const p of input.paths) {
        const result = runtime.imports.importFile(p, {
          projectId: input.projectId,
          allowedPaths: input.paths,
        });
        pending = pending.concat(result.pendingExtraction);
      }
      const jobIds = enqueueExtractions(pending, input.projectId);
      return { jobIds };
    },
    registerProjectDirectory: async (input) => {
      runtime.projects.get(input.projectId);
      const result = runtime.imports.importProjectSnapshot(input.rootPath, {
        projectId: input.projectId,
      });
      const jobIds = enqueueExtractions(result.pendingExtraction, input.projectId);
      return { jobId: jobIds[0] ?? '' };
    },

    // --- 来源 ---
    listSources: async (input): Promise<SourceListItem[]> =>
      runtime.sources.list({ projectId: input.projectId }),
    getSource: async (id): Promise<Source | null> => runtime.sources.get(id),
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
      const job = runtime.jobs.enqueue('extract', { sourceId, reextract: true });
      runtime.jobs.kick();
      return { jobId: job.id };
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
    shelveItem: async (input) => runtime.items.shelve(input.itemId, input.shelved),
    assignItemToProject: async (input) =>
      runtime.items.assignToProject(input.itemId, input.projectId),
    createManualItem: async (input) => runtime.items.createManual(input),
    listCorrections: async (input) => runtime.items.listCorrections(input.projectId),

    // --- 问答（M2） ---
    askQuestion: async (input) => runtime.ask(input.projectId, input.question),

    // --- 工作记录（M3） ---
    listWorkRuns: async (input) => runtime.listWorkRuns(input.projectId, input.limit),

    // --- 设置 ---
    getSettings: async () => {
      const config = runtime.getConfig();
      return {
        config: {
          modelName: config.model.modelName,
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
      };
    },
    saveModelSettings: async (input) => {
      runtime.updateConfig((c) => ({
        ...c,
        model: {
          ...c.model,
          modelName: input.modelName,
          ...(input.apiKey !== undefined && input.apiKey.length > 0
            ? { apiKeyEncrypted: encryptApiKey(input.apiKey), apiKeyPresent: true }
            : {}),
        },
      }));
      return { ok: true as const };
    },
    setCaptureEnabled: async (enabled) => {
      runtime.updateConfig((c) => ({
        ...c,
        capture: { ...c.capture, enabled },
      }));
      return { ok: true as const };
    },
    setAutoAnalyze: async (enabled) => {
      runtime.updateConfig((c) => ({
        ...c,
        capture: { ...c.capture, autoAnalyze: enabled },
      }));
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

    // --- 导出 / 恢复（M5） ---
    exportData: async () => notReady('导出功能'),
    previewRestore: async () => notReady('恢复功能'),
    restoreData: async () => notReady('恢复功能'),
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
  // 退路：标记为未加密存储（设置页明示）。仅在系统级加密不可用时出现。
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
}

export function decryptApiKey(encrypted: string): string | null {
  if (encrypted.startsWith('plain:')) {
    return Buffer.from(encrypted.slice('plain:'.length), 'base64').toString('utf8');
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
