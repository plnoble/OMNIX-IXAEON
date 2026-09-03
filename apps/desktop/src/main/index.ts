import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { AppRuntime } from './appRuntime.js';
import { registerIpc } from './ipc.js';
import type { AppState } from '@ixaeon/contracts';

let mainWindow: BrowserWindow | null = null;
let runtime: AppRuntime | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'IXAEON 析衍',
    backgroundColor: '#0f1216',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const { AppRuntime: Runtime } = await import('./appRuntime.js');
    try {
      runtime = await Runtime.create();
    } catch (err) {
      // 运行时失败仍要打开窗口：设置页显示错误并允许重试
      process.stderr.write(`[ixaeon] 运行时初始化失败: ${String(err)}\n`);
    }
    if (runtime) registerIpc(runtime);
    ipcFallbackState();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (runtime) {
      event.preventDefault();
      const rt = runtime;
      runtime = null;
      void rt.stop().finally(() => {
        app.quit();
      });
    }
  });
}

/** 运行时创建失败时的兜底状态查询。 */
function ipcFallbackState(): void {
  if (ipcMain.listenerCount('ixaeon:getState') > 0) return;
  ipcMain.handle('ixaeon:getState', (): AppState => {
    return {
      version: app.getVersion() || '0.1.0',
      dataDir: '',
      setupComplete: false,
      serverRunning: false,
      serverPort: 43191,
      platform: process.platform,
    };
  });
}
