/**
 * L16 验收测试（一）：认不认这条飞书消息（规格条件 1，对应契约第 3 条）。
 *
 * 逐条对应：合成的 `im.message.receive_v1` 事件——
 * - 本人在绑定的群里 @ 机器人说「76 要」→ `ok`，`text` 是 `76 要`；
 * - 换一个群、换一个人、没有 @、图片消息、只 @ 不说话 → 各自不 `ok`，`why` 里不带消息内容。
 *
 * 全是纯函数调用，不起进程、不连飞书。原话用合成的（「76 要」）。
 */
import { describe, expect, it } from 'vitest';
import { acceptMessage } from '../../src/notify/inbox.js';

const APP = { chatId: 'oc_bound', ownerOpenId: 'ou_owner' };

/** 合成一条 im.message.receive_v1 事件（形状照飞书开放平台的文档）。 */
const event = (o: {
  id?: string;
  chatId?: string;
  chatType?: string;
  sender?: string;
  mentions?: number;
  type?: string;
  text?: string;
}) => ({
  header: { event_type: 'im.message.receive_v1' },
  event: {
    message: {
      message_id: o.id ?? 'om_1',
      chat_id: o.chatId ?? 'oc_bound',
      chat_type: o.chatType ?? 'group',
      message_type: o.type ?? 'text',
      mentions: Array.from({ length: o.mentions ?? 1 }, (_, i) => ({
        key: `@_user_${i + 1}`,
        id: { open_id: 'ou_bot' },
      })),
      content: JSON.stringify({ text: o.text ?? '@_user_1 76 要' }),
    },
    sender: { sender_id: { open_id: o.sender ?? 'ou_owner' } },
  },
});

describe('条件 1：acceptMessage', () => {
  it('本人在绑定的群里 @ 机器人说「76 要」→ ok，text 是 76 要', () => {
    const r = acceptMessage(event({}), APP);
    expect(r).toMatchObject({ ok: true, id: 'om_1', text: '76 要' });
  });

  it('换一个群 → 不 ok；换一个人 → 不 ok', () => {
    const otherChat = acceptMessage(event({ chatId: 'oc_other' }), APP);
    expect(otherChat.ok).toBe(false);
    const otherSender = acceptMessage(event({ sender: 'ou_stranger' }), APP);
    expect(otherSender.ok).toBe(false);
  });

  it('没有 @ → 不 ok；图片消息 → 不 ok；只 @ 不说话 → 不 ok', () => {
    const noMention = acceptMessage(event({ mentions: 0 }), APP);
    expect(noMention.ok).toBe(false);
    const image = acceptMessage(event({ type: 'image', text: undefined }), APP);
    expect(image.ok).toBe(false);
    const onlyAt = acceptMessage(event({ text: '@_user_1   ' }), APP);
    expect(onlyAt.ok).toBe(false);
  });

  it('不是群聊（p2p）→ 不 ok', () => {
    const p2p = acceptMessage(event({ chatType: 'p2p' }), APP);
    expect(p2p.ok).toBe(false);
  });

  // 整合方补（2026-10-24）：飞书官方 SDK 的 EventDispatcher 交给回调的是**摊平**的一份
  // （`message`、`sender` 直接在顶层，没有外面那层 `event`），和 HTTP 推送的原始形状不一样。
  // 两种都要认，不然测试全过、真连上之后一条都不认。
  it('SDK 摊平的形状（没有外层 event）也认；换人照样不认', () => {
    const flat = (sender: string) => {
      const raw = event({ sender }) as {
        header: Record<string, unknown>;
        event: Record<string, unknown>;
      };
      return { event_type: 'im.message.receive_v1', ...raw.event };
    };
    expect(acceptMessage(flat('ou_owner'), APP)).toMatchObject({
      ok: true,
      id: 'om_1',
      text: '76 要',
    });
    expect(acceptMessage(flat('ou_stranger'), APP).ok).toBe(false);
  });

  it('整合方补：还没绑定（app 里没有 chatId / ownerOpenId）→ 不 ok；不是对象 → 不 ok、不抛错', () => {
    expect(acceptMessage(event({}), {}).ok).toBe(false);
    expect(acceptMessage(event({}), { chatId: 'oc_bound' }).ok).toBe(false);
    expect(acceptMessage(null, APP).ok).toBe(false);
    expect(acceptMessage('不是事件', APP).ok).toBe(false);
  });

  it('整合方补：去掉的是 @ 占位，不是别的字；@ 两个人也去干净', () => {
    const r = acceptMessage(
      event({ mentions: 2, text: '@_user_1 @_user_2  第 76 行改成待领 ' }),
      APP,
    );
    expect(r).toMatchObject({ ok: true, text: '第 76 行改成待领' });
  });

  it('不认的时候 why 里不带消息内容', () => {
    for (const e of [
      event({ chatId: 'oc_other' }),
      event({ sender: 'ou_stranger' }),
      event({ mentions: 0 }),
      event({ type: 'image', text: undefined }),
      event({ text: '@_user_1  ' }),
    ]) {
      const r = acceptMessage(e, APP);
      if (!r.ok) {
        expect(r.why).not.toContain('76');
        expect(r.why).not.toContain('@_user_1');
        expect(r.why.length).toBeGreaterThan(0);
      }
    }
  });
});
