import type { z } from 'zod';
import type { ModelCapabilities } from '../../model/capabilities.js';

/**
 * 模型提供者接口：提取与问答统一走这里。
 * 实现方负责网络调用与重试；核心层只依赖此抽象。
 */
export interface ModelProvider {
  readonly modelName: string;
  /**
   * 能力声明（RFC-003，DS2）：判断「支不支持」问能力，不要问模型名。
   * 实现必须显式声明；不确定的项按最弱档（见 capabilities.ts 的 CONSERVATIVE_CAPABILITIES）。
   */
  readonly capabilities: ModelCapabilities;
  /**
   * 结构化输出：模型必须按 schema 返回 JSON。
   * 实现负责校验（zod safeParse）；校验失败抛 ModelError。
   */
  chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    /** 重试次数由实现内部处理（结构化默认重试一次） */
  }): Promise<T>;
  /** 纯文本问答。 */
  chatText(input: { system: string; user: string }): Promise<string>;
}

/** 模型调用错误（重试与不保存残缺结论由调用方处理）。 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
