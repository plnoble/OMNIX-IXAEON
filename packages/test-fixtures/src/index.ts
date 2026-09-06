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

// ---------------------------------------------------------------------------
// M2 六类固定语义资料（《下一阶段开发计划》M2 验收要求）
// 每类提供：原文、模型提取输出、用户动作、预期判据（先写判据再运行）。
// 合成资料 + FakeProvider；供自动化回归与真实模型验收共用判据。
// ---------------------------------------------------------------------------

export interface M2ScenarioTurn {
  order: number;
  role: 'user' | 'assistant';
  text: string;
}

export interface M2ScenarioModelItem {
  type: 'decision' | 'rejected_option' | 'open_loop' | 'goal' | 'constraint';
  statement: string;
  /** 必须真实出现在对应片段文本中（R5 摘录校验） */
  excerpt: string;
  segment_ref: string;
  rationale: string | null;
  confidence: number;
}

export interface M2Scenario {
  id: string;
  title: string;
  /** 对话原文（写入来源的片段） */
  turns: M2ScenarioTurn[];
  /** 模型首轮提取输出（FakeProvider 响应） */
  firstExtraction: M2ScenarioModelItem[];
  /** 用户动作 */
  userAction:
    | { kind: 'none' }
    | { kind: 'confirm'; itemIndex: number }
    | { kind: 'reject'; itemIndex: number }
    | { kind: 'correct'; itemIndex: number; userText: string };
  /** 次轮新增原文（S4 作为第二个来源注入） */
  secondTurns?: M2ScenarioTurn[];
  /** 模型次轮提取输出 */
  secondExtraction?: M2ScenarioModelItem[];
  /** 预期判据：items 表 */
  expectPersisted: Array<{
    statementIncludes: string;
    confirmation?: 'none' | 'confirmed' | 'rejected';
    origin?: 'ai' | 'user';
    state?: 'current' | 'superseded' | 'disputed';
    needsReview?: boolean;
  }>;
  /** 预期判据：MCP 简报（项目简报的 decisions/rejected/open_loops/risks/status） */
  expectBriefing: Array<{
    statementIncludes: string;
    present: boolean;
    labelIncludes?: string;
  }>;
}

