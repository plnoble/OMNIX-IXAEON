import { z } from 'zod';
import { isoDateTimeSchema, segmentRoleSchema, uuidSchema } from './entities.js';

// ---------------------------------------------------------------------------
// 本地 HTTP 接口（127.0.0.1:43191，全部要求 Bearer 令牌，/api/health 除外）
// ---------------------------------------------------------------------------

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  app: z.literal('ixaeon'),
  version: z.string(),
  setupComplete: z.boolean(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// --- 浏览器扩展：配对 ---

export const pairRequestSchema = z.object({
  /** 一次性配对码（6 位数字，10 分钟有效，单次使用） */
  code: z.string().regex(/^\d{6}$/),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const pairResponseSchema = z.object({
  token: z.string().min(32),
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

// --- 浏览器扩展：增量提交对话 ---

/** 扩展采集到的单条可见消息。 */
export const capturedTurnSchema = z.object({
  /** 在对话内的顺序（0 起） */
  order: z.number().int().nonnegative(),
  role: segmentRoleSchema,
  text: z.string(),
  /** 内容指纹：扩展端计算的 SHA-256（后端仍会自行计算，不信任扩展端） */
  contentHash: z.string().length(64),
});
export type CapturedTurn = z.infer<typeof capturedTurnSchema>;

export const captureBatchSchema = z.object({
  conversation: z.object({
    /** chatgpt.com 对话路径，如 /c/<uuid>；幂等键的一部分 */
    externalId: z.string().min(1).max(300),
    title: z.string().max(500),
    /**
     * 采集会话标识（修复 R8）：扩展在同一标签页、同一场对话内保持不变
     * （含临时 page:<hash> → 正式 /c/<id> 的身份转正），跨标签页 / 新对话
     * 必然不同。服务端以它作为身份合并的可靠绑定依据；缺省时回退到
     * 完整内容包含检查。
     */
    sessionId: z.string().min(8).max(128).optional(),
  }),
  turns: z.array(capturedTurnSchema).min(1).max(500),
  clientTimestamp: isoDateTimeSchema,
});
export type CaptureBatch = z.infer<typeof captureBatchSchema>;

export const captureBatchResponseSchema = z.object({
  /** 新写入的片段数 */
  accepted: z.number().int().nonnegative(),
  /** 因重复被跳过的片段数 */
  deduplicated: z.number().int().nonnegative(),
  sourceId: uuidSchema,
});
export type CaptureBatchResponse = z.infer<typeof captureBatchResponseSchema>;

// --- 扩展状态查询（弹窗用） ---

export const extensionStatusResponseSchema = z.object({
  paired: z.boolean(),
  captureEnabled: z.boolean(),
  /** 服务器时间，用于弹窗显示最近同步 */
  serverTime: isoDateTimeSchema,
});
export type ExtensionStatusResponse = z.infer<typeof extensionStatusResponseSchema>;
