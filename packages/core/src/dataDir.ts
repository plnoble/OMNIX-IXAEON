import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_LAYOUT } from '@ixaeon/contracts';

/**
 * 数据目录解析优先级：
 * 1. 环境变量 IXAEON_DATA_DIR（测试与开发隔离；始终最高）
 * 2. %LOCALAPPDATA%\OMNIX\IXAEON\bootstrap.json 中记录的用户选择
 * 3. 默认 %LOCALAPPDATA%\OMNIX\IXAEON\
 */
export function defaultDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'OMNIX', 'IXAEON');
}

function bootstrapFile(): string {
  return join(defaultDataDir(), 'bootstrap.json');
}

export interface ResolvedDataDir {
  dataDir: string;
  source: 'env' | 'bootstrap' | 'default';
  /** 环境变量覆盖时为 true（UI 应禁用修改数据目录） */
  envOverride: boolean;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): ResolvedDataDir {
  const fromEnv = env.IXAEON_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return { dataDir: fromEnv.trim(), source: 'env', envOverride: true };
  }
  const bootstrap = bootstrapFile();
  if (existsSync(bootstrap)) {
    try {
      const parsed = JSON.parse(readFileSync(bootstrap, 'utf8')) as { dataDir?: string };
      if (typeof parsed.dataDir === 'string' && parsed.dataDir.trim().length > 0) {
        return { dataDir: parsed.dataDir.trim(), source: 'bootstrap', envOverride: false };
      }
    } catch {
      // bootstrap 损坏时回落到默认目录
    }
  }
  return { dataDir: defaultDataDir(), source: 'default', envOverride: false };
}

/** 首次设置中用户选择的数据目录（环境变量覆盖时忽略，避免测试写脏用户机器）。 */
export function setDataDirChoice(dir: string): void {
  if (process.env.IXAEON_DATA_DIR) return;
  const target = bootstrapFile();
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify({ dataDir: dir }, null, 2), 'utf8');
}

/** 创建数据目录的标准布局（幂等）。 */
export function ensureDataDirLayout(dataDir: string): {
  dbFile: string;
  vaultDir: string;
  logsDir: string;
  backupsDir: string;
  configFile: string;
} {
  const layout = {
    dbFile: join(dataDir, DATA_DIR_LAYOUT.dbFile),
    vaultDir: join(dataDir, DATA_DIR_LAYOUT.vaultDir),
    logsDir: join(dataDir, DATA_DIR_LAYOUT.logsDir),
    backupsDir: join(dataDir, DATA_DIR_LAYOUT.backupsDir),
    configFile: join(dataDir, DATA_DIR_LAYOUT.configFile),
  };
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(layout.vaultDir, { recursive: true });
  mkdirSync(layout.logsDir, { recursive: true });
  mkdirSync(layout.backupsDir, { recursive: true });
  return layout;
}

/** 仅供测试：清空一个数据目录。绝不用于用户数据。 */
export function wipeDataDirForTests(dataDir: string): void {
  if (!process.env.IXAEON_DATA_DIR) {
    throw new Error('wipeDataDirForTests 只能在 IXAEON_DATA_DIR 环境变量存在时使用');
  }
  rmSync(dataDir, { recursive: true, force: true });
}
