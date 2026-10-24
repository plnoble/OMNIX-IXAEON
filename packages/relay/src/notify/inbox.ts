/**
 * L16 契约第 3 条：认不认这条飞书消息，以及收听要用的几个小工具。
 *
 * **acceptMessage 是空壳**：签名先按契约写死，行为还没实现（B 档先只推测试）。实现在实现阶段补。
 */
export interface FeishuApp {
  appId: string;
  appSecret: string;
  chatId?: string;
  ownerOpenId?: string;
}

export function acceptMessage(
  event: unknown,
  app: { chatId?: string; ownerOpenId?: string },
): { ok: true; id: string; text: string } | { ok: false; why: string } {
  void event;
  void app;
  throw new Error('acceptMessage 还没实现（L16）');
}
