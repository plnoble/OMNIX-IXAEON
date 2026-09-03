import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** fixtures 目录绝对路径。 */
export function fixturesDir(): string {
  return join(here, '..', 'fixtures');
}

/** 取 fixture 文件绝对路径。 */
export function fixturePath(...segments: string[]): string {
  return join(fixturesDir(), ...segments);
}

/** 仓库根目录（含三份只读历史文档与开发计划）。 */
export function repoRoot(): string {
  return join(here, '..', '..', '..');
}

/** 根目录三份历史思想文档（只读测试资料）。 */
export function readonlyThoughtDocs(): string[] {
  return [
    join(repoRoot(), 'JARVIS_CONSTITUTION_v0.1.md'),
    join(repoRoot(), 'grok-20260903-IXAEON-思想碰撞.md'),
  ];
}

/** 模拟 ChatGPT 对话页（扩展 e2e 用：含 user/assistant 两轮 + 侧栏噪音）。 */
export function chatgptMockPagePath(): string {
  return join(fixturesDir(), 'web', 'chatgpt-mock.html');
}

// ---------------------------------------------------------------------------
// ChatGPT 导出包模拟数据
// ---------------------------------------------------------------------------

export interface FakeConversationOptions {
  title?: string;
  /** 顶层消息数（每条产生一个 user + 一个 assistant 节点） */
  turns?: number;
  /** 是否产生一个被否决的分支（兄弟节点，不在当前活动分支上） */
  withInactiveBranch?: boolean;
  createTime?: number;
}

export interface FakeChatgptExport {
  title: string;
  create_time: number;
  update_time: number;
  conversation_id: string;
  current_node: string;
  mapping: Record<
    string,
    {
      id: string;
      message: {
        id: string;
        author: { role: string };
        create_time: number | null;
        content: { content_type: string; parts: string[] };
        status?: string;
      } | null;
      parent: string | null;
      children: string[];
    }
  >;
}

let fakeCounter = 0;

/** 生成一条模拟 ChatGPT 对话（结构与官方导出一致：mapping 树 + current_node）。 */
export function makeFakeConversation(opts: FakeConversationOptions = {}): FakeChatgptExport {
  const title = opts.title ?? `测试对话 ${(fakeCounter += 1)}`;
  const turns = opts.turns ?? 3;
  const createTime = opts.createTime ?? 1735689600.0; // 2025-01-01T00:00:00Z
  const mapping: FakeChatgptExport['mapping'] = {};
  const rootId = 'root-node';

  mapping[rootId] = {
    id: rootId,
    message: null,
    parent: null,
    children: [],
  };

  let parent = rootId;
  let lastAssistantId: string | null = null;
  for (let i = 0; i < turns; i++) {
    const userNodeId = `user-node-${i}`;
    const assistantNodeId = `assistant-node-${i}`;
    mapping[userNodeId] = {
      id: userNodeId,
      message: {
        id: userNodeId,
        author: { role: 'user' },
        create_time: createTime + i * 60,
        content: { content_type: 'text', parts: [`用户消息 ${i}：请继续说明 IXAEON 的设计。`] },
        status: 'finished_successfully',
      },
      parent,
      children: [assistantNodeId],
    };
    mapping[assistantNodeId] = {
      id: assistantNodeId,
      message: {
        id: assistantNodeId,
        author: { role: 'assistant' },
        create_time: createTime + i * 60 + 30,
        content: {
          content_type: 'text',
          parts: [`AI 回答 ${i}：IXAEON（析衍）坚持原文永久保留、当前理解可纠正。`],
        },
        status: 'finished_successfully',
      },
      parent: userNodeId,
      children: [],
    };
    mapping[parent]!.children.push(userNodeId);
    parent = assistantNodeId;
    lastAssistantId = assistantNodeId;
  }

  const currentNode = lastAssistantId ?? rootId;

  if (opts.withInactiveBranch && lastAssistantId) {
    // 在最后一个 user 节点下追加一个"被重新生成替代"的 assistant 分支
    const regenParent = mapping[lastAssistantId]!.parent as string;
    const inactiveNodeId = 'assistant-node-inactive';
    mapping[inactiveNodeId] = {
      id: inactiveNodeId,
      message: {
        id: inactiveNodeId,
        author: { role: 'assistant' },
        create_time: createTime + 90,
        content: { content_type: 'text', parts: ['这是被重新生成替代的旧回答。'] },
        status: 'finished_successfully',
      },
      parent: regenParent,
      children: [],
    };
    mapping[regenParent]!.children.push(inactiveNodeId);
    // current_node 仍指向活动分支
  }

  return {
    title,
    create_time: createTime,
    update_time: createTime + turns * 60,
    conversation_id: `fake-conv-${fakeCounter}`,
    current_node: currentNode,
    mapping,
  };
}

/** 生成完整 conversations.json 内容（字符串）。 */
export function makeConversationsJson(convs?: FakeChatgptExport[]): string {
  return JSON.stringify(
    convs ?? [makeFakeConversation(), makeFakeConversation({ title: '第二条对话', turns: 2 })],
    null,
    2,
  );
}