export const M2_SCENARIOS: M2Scenario[] = [
  {
    id: 'S1',
    title: 'AI 提议但用户没答应',
    turns: [
      { order: 0, role: 'user', text: '项目日志现在有点乱，你有什么建议？' },
      {
        order: 1,
        role: 'assistant',
        text: '建议启用远程项目日志服务，把日志集中保存到云端。M2_S1_REMOTE_PROPOSAL',
      },
    ],
    firstExtraction: [
      {
        type: 'decision',
        statement: '启用远程项目日志服务集中保存日志',
        excerpt: '建议启用远程项目日志服务，把日志集中保存到云端',
        segment_ref: 'S3',
        rationale: null,
        confidence: 0.85,
      },
    ],
    userAction: { kind: 'none' },
    expectPersisted: [
      {
        statementIncludes: '远程项目日志服务',
        confirmation: 'none',
        origin: 'ai',
        needsReview: true, // G6：decision 未确认 → 待讨论
      },
    ],
    expectBriefing: [
      {
        statementIncludes: '远程项目日志服务',
        present: true,
        labelIncludes: '待用户确认', // 不能混成已拍板
      },
    ],
  },
  {
    id: 'S2',
    title: '用户明确否决',
    turns: [
      {
        order: 0,
        role: 'user',
        text: '我决定不采用云同步方案，数据必须全部留在本机。M2_S2_LOCAL_ONLY',
      },
      { order: 1, role: 'assistant', text: '明白，所有数据保存在本地。M2_S2_ACK' },
    ],
    firstExtraction: [
      {
        type: 'rejected_option',
        statement: '云同步方案已被用户明确否决',
        excerpt: '不采用云同步方案',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.95,
      },
    ],
    userAction: { kind: 'reject', itemIndex: 0 },
    expectPersisted: [
      {
        statementIncludes: '云同步方案已被用户明确否决',
        confirmation: 'rejected',
        origin: 'ai',
        state: 'current',
        needsReview: false,
      },
    ],
    expectBriefing: [{ statementIncludes: '云同步方案已被用户明确否决', present: false }],
  },
  {
    id: 'S3',
    title: '用户后来改口',
    turns: [
      { order: 0, role: 'user', text: '第一版先用 SQLite 做全文搜索。M2_S3_V1' },
      { order: 1, role: 'assistant', text: '好的，第一版采用 SQLite 全文搜索。M2_S3_ACK' },
    ],
    firstExtraction: [
      {
        type: 'decision',
        statement: '第一版采用 SQLite 全文搜索',
        excerpt: '第一版先用 SQLite 做全文搜索',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.9,
      },
    ],
    userAction: {
      kind: 'correct',
      itemIndex: 0,
      userText: '改为：第一版同时准备向量检索接口，但默认关闭',
    },
    secondTurns: [
      {
        order: 2,
        role: 'user',
        text: '补充：也把向量检索接口准备好，但默认关闭。M2_S3_V2',
      },
    ],
    secondExtraction: [
      {
        type: 'decision',
        statement: '第一版采用 SQLite 全文搜索',
        excerpt: '第一版先用 SQLite 做全文搜索',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.9,
      },
    ],
    expectPersisted: [
      {
        statementIncludes: '第一版采用 SQLite 全文搜索',
        origin: 'ai',
        state: 'superseded',
      },
      {
        statementIncludes: '同时准备向量检索接口，但默认关闭',
        origin: 'user',
        state: 'current',
      },
    ],
    expectBriefing: [
      {
        statementIncludes: '同时准备向量检索接口',
        present: true,
        labelIncludes: '用户确认',
      },
      { statementIncludes: '第一版采用 SQLite 全文搜索', present: false },
    ],
  },
  {
    id: 'S4',
    title: '不同来源矛盾',
    turns: [{ order: 0, role: 'user', text: '方案甲：使用 Electron 打包桌面端。M2_S4_ELECTRON' }],
    firstExtraction: [
      {
        type: 'decision',
        statement: '使用 Electron 打包桌面端',
        excerpt: '使用 Electron 打包桌面端',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.9,
      },
    ],
    userAction: { kind: 'none' },
    secondTurns: [
      {
        order: 0,
        role: 'user',
        text: '方案乙：改用 Tauri 打包桌面端，更轻量。M2_S4_TAURI',
      },
    ],
    secondExtraction: [
      {
        type: 'decision',
        statement: '改用 Tauri 打包桌面端',
        excerpt: '改用 Tauri 打包桌面端',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.9,
      },
    ],
    expectPersisted: [
      {
        statementIncludes: '改用 Tauri 打包桌面端',
        origin: 'ai',
        state: 'current',
      },
    ],
    expectBriefing: [
      {
        statementIncludes: '改用 Tauri 打包桌面端',
        present: true,
        labelIncludes: '待用户确认',
      },
    ],
  },
  {
    id: 'S5',
    title: '证据不足',
    turns: [
      {
        order: 0,
        role: 'user',
        text: '性能目标还没定，等测试数据出来再说。M2_S5_NO_DECISION',
      },
    ],
    firstExtraction: [
      {
        type: 'open_loop',
        statement: '性能目标尚未确定，等待测试数据',
        excerpt: '性能目标还没定',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.8,
      },
    ],
    userAction: { kind: 'none' },
    expectPersisted: [
      {
        statementIncludes: '性能目标尚未确定',
        origin: 'ai',
        state: 'current',
        needsReview: false, // open_loop 非重要决定类
      },
    ],
    expectBriefing: [{ statementIncludes: '性能目标尚未确定', present: true }],
  },
  {
    id: 'S6',
    title: '编码 agent 声称完成但用户未验收',
    turns: [{ order: 0, role: 'user', text: '让 Codex 去修复登录页的 bug。M2_S6_TASK' }],
    firstExtraction: [
      {
        type: 'open_loop',
        statement: '需要修复登录页的 bug',
        excerpt: '让 Codex 去修复登录页的 bug',
        segment_ref: 'S2',
        rationale: null,
        confidence: 0.9,
      },
    ],
    userAction: { kind: 'none' },
    expectPersisted: [{ statementIncludes: '修复登录页', origin: 'ai', state: 'current' }],
    expectBriefing: [{ statementIncludes: '修复登录页', present: true }],
  },
];
