/**
 * CF3 验收（core，规格 docs/委派/CF3-直连模型做聊天主引擎.md）——条件 5、6、7、9。
 *
 * 逐条对应规格「验收条件」：
 * - 条件 5：假客户端第 1 轮调 search_memory、第 2 轮回正文 →
 *   tools.call 收到工具名与参数；第 2 次请求的 messages 里有那条 role:'tool'；
 *   steps 有一条 search_memory；memoryUsed 是预先注入的 + 工具查到的，按 id 去重。
 * - 条件 6：每轮都调工具 → 最多执行 6 轮工具；第 7 次请求不带 tools；
 *   最后 status:'succeeded' 且有正文。
 * - 条件 7：第一次请求的 messages 顺序 = system → 含 contextBlock 的一条 →
 *   此前的轮次按原顺序原角色 → 这一问；此前轮次超过 6000 字时丢最早的。
 * - 条件 9：工具返回 ok:false（如搜索没配置）→ 这一轮不中断，结果作为 tool 消息交给模型，
 *   最后 status:'succeeded'。
 *
 * 一律不联网、不碰真库：假客户端 + 替身工具。合成数据。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemoryUsedItem } from '@ixaeon/contracts';
import {
  DIRECT_CHAT_SYSTEM_PROMPT,
  FakeStreamChatClient,
  runDirectChat,
  type ChatToolDef,
  type ChatToolCall,
  type DirectChatTools,
  type PriorTurn,
} from '../../src/index.js';

/**
 * 仅用于「实现还没到位」时也能通过类型检查的最小结构。
 * 实现到位后这些注解依然成立（ChatMessage / AgentStep / MemoryUsedItem 都是它们的子类型）。
 */
type Msg = { role: string; content: string; toolCallId?: string };
type Step = { tool: string; ok: boolean };
type Mem = { id: string };

const TOOL_DEFS: ChatToolDef[] = [
  { name: 'search_memory', description: '查用户的记忆', parameters: { type: 'object' } },
  { name: 'search_web', description: '联网搜索', parameters: { type: 'object' } },
];

function memory(id: string, statement: string): MemoryUsedItem {
  return { id, statement, tag: '用户指定' };
}

function toolsStub(
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    content: string;
    memoryUsed?: MemoryUsedItem[];
  }>,
): DirectChatTools & { call: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(call);
  return { defs: TOOL_DEFS, call: spy } as unknown as DirectChatTools & {
    call: ReturnType<typeof vi.fn>;
  };
}

const PRIOR: PriorTurn[] = [
  { role: 'user', content: '之前问的' },
  { role: 'assistant', content: '之前答的' },
];

