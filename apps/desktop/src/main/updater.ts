import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, ipcMain } from 'electron';

/**
 * GitHub 发版自动更新（2026-09-08 用户需求；2026-09-10 启动弹窗）：
 * 打开应用后检查 GitHub Releases（github.com/plnoble/OMNIX-IXAEON），
 * 发现新版本自动下载并弹窗提醒；下载完成后由用户点击安装（不自动重启应用）。
 *
 * 边界：
 * - 仅生产构建（app.isPackaged）启用；开发运行不检查（本地无更新元数据）；
 * - 更新检查与下载走 GitHub 公网 HTTPS，不含任何用户数据；
 * - 失败静默记录（更新是增强能力，不阻塞使用），界面可手动重查。
 */

export interface UpdateStatus {
  /** 当前是否有已下载待安装的新版本 */
  available: boolean;
  version: string | null;
  /** downloading / ready / none / error */
  state: 'none' | 'downloading' | 'ready' | 'error';
  error: string | null;
  /** 更新说明（Release body 前若干字符） */
  releaseNotes: string | null;
  /** 下载进度 0–100；未开始或已完成时为 null */
  downloadPercent: number | null;
}

const status: UpdateStatus = {
  available: false,
  version: null,
  state: 'none',
  error: null,
  releaseNotes: null,
  downloadPercent: null,
};

let started = false;
let checkRequested = false;

function pushStatus(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ixaeon:update-status', { ...status });
  }
}

export function startAutoUpdater(logger?: { info: (m: string, e?: unknown) => void }): void {
  if (started || !app.isPackaged) return;
  started = true;

  // electron-builder publish 配置指向 GitHub；不自动下载安装（用户批准制）
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    status.available = true;
    status.version = info.version ?? null;
    status.state = 'downloading';
    status.error = null;
    status.downloadPercent = 0;
    status.releaseNotes =
      typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : null;
    pushStatus();
  });
  autoUpdater.on('update-not-available', () => {
    status.available = false;
    status.version = null;
    status.state = 'none';
    status.error = null;
    status.downloadPercent = null;
    pushStatus();
  });
  let lastProgressAt = 0;
  autoUpdater.on('download-progress', (progress) => {
    status.state = 'downloading';
    status.downloadPercent = Math.max(0, Math.min(100, Math.round(progress.percent)));
    const now = Date.now();
    if (now - lastProgressAt >= 250 || status.downloadPercent >= 100) {
      lastProgressAt = now;
      pushStatus();
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    status.available = true;
    status.version = info.version ?? status.version;
    status.state = 'ready';
    status.downloadPercent = 100;
    pushStatus();
  });
  autoUpdater.on('error', (err) => {
    status.state = 'error';
    status.error = err instanceof Error ? err.message : String(err);
    pushStatus();
    logger?.info('更新检查失败', { error: status.error });
  });

  ipcMain.handle('ixaeon:get-update-status', () => ({ ...status }));
  // 渲染进程：手动检查 / 立即安装
  ipcMain.handle('ixaeon:check-update', async () => {
    checkRequested = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      status.version = result?.updateInfo?.version ?? status.version;
      return { ...status };
    } catch (err) {
      status.state = 'error';
      status.error = err instanceof Error ? err.message : String(err);
      return { ...status };
    }
  });
  ipcMain.handle('ixaeon:install-update', () => {
    if (status.state !== 'ready') {
      return { ok: false as const, reason: 'not-ready' as const };
    }
    // before-quit 钩子会先停运行时再退出；quitAndInstall 触发原生退出路径
    setTimeout(() => autoUpdater.quitAndInstall(), 100);
    return { ok: true as const };
  });

  // 窗口起来后再查，避免状态推到还没加载的页面上。失败不打扰。
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 3_000);
}

/** 窗口加载完成后补发当前状态（启动检查可能早于渲染进程订阅）。 */
export function pushUpdateStatusToWindow(win: BrowserWindow): void {
  win.webContents.send('ixaeon:update-status', { ...status });
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

export function wasCheckRequested(): boolean {
  return checkRequested;
}
