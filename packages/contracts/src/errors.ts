import { z } from 'zod';

/** 统一错误码。所有跨进程边界（HTTP / MCP / IPC）的错误都必须使用这里的编码。 */
export const ErrorCodes = {
  /** 未知错误 */
  UNKNOWN: 'IXA0000',
  /** 路径不在授权范围内 */
  PERMISSION_DENIED: 'IXA0001',
  /** 检测到路径穿越 / 符号链接逃逸 */
  PATH_ESCAPE: 'IXA0002',
  /** 文件超过大小限制 */
  FILE_TOO_LARGE: 'IXA0003',
  /** 格式不支持 */
  UNSUPPORTED_FORMAT: 'IXA0004',
  /** 解析失败 */
  PARSE_FAILED: 'IXA0005',
  /** 访问令牌无效或缺失 */
  INVALID_TOKEN: 'IXA0006',
  /** 配对码无效或过期 */
  INVALID_PAIRING_CODE: 'IXA0007',
  /** 请求体超过大小限制 */
  PAYLOAD_TOO_LARGE: 'IXA0008',
  /** 目标不存在 */
  NOT_FOUND: 'IXA0009',
  /** 模型未配置（缺少 API Key 或模型名） */
  MODEL_NOT_CONFIGURED: 'IXA0010',
  /** 模型调用失败 */
  MODEL_CALL_FAILED: 'IXA0011',
  /** 请求/响应校验失败 */
  VALIDATION_FAILED: 'IXA0012',
  /** 状态冲突（如重复配对、重复项目名） */
  CONFLICT: 'IXA0013',
  /** 数据库错误 */
  DB_ERROR: 'IXA0014',
  /** 后台任务失败 */
  JOB_FAILED: 'IXA0015',
  /** 导出包无效或不兼容 */
  INVALID_EXPORT: 'IXA0016',
  /** 本地服务未就绪 */
  SERVER_UNAVAILABLE: 'IXA0017',
  /** 引用（segment/item 等）不存在 */
  INVALID_REFERENCE: 'IXA0018',
  /** 授权已被撤销 */
  PERMISSION_REVOKED: 'IXA0019',
  /** 超出字符预算 */
  BUDGET_EXCEEDED: 'IXA0020',
  /** 来源不受信任 / Origin 校验失败 */
  BAD_ORIGIN: 'IXA0021',
  /** 功能被当前设置禁用 */
  DISABLED: 'IXA0022',
  /** 后台任务被取消（开关/暂停/状态在执行期间变化；可重试） */
  JOB_CANCELLED: 'IXA0023',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const errorCodeSchema = z.string().regex(/^IXA\d{4}$/);

/** 统一错误负载：HTTP 与 MCP 边界都用这个形状。 */
export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** 代码内使用的带错误码错误。 */
export class IxaError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'IxaError';
    this.code = code;
    this.details = details;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof IxaError) return err.toApiError();
  if (err instanceof Error) {
    return { code: ErrorCodes.UNKNOWN, message: err.message };
  }
  return { code: ErrorCodes.UNKNOWN, message: String(err) };
}
