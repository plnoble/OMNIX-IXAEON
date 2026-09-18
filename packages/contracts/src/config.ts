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
    /**
     * OpenAI 兼容 API 地址（如 https://api.deepseek.com/v1）。
     * 空串表示官方默认 https://api.openai.com/v1。
     */
    apiBaseUrl: z.string().default(''),
    /** Electron safeStorage 加密后的 API Key（base64）。永不明文落盘。 */
    apiKeyEncrypted: z.string().nullable(),
    /** 是否已经配置过 Key（用于 UI 状态展示） */
    apiKeyPresent: z.boolean(),
    /**
     * 聊天（Hermes 引擎）用的模型名。空串 = 跟随上面的 modelName。
     * 启动网关时经 HERMES_MODEL 传给 Hermes——该变量优先于 Hermes 自己的
     * config.yaml，且按 Hermes 的设计不会写回配置文件，所以不动用户的 Hermes 设置。
     */
    chatModelName: z.string().default(''),
  }),
  capture: z.object({
    /** ChatGPT 网页采集总开关 */
    enabled: z.boolean(),
    /** 自动把收回的原文发给云模型分析；默认 false（只保存） */
    autoAnalyze: z.boolean(),
    /** 已暂停采集的对话（externalId 列表；扩展与本地服务双方强制执行） */
    pausedConversations: z.array(z.string().min(1)).default([]),
    /**
     * 已暂停采集的会话（sessionId 列表，修复 N1/N2）：暂停绑定到稳定会话，
     * 身份转正（page:<hash> → /c/<id>）后暂停随会话延续；用户恢复时清除
     * 该会话的全部有效别名。
     */
    pausedSessions: z.array(z.string().min(1)).default([]),
    // externalId → sessionId 别名表已迁入 SQLite session_aliases 表（M0 收尾：
    // 别名随采集无限增长，不再写入 config.json）
  }),
  extension: z.object({
    /** 配对成功后发放给扩展的访问令牌 */
    token: z.string().nullable(),
    pairedAt: z.string().nullable(),
  }),
  /** 本机 MCP / 本地 HTTP API 访问令牌 */
  localToken: z.string().nullable(),
  /** 受控网页搜索（B3）：provider=none 时 search_web 诚实失败 */
  webSearch: z
    .object({
      provider: z.enum(['none', 'brave', 'tavily', 'tinyfish']).default('none'),
      /** Electron safeStorage 加密后的搜索 API Key（base64）。永不明文落盘。 */
      apiKeyEncrypted: z.string().nullable().default(null),
      /** 是否已配置 Key（UI 状态展示；未配置则 search_web 报 IXA0017） */
      apiKeyPresent: z.boolean().default(false),
    })
    .default({ provider: 'none', apiKeyEncrypted: null, apiKeyPresent: false }),
  /**
   * 记忆桥（三周任务单 F1）：让聊天里的 Hermes 经 MCP 查 IXAEON 记忆。默认关闭。
   * token 是 Hermes 专用的服务端凭证，与 localToken 分开——受众等同聊天注入
   * （含个人结论、不含个人聊天原文），Codex 等编码客户端拿不到。
   * 关闭时 token 置空：旧进程手里的令牌立即作废。
   */
  hermesBridge: z
    .object({
      enabled: z.boolean().default(false),
      token: z.string().nullable().default(null),
    })
    .default({ enabled: false, token: null }),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export function defaultAppConfig(): AppConfig {
  return {
    configVersion: 1,
    setupComplete: false,
    model: {
      provider: 'openai',
      modelName: '',
      chatModelName: '',
      apiBaseUrl: '',
      apiKeyEncrypted: null,
      apiKeyPresent: false,
    },
    capture: {
      enabled: false,
      autoAnalyze: false,
      pausedConversations: [],
      pausedSessions: [],
    },
    extension: { token: null, pairedAt: null },
    localToken: null,
    webSearch: { provider: 'none', apiKeyEncrypted: null, apiKeyPresent: false },
    hermesBridge: { enabled: false, token: null },
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
