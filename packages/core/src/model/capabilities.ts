/**
 * ModelCapabilities（RFC-003）：用能力声明代替 `if (modelName === '...')`。
 *
 * 为什么：原来 `ModelProvider` 只有一个 `modelName: string`，
 * 于是「这个模型支不支持原生 JSON schema / seed / 工具」只能靠名字猜，
 * 必然长出散落的名称判断。外部实证：deepseek-recipe 把模型版本差异收敛在 encoding 与 convert 里。
 *
 * 注意 `maxContext` 未知时是 `null`——**不猜数值**（ModelPool 当年「字段齐全、值是编的」的教训）。
 */
export interface ModelCapabilities {
  /**
   * 结构化输出的最强可用手段：
   * - `native-schema`：provider 原生 JSON schema 约束（我们在用的 `strict:true`）；
   * - `tool-call`：只能借工具调用表达结构；
   * - `validate-only`：只能生成后校验（现有 zod 路径）。
   */
  structuredOutput: 'native-schema' | 'tool-call' | 'validate-only';
  /** 能否固定随机种子（可复现）。 */
  seed: boolean;
  /** 是否支持工具调用。 */
  tools: boolean;
  /** 是否支持图像输入。 */
  vision: boolean;
  /** 上下文上限（token）；`null` = 未知，调用方须自行保守处理。 */
  maxContext: number | null;
  /** 是否支持流式。 */
  streaming: boolean;
}

/** 未知能力时的保守默认：一律按最弱档，不夸大。 */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  structuredOutput: 'validate-only',
  seed: false,
  tools: false,
  vision: false,
  maxContext: null,
  streaming: false,
};
