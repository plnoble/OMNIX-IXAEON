import { z } from 'zod';

/** config.json（保存在数据目录根）的完整 schema。 */
export const appConfigSchema = z.object({
  configVersion: z.literal(1),
  /** 首次设置是否完成 */
  setupComplete: z.boolean(),
  model: z.object({
    provider: z.literal('openai'),
    /** 用户在设置中填写的模型名，代码中不写死 */
    modelName: z.string(),
    /** Electron safeStorage 加密后的 API Key（base64）。永不明文落盘。 */
    apiKeyEncrypted: z.string().nullable(),
    /** 是否已经配置过 Key（用于 UI 状态展示） */
    apiKeyPresent: z.boolean(),
  }),
  capture: z.object({
    /** ChatGPT 网页采集总开关 */
    enabled: z.boolean(),
    /** 自动把收回的原文发给云模型分析；默认 false（只保存） */
    autoAnalyze: z.boolean(),
    /** 已暂停采集的对话（externalId 列表；扩展与本地服务双方强制执行） */
    pausedConversations: z.array(z.string().min(1)).default([]),
  }),
  extension: z.object({
    /** 配对成功后发放给扩展的访问令牌 */
    token: z.string().nullable(),
    pairedAt: z.string().nullable(),
  }),
  /** 本机 MCP / 本地 HTTP API 访问令牌 */
  localToken: z.string().nullable(),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export function defaultAppConfig(): AppConfig {
  return {
    configVersion: 1,
    setupComplete: false,
    model: {
      provider: 'openai',
      modelName: '',
      apiKeyEncrypted: null,
      apiKeyPresent: false,
    },
    capture: { enabled: false, autoAnalyze: false, pausedConversations: [] },
    extension: { token: null, pairedAt: null },
    localToken: null,
  };
}

/** 数据目录布局常量（%LOCALAPPDATA%\OMNIX\IXAEON\ 或用户自选目录）。 */
export const DATA_DIR_LAYOUT = {
  dbFile: 'ixaeon.db',
  vaultDir: 'vault',
  logsDir: 'logs',
  backupsDir: 'backups',
  configFile: 'config.json',
} as const;

export const LOCAL_HTTP_PORT = 43191;
export const LOCAL_HTTP_HOST = '127.0.0.1';
