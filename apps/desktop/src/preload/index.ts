import { contextBridge, ipcRenderer } from 'electron';
import type { IxaIpcApi } from '@ixaeon/contracts';

/**
 * preload：暴露 window.ixaeon 的完整 IPC 通道。
 * contextIsolation 开启，渲染进程只能通过这里的受控方法访问主进程能力。
 * 文件选择一律经主进程原生对话框（返回一次性票据，渲染层不接触授权决策）。
 */

/** 更新状态（electron-updater 推送 + 手动查询共用形状）。 */
export interface UpdateStatusView {
  available: boolean;
  version: string | null;
  state: 'none' | 'downloading' | 'ready' | 'error';
  error: string | null;
  releaseNotes: string | null;
}

const api: IxaIpcApi = {
  getState: () => ipcRenderer.invoke('ixaeon:getState'),
  completeSetup: (input) => ipcRenderer.invoke('ixaeon:completeSetup', input),
  listProjects: () => ipcRenderer.invoke('ixaeon:listProjects'),
  createProject: (input) => ipcRenderer.invoke('ixaeon:createProject', input),
  updateProjectStatus: (input) => ipcRenderer.invoke('ixaeon:updateProjectStatus', input),
  pickFiles: (kind) => ipcRenderer.invoke('ixaeon:pickFiles', kind),
  pickSaveZip: (defaultName) => ipcRenderer.invoke('ixaeon:pickSaveZip', defaultName),
  pickRestoreZip: () => ipcRenderer.invoke('ixaeon:pickRestoreZip'),
  importPaths: (input) => ipcRenderer.invoke('ixaeon:importPaths', input),
  importFolder: (input) => ipcRenderer.invoke('ixaeon:importFolder', input),
  registerProjectDirectory: (input) => ipcRenderer.invoke('ixaeon:registerProjectDirectory', input),
  listSources: (input) => ipcRenderer.invoke('ixaeon:listSources', input),
  getSource: (id) => ipcRenderer.invoke('ixaeon:getSource', id),
  bindSourceProject: (input) => ipcRenderer.invoke('ixaeon:bindSourceProject', input),
  getSourceSegments: (input) => ipcRenderer.invoke('ixaeon:getSourceSegments', input),
  getSegmentContext: (input) => ipcRenderer.invoke('ixaeon:getSegmentContext', input),
  searchSegments: (input) => ipcRenderer.invoke('ixaeon:searchSegments', input),
  reextractSource: (sourceId) => ipcRenderer.invoke('ixaeon:reextractSource', sourceId),
  revokeSourceReading: (sourceId) => ipcRenderer.invoke('ixaeon:revokeSourceReading', sourceId),
  deleteSourceDerived: (sourceId) => ipcRenderer.invoke('ixaeon:deleteSourceDerived', sourceId),
  deleteSource: (sourceId) => ipcRenderer.invoke('ixaeon:deleteSource', sourceId),
  listJobs: (limit) => ipcRenderer.invoke('ixaeon:listJobs', limit),
  retryJob: (jobId) => ipcRenderer.invoke('ixaeon:retryJob', jobId),
  listItems: (input) => ipcRenderer.invoke('ixaeon:listItems', input),
  getItemEvidence: (itemId) => ipcRenderer.invoke('ixaeon:getItemEvidence', itemId),
  previewCorrection: (input) => ipcRenderer.invoke('ixaeon:previewCorrection', input),
  correctItem: (input) => ipcRenderer.invoke('ixaeon:correctItem', input),
  setItemPendingReview: (input) => ipcRenderer.invoke('ixaeon:setItemPendingReview', input),
  confirmItem: (itemId) => ipcRenderer.invoke('ixaeon:confirmItem', itemId),
  rejectItem: (itemId) => ipcRenderer.invoke('ixaeon:rejectItem', itemId),
  shelveItem: (input) => ipcRenderer.invoke('ixaeon:shelveItem', input),
  assignItemToProject: (input) => ipcRenderer.invoke('ixaeon:assignItemToProject', input),
  setItemScope: (input) => ipcRenderer.invoke('ixaeon:setItemScope', input),
  listItemLinks: (itemId) => ipcRenderer.invoke('ixaeon:listItemLinks', itemId),
  addItemLink: (input) => ipcRenderer.invoke('ixaeon:addItemLink', input),
  removeItemLink: (linkId) => ipcRenderer.invoke('ixaeon:removeItemLink', linkId),
  grantItemDisclosure: (input) => ipcRenderer.invoke('ixaeon:grantItemDisclosure', input),
  revokeItemDisclosure: (grantId) => ipcRenderer.invoke('ixaeon:revokeItemDisclosure', grantId),
  createManualItem: (input) => ipcRenderer.invoke('ixaeon:createManualItem', input),
  listCorrections: (input) => ipcRenderer.invoke('ixaeon:listCorrections', input),
  askQuestion: (input) => ipcRenderer.invoke('ixaeon:askQuestion', input),
  listWorkRuns: (input) => ipcRenderer.invoke('ixaeon:listWorkRuns', input),
  getSettings: () => ipcRenderer.invoke('ixaeon:getSettings'),
  saveModelSettings: (input) => ipcRenderer.invoke('ixaeon:saveModelSettings', input),
  listAvailableModels: (input) => ipcRenderer.invoke('ixaeon:listAvailableModels', input),
  setCaptureEnabled: (enabled) => ipcRenderer.invoke('ixaeon:setCaptureEnabled', enabled),
  setAutoAnalyze: (enabled) => ipcRenderer.invoke('ixaeon:setAutoAnalyze', enabled),
  generatePairingCode: () => ipcRenderer.invoke('ixaeon:generatePairingCode'),
  getExtensionStatus: () => ipcRenderer.invoke('ixaeon:getExtensionStatus'),
  exportData: (input) => ipcRenderer.invoke('ixaeon:exportData', input),
  previewRestore: (input) => ipcRenderer.invoke('ixaeon:previewRestore', input),
  restoreData: (input) => ipcRenderer.invoke('ixaeon:restoreData', input),
  openLogsFolder: () => ipcRenderer.invoke('ixaeon:openLogsFolder'),
  listAuditEvents: (limit) => ipcRenderer.invoke('ixaeon:listAuditEvents', limit),
};

/** 更新能力（独立于 IxaIpcApi：仅生产构建存在，开发运行为 no-op）。 */
const updates = {
  check: (): Promise<UpdateStatusView> => ipcRenderer.invoke('ixaeon:check-update'),
  install: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('ixaeon:install-update'),
  onStatus: (listener: (status: UpdateStatusView) => void): (() => void) => {
    const handler = (_e: unknown, status: UpdateStatusView) => listener(status);
    ipcRenderer.on('ixaeon:update-status', handler);
    return () => ipcRenderer.removeListener('ixaeon:update-status', handler);
  },
};

contextBridge.exposeInMainWorld('ixaeon', api);
contextBridge.exposeInMainWorld('ixaeonUpdates', updates);
