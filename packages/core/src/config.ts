import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { appConfigSchema, defaultAppConfig, type AppConfig } from '@ixaeon/contracts';

/**
 * config.json 读写。损坏时回落默认值并保留损坏文件副本（.corrupt-<ts>）。
 * 原子写：先写临时文件再改名。
 */
export function loadConfig(configFile: string): AppConfig {
  if (!existsSync(configFile)) return defaultAppConfig();
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
    const parsed = appConfigSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new Error(parsed.error.message);
  } catch (err) {
    const backup = `${configFile}.corrupt-${Date.now()}`;
    try {
      renameSync(configFile, backup);
    } catch {
      /* ignore */
    }
    void err;
    return defaultAppConfig();
  }
}

export function saveConfig(configFile: string, config: AppConfig): void {
  const tmp = `${configFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  renameSync(tmp, configFile);
}
