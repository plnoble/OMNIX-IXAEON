import type { z } from 'zod';
import { ModelError, type ModelProvider } from './provider.js';

/**
 * 假模型（测试专用）：
 * - structuredResponses：按序消费；耗尽后抛错（测试必须显式给足或断言失败）
 * - textResponses：同上
 * - 收到的输入全部记录，供测试断言（例如提示词版本、上下文预算）
 */
export class FakeProvider implements ModelProvider {
  readonly modelName: string;
  readonly structuredCalls: Array<{ system: string; user: string }> = [];
  readonly textCalls: Array<{ system: string; user: string }> = [];
  private structuredQueue: unknown[] = [];
  private textQueue: string[] = [];
  /** 测试钩子：每次结构化调用前执行（可取消会话）。 */
  beforeStructured: (() => void) | null = null;

  constructor(modelName = 'fake-model-v1') {
    this.modelName = modelName;
  }

  /** 入队一个结构化响应（对象会按传入 schema 校验后返回）。 */
  enqueueStructured(response: unknown): this {
    this.structuredQueue.push(response);
    return this;
  }

  enqueueText(response: string): this {
    this.textQueue.push(response);
    return this;
  }

  async chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    this.beforeStructured?.();
    this.structuredCalls.push({ system: input.system, user: input.user });
    if (this.structuredQueue.length === 0) {
      throw new ModelError('FakeProvider 队列为空（测试未提供响应）', false);
    }
    const raw = this.structuredQueue.shift();
    const result = input.schema.safeParse(raw);
    if (!result.success) {
      throw new ModelError(`FakeProvider 响应未通过 schema: ${result.error.message}`, false);
    }
    return result.data;
  }

  async chatText(input: { system: string; user: string }): Promise<string> {
    this.textCalls.push({ system: input.system, user: input.user });
    if (this.textQueue.length === 0) {
      throw new ModelError('FakeProvider 文本队列为空（测试未提供响应）', false);
    }
    return this.textQueue.shift() as string;
  }
}
