import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ImportService,
  parseClaudeConversations,
  parseGrokConversations,
  parseGeminiActivity,
  looksLikeClaudeExport,
  looksLikeGrokExport,
  looksLikeGeminiExport,
  PermissionService,
  SourceStore,
  Vault,
  type CoreDatabase,
} from '../../src/index.js';

/**
 * B5 三平台导入器（Claude/Grok/Gemini）合成验证。
 *
 * 口径（用户 2026-09-13）：四平台真实样本不再索取——只有 ChatGPT；
 * 其余按公开导出格式实现 + 合成数据验证，真实数据用户日后随用随填。
 *
 * 格式依据（三源交叉核对）：
 * - Claude：eudoxia0/claude-export、shannon models.go、portable-ai-memory.org
 * - Grok：portable-ai-memory.org/providers/grok（2026-02 实测导出映射）
 * - Gemini：portable-ai-memory.org/providers/google（Takeout MyActivity 两变体）
 *
 * 断言四口径之一「自动化通过」：解析正确、幂等重导、权限边界不放宽
 * （导入仍需真实授权票据）、坏格式诚实失败。
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'b5-import-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟：尽力清理
    }
  }
});

// ---------------------------------------------------------------------------
// 合成 Claude 导出（结构对齐官方 conversations.json）
// ---------------------------------------------------------------------------

const CLAUDE_EXPORT = [
  {
    uuid: 'c-conv-001',
    name: '架构讨论',
    created_at: '2026-01-10T08:00:00.000Z',
    updated_at: '2026-01-10T08:30:00.000Z',
    chat_messages: [
      {
        uuid: 'c-msg-1',
        sender: 'human',
        text: '帮我评估一下 SQLite 和 LanceDB 的取舍',
        attachments: [],
        files: [],
        created_at: '2026-01-10T08:00:00.000Z',
      },
      {
        uuid: 'c-msg-2',
        sender: 'assistant',
        text: '',
        content: [
          { type: 'text', text: 'SQLite 是权威记录，LanceDB 做语义索引。' },
          { type: 'thinking', thinking: '(内部推理不应计入正文)' },
          { type: 'tool_use', name: 'web_search', input: { query: 'lancedb' } },
        ],
        attachments: [],
        files: [],
        created_at: '2026-01-10T08:05:00.000Z',
      },
      {
        uuid: 'c-msg-3',
        sender: 'human',
        text: '顺便看下这份文档',
        attachments: [
          {
            file_name: 'notes.md',
            file_size: 100,
            file_type: 'text/markdown',
            extracted_content: '项目笔记：迁移必须幂等。',
          },
        ],
        files: [{ file_uuid: 'f-1', file_name: '图纸.png' }],
        created_at: '2026-01-10T08:10:00.000Z',
      },
    ],
  },
  {
    uuid: 'c-conv-002',
    name: '空消息对话（只有 system 提示，应跳过空文本）',
    created_at: '2026-01-11T08:00:00.000Z',
    updated_at: '2026-01-11T08:05:00.000Z',
    chat_messages: [
      {
        uuid: 'c-msg-x',
        sender: 'assistant',
        text: '   ',
        attachments: [],
        files: [],
        created_at: '2026-01-11T08:00:00.000Z',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 合成 Grok 导出（prod-grok-backend.json：{conversations:[{conversation,responses}]}）
// ---------------------------------------------------------------------------

const GROK_EXPORT = {
  conversations: [
    {
      conversation: {
        id: 'g-conv-001',
        title: '蓝莓种植',
        user_id: 'g-user-1',
        create_time: '2026-02-01T10:00:00.000Z',
        modify_time: '2026-02-01T10:20:00.000Z',
        starred: true,
      },
      responses: [
        {
          response: {
            _id: 'g-msg-1',
            parent_response_id: null,
            sender: 'human',
            message: { content: { text: '蓝莓在花园里怎么种？' } },
            create_time: { $date: { $numberLong: '1769959200000' } },
          },
        },
        {
          response: {
            _id: 'g-msg-2',
            parent_response_id: 'g-msg-1',
            sender: 'ASSISTANT',
            message: '九棵蓝莓需要酸性土壤。',
            create_time: { $date: { $numberLong: '1769959260000' } },
            model: 'grok-3',
          },
        },
        {
          response: {
            _id: 'g-msg-3',
            parent_response_id: 'g-msg-1',
            sender: 'grok-3',
            message: { text: '分支回答：也可以盆栽。' },
            create_time: 1769959320000,
            model: 'grok-3',
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 合成 Gemini Takeout（MyActivity.json：两变体混存，按 titleUrl 分组）
// ---------------------------------------------------------------------------

const GEMINI_EXPORT = [
  {
    header: 'Gemini',
    title: 'Used Gemini Apps',
    titleUrl: 'https://gemini.google.com/app/c/gem-conv-001',
    time: '2026-03-01T09:00:00.000Z',
    products: ['Gemini Apps'],
    details: [
      { name: 'Request', value: '帮我总结析衍项目进展' },
      { name: 'Response', value: 'B0 基线已完成。' },
    ],
  },
  {
    header: 'Gemini',
    title: 'Used Gemini Apps',
    titleUrl: 'https://gemini.google.com/app/c/gem-conv-001',
    time: '2026-03-01T09:10:00.000Z',
    products: ['Gemini Apps'],
    userInteractions: [
      {
        userInteraction: {
          endpoint: 2,
          request: '["继续说B1"]',
          response: '["B1 已通过真机探针。"]',
        },
      },
    ],
  },
  {
    header: 'Gemini',
    title: 'Used Gemini Apps',
    titleUrl: 'https://gemini.google.com/app/c/gem-conv-002',
    time: '2026-03-02T09:00:00.000Z',
    products: ['Gemini Apps'],
    details: [
      { name: 'Request', value: '只有请求没有响应的条目' },
      // 响应缺失：Takeout 已知数据损失，应如实标注
    ],
  },
];

describe('B5 三平台导入器（合成验证）', () => {
  it('Claude：线性对话+content块+附件提取文本+thinking 不冒充正文', () => {
    const sources = parseClaudeConversations(CLAUDE_EXPORT, { accountNamespace: 'test' });
    expect(sources.length).toBe(2);

    const conv = sources[0]!;
    expect(conv.provider).toBe('claude_export');
    expect(conv.externalId).toBe('c-conv-001');
    expect(conv.title).toBe('架构讨论');
    // 3 条消息：user / assistant(content 块拼正文) / user(附件文本并入)
    expect(conv.segments.length).toBe(3);
    expect(conv.segments[0]!.role).toBe('user');
    expect(conv.segments[1]!.text).toContain('SQLite 是权威记录');
    // thinking/tool_use 不进正文但计数
    expect(conv.segments[1]!.text).not.toContain('内部推理');
    expect(conv.segments[1]!.metadata.non_text_blocks).toBe(2);
    // 附件提取文本并入正文；file 只记名
    expect(conv.segments[2]!.text).toContain('迁移必须幂等');
    expect(conv.segments[2]!.text).toContain('图纸.png');
    const meta = conv.metadata as Record<string, unknown>;
    expect(meta.unparsed_attachments).toBeGreaterThan(0);
    expect(conv.capturedAt).toBe('2026-01-10T08:30:00.000Z');

    // 空文本对话：保留来源但 segments 只含非空消息
    const empty = sources[1]!;
    expect(empty.segments.length).toBe(0);
  });

  it('Claude：幂等重导同 contentHash', () => {
    const a = parseClaudeConversations(CLAUDE_EXPORT, { accountNamespace: 'test' });
    const b = parseClaudeConversations(CLAUDE_EXPORT, { accountNamespace: 'test' });
    expect(a[0]!.contentHash).toBe(b[0]!.contentHash);
    // 命名空间不同不合并
    const c = parseClaudeConversations(CLAUDE_EXPORT, { accountNamespace: 'other' });
    expect(c[0]!.contentHash).not.toBe(a[0]!.contentHash);
  });

  it('Grok：DAG parent 保留、BSON 时间、大小写不敏感 sender 归一、模型名当 assistant', () => {
    const arr = (GROK_EXPORT as { conversations: unknown[] }).conversations;
    const sources = parseGrokConversations(arr, { accountNamespace: 'test' });
    expect(sources.length).toBe(1);

    const conv = sources[0]!;
    expect(conv.provider).toBe('grok_export');
    expect(conv.externalId).toBe('g-conv-001');
    expect(conv.segments.length).toBe(3);
    // sender 归一：human→user；ASSISTANT/模型名→assistant
    expect(conv.segments.map((s) => s.role)).toEqual(['user', 'assistant', 'assistant']);
    // message 兼容三种形状：{content:{text}} / 字符串 / {text}
    expect(conv.segments[0]!.text).toContain('蓝莓');
    expect(conv.segments[1]!.text).toContain('酸性土壤');
    expect(conv.segments[2]!.text).toContain('盆栽');
    // BSON 时间戳解析（1769959200000ms = 2026-02-01T15:20:00Z）
    expect(conv.segments[0]!.occurredAt).toBe('2026-02-01T15:20:00.000Z');
    expect(conv.segments[1]!.occurredAt).toBe('2026-02-01T15:21:00.000Z');
    // 数值型 create_time 同样解析
    expect(conv.segments[2]!.occurredAt).toBe('2026-02-01T15:22:00.000Z');
    // DAG 边保留
    expect(conv.segments[1]!.externalParentId).toBe('g-msg-1');
    expect(conv.segments[2]!.externalParentId).toBe('g-msg-1');
    expect(conv.metadata.dag_edges).toBe(2);
    expect(conv.segments[1]!.metadata.model).toBe('grok-3');
  });

  it('Grok：幂等 + 空导出诚实失败', () => {
    const arr = (GROK_EXPORT as { conversations: unknown[] }).conversations;
    const a = parseGrokConversations(arr, { accountNamespace: 'test' });
    const b = parseGrokConversations(arr, { accountNamespace: 'test' });
    expect(a[0]!.contentHash).toBe(b[0]!.contentHash);
    expect(() => parseGrokConversations([], {})).toThrow('没有可解析的对话');
  });

  it('Gemini：titleUrl 分组重建、两变体混存、响应缺失如实标注、标题取首条用户消息', () => {
    const sources = parseGeminiActivity(GEMINI_EXPORT, { accountNamespace: 'test' });
    expect(sources.length).toBe(2);

    const conv1 = sources[0]!;
    expect(conv1.provider).toBe('gemini_export');
    expect(conv1.externalId).toBe('gem-conv-001');
    // 标题来自首条用户消息（title 恒为 Used Gemini Apps，无意义）
    expect(conv1.title).toBe('帮我总结析衍项目进展');
    // 两条活动合并：details 2 段 + userInteractions 2 段 = 4 segments
    expect(conv1.segments.length).toBe(4);
    expect(conv1.segments.map((s) => s.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // 变体 B 序列化 JSON 字符串提取文本
    expect(conv1.segments[2]!.text).toContain('继续说B1');
    expect(conv1.segments[3]!.text).toContain('真机探针');
    // 活动按时间排序
    expect(conv1.segments[0]!.occurredAt).toBe('2026-03-01T09:00:00.000Z');
    expect(conv1.capturedAt).toBe('2026-03-01T09:10:00.000Z');
    const meta1 = conv1.metadata as Record<string, unknown>;
    expect(meta1.missing_fields).toContain('message_id'); // Takeout 恒无消息 ID

    // 无响应的会话：truncated_responses 如实标注
    const conv2 = sources[1]!;
    expect(conv2.segments.length).toBe(1);
    const meta2 = conv2.metadata as Record<string, unknown>;
    expect(meta2.truncated_responses).toBe(1);
    expect(meta2.missing_fields).toContain('assistant_response');
  });

  it('内容嗅探：三种格式互不误判，ChatGPT 导出不会被三平台解析器吞掉', () => {
    expect(looksLikeClaudeExport(CLAUDE_EXPORT)).toBe(true);
    expect(looksLikeClaudeExport(GROK_EXPORT)).toBe(false);
    expect(looksLikeGrokExport(GROK_EXPORT)).toBe(true);
    expect(looksLikeGrokExport(CLAUDE_EXPORT)).toBe(false);
    expect(looksLikeGeminiExport(GEMINI_EXPORT)).toBe(true);
    expect(looksLikeGeminiExport(CLAUDE_EXPORT)).toBe(false);
    // ChatGPT 导出（带 mapping）不命中三平台嗅探
    expect(looksLikeClaudeExport([{ mapping: {}, title: 'x' }])).toBe(false);
  });

  it('端到端：importFile 走权限边界 + 入库 + 幂等重导去重（Claude/Grok/Gemini 各一）', () => {
    const dir = tempDir();
    const db: CoreDatabase = openDatabase(join(dir, 'test.db'));
    migrate(db);
    const vault = new Vault(join(dir, 'vault'));
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const service = new ImportService(db, vault, permissions, sources);

    // 造一条真实授权（模拟主进程对话框流程产物）
    const grantFile = join(dir, 'claude-conversations.json');
    const permission = permissions.grantFile(grantFile);

    // 写入合成 Claude 导出（官方同名 conversations.json）
    writeFileSync(grantFile, JSON.stringify(CLAUDE_EXPORT), 'utf8');

    const r1 = service.importFile(grantFile, {
      projectId: null,
      permissionId: permission.id,
      accountNamespace: 'claude-test',
    });
    expect(r1.created.length).toBe(2);
    expect(r1.created[0]!.provider).toBe('claude_export');

    // 重导：内容未变 → 全部去重，不产生新来源
    const r2 = service.importFile(grantFile, {
      projectId: null,
      permissionId: permission.id,
      accountNamespace: 'claude-test',
    });
    expect(r2.created.length).toBe(0);
    expect(r2.deduplicated.length).toBe(2);

    // Grok 端到端
    const grokFile = join(dir, 'prod-grok-backend.json');
    writeFileSync(grokFile, JSON.stringify(GROK_EXPORT), 'utf8');
    const permGrok = permissions.grantFile(grokFile);
    const r3 = service.importFile(grokFile, {
      projectId: null,
      permissionId: permGrok.id,
      accountNamespace: 'grok-test',
    });
    expect(r3.created.length).toBe(1);
    expect(r3.created[0]!.provider).toBe('grok_export');

    // Gemini 端到端
    const geminiFile = join(dir, 'MyActivity.json');
    writeFileSync(geminiFile, JSON.stringify(GEMINI_EXPORT), 'utf8');
    const permGemini = permissions.grantFile(geminiFile);
    const r4 = service.importFile(geminiFile, {
      projectId: null,
      permissionId: permGemini.id,
      accountNamespace: 'gemini-test',
    });
    expect(r4.created.length).toBe(2);
    expect(r4.created[0]!.provider).toBe('gemini_export');

    // 权限边界不放宽：无授权票据拒绝（P1-5 既有约束对新导入器同样生效）
    expect(() =>
      service.importFile(grokFile, {
        projectId: null,
        permissionId: '00000000-0000-4000-8000-000000000000',
        accountNamespace: 'x',
      }),
    ).toThrow();

    // 撤权后拒绝重导
    permissions.revoke(permGrok.id);
    expect(() =>
      service.importFile(grokFile, {
        projectId: null,
        permissionId: permGrok.id,
        accountNamespace: 'x',
      }),
    ).toThrow();
  });

  it('坏格式诚实失败：文件名是导出名但内容不是', () => {
    const dir = tempDir();
    const db: CoreDatabase = openDatabase(join(dir, 'test.db'));
    migrate(db);
    const vault = new Vault(join(dir, 'vault'));
    const permissions = new PermissionService(db);
    const sources = new SourceStore(db);
    const service = new ImportService(db, vault, permissions, sources);

    const bad = join(dir, 'prod-grok-backend.json');
    writeFileSync(bad, '{"foo": "不是导出格式"}', 'utf8');
    const perm = permissions.grantFile(bad);
    expect(() => service.importFile(bad, { projectId: null, permissionId: perm.id })).toThrow(
      '未命中已知结构',
    );
  });
});
