/**
 * L16 契约第 2 条：飞书官方 SDK 的长连接那一层。只做一件事——连上、把 `im.message.receive_v1`
 * 事件原样交给 `onEvent`。不调任何别的接口；往群里回话照旧走 L3 的自定义机器人（不在这里）。
 *
 * 测试不连真飞书：`relay listen` 读 `IXAEON_RELAY_EVENT_SRC`，指向一个导出同名 `startEventSource`
 * 的模块（假的事件源），实现不变。
 */
import * as lark from '@larksuiteoapi/node-sdk';

export interface EventSource {
  stop(): void;
}

export async function startEventSource(opts: {
  appId: string;
  appSecret: string;
  onEvent: (event: unknown) => Promise<void> | void;
}): Promise<EventSource> {
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const d = data as { header?: unknown };
      // handler 拿到的一般是事件本身（{message, sender}）；包成完整信封再交出去
      await opts.onEvent({ header: d.header ?? {}, event: data });
    },
  });
  const ws = new lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    loggerLevel: lark.LoggerLevel.error,
  });
  await ws.start({ eventDispatcher: dispatcher });
  return {
    stop: () => {
      // SDK 1.76 的 WSClient 有 close()；拿不到就不管（进程退出时连接自己断）
      (ws as unknown as { close?: () => void }).close?.();
    },
  };
}