describe('CF3 条件 5–7、9：runDirectChat 工具循环', () => {
  it('条件 5：调一次 search_memory 再回正文 → 工具结果回灌、steps 与 memoryUsed 正确', async () => {
    const toolCall: ChatToolCall = {
      id: 't1',
      name: 'search_memory',
      arguments: '{"query":"合成问题"}',
    };
    const client = new FakeStreamChatClient([{ toolCalls: [toolCall] }, { deltas: ['答', '案'] }]);
    const tools = toolsStub(async () => ({
      ok: true,
      content: '合成记忆：用户喜欢简洁的回答',
      memoryUsed: [memory('m-tool', '工具查到的合成记忆')],
    }));
    const pre = [memory('m-pre', '预先注入的合成记忆'), memory('m-tool', '重复的同一条')];

    const result = await runDirectChat({
      client,
      question: '合成问题',
      priorTurns: PRIOR,
      contextBlock: '合成上下文块',
      preMemoryUsed: pre,
      tools,
    });

    // tools.call 收到工具名与参数
    expect(tools.call).toHaveBeenCalledTimes(1);
    expect(tools.call.mock.calls[0]![0]).toBe('search_memory');
    expect(tools.call.mock.calls[0]![1]).toEqual({ query: '合成问题' });

    // 第 2 次请求的 messages 里有那条 role:'tool' 的结果
    expect(client.calls.length).toBeGreaterThanOrEqual(2);
    const second = client.calls[1]!.messages;
    const toolMessage = second.find((m: Msg) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect((toolMessage as { toolCallId?: string }).toolCallId).toBe('t1');
    expect((toolMessage as { content?: string }).content).toContain('合成记忆');

    // steps 有一条 search_memory
    expect(result.steps.filter((s: Step) => s.tool === 'search_memory')).toHaveLength(1);
    expect(result.steps.find((s: Step) => s.tool === 'search_memory')!.ok).toBe(true);

    // memoryUsed = 预先 + 工具查到，按 id 去重
    const ids = result.memoryUsed.map((m: Mem) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('m-pre');
    expect(ids).toContain('m-tool');
    expect(result.memoryUsed).toHaveLength(2);

    expect(result.status).toBe('succeeded');
    expect(result.answer).toBe('答案');
  });

  it('条件 6：每轮都调工具 → 最多 6 轮工具，第 7 次请求不带 tools，最终 succeeded', async () => {
    const rounds: Array<{ toolCalls: ChatToolCall[] }> = [];
    for (let i = 1; i <= 6; i += 1) {
      rounds.push({
        toolCalls: [
          { id: `t${i}`, name: 'search_memory', arguments: JSON.stringify({ query: `第${i}次` }) },
        ],
      });
    }
    const client = new FakeStreamChatClient([...rounds, { deltas: ['最终', '回答'] }]);
    const tools = toolsStub(async () => ({ ok: true, content: '合成工具结果' }));

    const result = await runDirectChat({
      client,
      question: '合成问题',
      priorTurns: [],
      contextBlock: '',
      preMemoryUsed: [],
      tools,
    });

    // 6 轮工具 + 第 7 次直答
    expect(tools.call).toHaveBeenCalledTimes(6);
    expect(client.calls).toHaveLength(7);
    const lastTools = client.calls[6]!.tools;
    expect(lastTools === undefined || lastTools.length === 0).toBe(true);

    expect(result.status).toBe('succeeded');
    expect(result.answer).toBe('最终回答');
  });

  it('条件 7：第一次请求的 messages 顺序 = system → 上下文 → 此前轮次 → 这一问', async () => {
    const client = new FakeStreamChatClient([{ deltas: ['好'] }]);
    const tools = toolsStub(async () => ({ ok: true, content: '' }));

    await runDirectChat({
      client,
      question: '这一问',
      priorTurns: PRIOR,
      contextBlock: '合成上下文块 ABC',
      preMemoryUsed: [],
      tools,
    });

    const messages = client.calls[0]!.messages;
    expect(messages[0]).toEqual({ role: 'system', content: DIRECT_CHAT_SYSTEM_PROMPT });

    const contextIndex = messages.findIndex(
      (m: Msg) => m.role === 'user' && m.content.includes('合成上下文块 ABC'),
    );
    expect(contextIndex).toBeGreaterThan(0);

    // 此前的轮次按原顺序、原角色
    const priorMessages = messages.filter(
      (m: Msg) => (m.role !== 'system' && m.content === '之前问的') || m.content === '之前答的',
    );
    expect(priorMessages.map((m: Msg) => m.role)).toEqual(['user', 'assistant']);
    expect(priorMessages.map((m: Msg) => m.content)).toEqual(['之前问的', '之前答的']);

    // 这一问在最后
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '这一问' });
  });

  it('条件 7（超限）：此前轮次超过 6000 字时丢的是最早的', async () => {
    const long = '早'.repeat(7000);
    const client = new FakeStreamChatClient([{ deltas: ['好'] }]);
    const tools = toolsStub(async () => ({ ok: true, content: '' }));

    await runDirectChat({
      client,
      question: '这一问',
      priorTurns: [
        { role: 'user', content: long },
        { role: 'assistant', content: '最近的回答' },
      ],
      contextBlock: '',
      preMemoryUsed: [],
      tools,
    });

    const contents = client.calls[0]!.messages.map((m: Msg) => m.content);
    expect(contents.includes(long)).toBe(false);
    expect(contents).toContain('最近的回答');
  });

  it('条件 9：工具返回 ok:false → 不中断，结果作为 tool 消息交给模型，最终 succeeded', async () => {
    const client = new FakeStreamChatClient([
      { toolCalls: [{ id: 'w1', name: 'search_web', arguments: '{"query":"合成查询"}' }] },
      { deltas: ['照常', '回答'] },
    ]);
    const tools = toolsStub(async () => ({
      ok: false,
      content: '联网搜索没有配置：设置里填搜索服务的 Key',
    }));

    const result = await runDirectChat({
      client,
      question: '合成问题',
      priorTurns: [],
      contextBlock: '',
      preMemoryUsed: [],
      tools,
    });

    const toolMessage = client.calls[1]!.messages.find((m: Msg) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect((toolMessage as { content: string }).content).toContain('联网搜索没有配置');
    expect(result.status).toBe('succeeded');
    expect(result.answer).toBe('照常回答');
    expect(result.steps.find((s: Step) => s.tool === 'search_web')!.ok).toBe(false);
  });
});
