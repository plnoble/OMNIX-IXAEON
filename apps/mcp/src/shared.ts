import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

/**
 * 两个入口共享的部分：schema、桌面端 HTTP 转发、工具注册。
 * 注意：这里不 import @ixaeon/core——它带 better-sqlite3（原生模块），
 * 打包后的安装包里 resources/mcp 没有可解析的 node_modules，
 * 入口级静态引用会让整个服务起不来（见 vite.config.ts 双入口说明）。
 */

export const DESKTOP_PORT = 43191;
export const BASE_URL = `http://127.0.0.1:${DESKTOP_PORT}`;

export function resolveToken(): string {
  const fromEnv = process.env.IXAEON_LOCAL_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const dataDir =
    process.env.IXAEON_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'OMNIX', 'IXAEON');
  try {
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as {
      localToken?: string;
    };
    if (typeof config.localToken === 'string' && config.localToken.length > 0) {
      return config.localToken;
    }
  } catch {
    // 无配置文件：回落到空（入口里给出明确错误）
  }
  return '';
}

/** 调用桌面端 MCP 端点；非 2xx 时抛 IxaError。 */
export async function callDesktop<T>(path: string, body: unknown, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new IxaError(
      ErrorCodes.SERVER_UNAVAILABLE,
      `无法连接 IXAEON 桌面端（${BASE_URL}）。请确认桌面应用已运行。`,
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const apiErr = json as { code?: string; message?: string } | null;
    const code = apiErr?.code ?? ErrorCodes.UNKNOWN;
    const message = apiErr?.message ?? res.statusText;
    const err = new IxaError(ErrorCodes.UNKNOWN, `${code} ${message}`);
    throw err;
  }
  return json as T;
}

export function errMessage(err: unknown): string {
  if (err instanceof IxaError) return `${err.code} ${err.message}`;
  return String(err);
}

// --- 工具输入 schema（raw shape，SDK 自动转换 JSON Schema） ---

export const prepareTaskShape = {
  project_ref: z.string().min(1).max(500).describe('项目名称、项目 ID 或本地根路径'),
  task: z.string().min(1).max(4000).describe('本次准备做什么'),
  max_chars: z
    .number()
    .int()
    .min(2000)
    .max(30000)
    .default(12000)
    .describe('简报字符预算（默认 12000，最小 2000，最大 30000）'),
};

export const searchContextShape = {
  query: z.string().min(1).max(2000).describe('查询文字'),
  project_ref: z.string().min(1).max(500).optional().describe('可选：限定项目'),
  type: z
    .enum([
      'project_summary',
      'decision',
      'rejected_option',
      'open_loop',
      'goal',
      'constraint',
      'preference',
    ])
    .optional()
    .describe('可选：条目类型'),
  limit: z.number().int().min(1).max(20).default(8).describe('结果数量（默认 8，最大 20）'),
};

export const getSourceExcerptShape = {
  ref: z
    .string()
    .min(1)
    .max(100)
    .describe('引用 ID（来自 prepare_task / search_context 的 ref 字段）'),
  max_chars: z
    .number()
    .int()
    .min(200)
    .max(5000)
    .default(2000)
    .describe('最大字符数（默认 2000，最大 5000）'),
};

// A06（审核 2026-09-13）：引擎记忆桥接工具。
export const recordObservationShape = {
  project_ref: z.string().min(1).max(500).describe('项目名称、ID 或根路径'),
  statement: z
    .string()
    .min(1)
    .max(2000)
    .describe('要记住的内容（写入待讨论候选，不自动成为用户决定）'),
  rationale: z.string().max(1000).optional().describe('可选：来源说明'),
};

export const getEvidenceShape = {
  item_id: z
    .string()
    .min(1)
    .max(100)
    .describe('条目 ID（来自 search_context / prepare_task 的 ref）'),
};

export const recordWorkResultShape = {
  client_ref: z
    .string()
    .min(8)
    .max(200)
    .optional()
    .describe('可选幂等键：网络重试用相同值重试不会产生重复工作记录；同键不同内容会被拒绝'),
  project_ref: z.string().min(1).max(500).describe('项目名称、ID 或根路径'),
  agent_name: z.string().min(1).max(200).describe('执行者名称（如 codex）'),
  task: z.string().min(1).max(4000).describe('本次任务描述'),
  outcome: z.enum(['success', 'partial', 'failed']).describe('结果状态'),
  summary: z.string().min(1).max(10000).describe('结果总结'),
  changes: z.array(z.string().max(2000)).max(200).describe('变更清单').default([]),
  tests: z
    .array(
      z.object({
        name: z.string().min(1).max(500),
        result: z.enum(['passed', 'failed', 'skipped']),
      }),
    )
    .max(500)
    .describe('测试结果')
    .default([]),
  open_loops: z
    .array(z.string().max(2000))
    .max(200)
    .describe('未完成事项（只产生待讨论候选，不自动成为用户决定）')
    .default([]),
  commit_ref: z.string().max(200).optional().describe('可选：提交引用'),
};

/** 注册全部工具；调用通道由入口决定（HTTP 转发或进程内直连）。 */
export function registerTools(
  server: McpServer,
  call: <T>(path: string, body: unknown) => Promise<T>,
): void {
  server.registerTool(
    'prepare_task',
    {
      description:
        '开始规划或修改前调用：取得项目目的、当前决定、已否决方案、未完成事项、' +
        '最近工作结果与风险，全部带本地引用 ID（用于 get_source_excerpt）。' +
        '返回内容有字符预算（默认 12000，可 2000-30000 调整）。',
      inputSchema: prepareTaskShape,
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/prepare-task', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'search_context',
    {
      description:
        '当 prepare_task 简报不足以完成任务时检索更多背景。返回短片段' +
        '（条目 + 原文摘录，含引用 ID、项目、类型、时间与当前/已替代状态）。默认 8 条，最大 20。',
      inputSchema: searchContextShape,
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/search-context', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_source_excerpt',
    {
      description:
        '用引用 ID（来自 prepare_task / search_context 的 ref 字段）核对原文细节。' +
        '返回原文片段、来源标题、角色、时间与前后少量上下文。默认 2000 字符，最大 5000。',
      inputSchema: getSourceExcerptShape,
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/get-source-excerpt', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'record_observation',
    {
      description:
        '把需要记住的内容写入 IXAEON 记忆（待讨论候选，需用户确认；不自动成为用户决定）。' +
        '需要记住用户告诉你的内容时用这个工具，不要用引擎自带的记忆——IXAEON 的记忆独立保存，引擎可替换。',
      inputSchema: recordObservationShape,
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/record-observation', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_evidence',
    {
      description: '用条目 ID 核对 IXAEON 记忆结论的原文与来源。未获准外发的条目会被拒绝。',
      inputSchema: getEvidenceShape,
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/get-evidence', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'record_work_result',
    {
      description:
        '结束时必须调用：写回工作结果（成功/部分/失败）、变更清单、测试结果与未完成事项。' +
        'open_loops 只产生待讨论候选，不会自动变成用户决定。',
      inputSchema: recordWorkResultShape,
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/record-work-result', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  // --- M1 工具链扩展：search_web / read_web / propose_task / get_task_status ---

  server.registerTool(
    'search_web',
    {
      description:
        '使用受控搜索引擎在公开互联网搜索资料。query 会在本地进行隐私脱敏，返回包含标题、链接、正文摘录的搜索结果列表。',
      inputSchema: {
        query: z.string().min(1).max(500).describe('脱敏后的公开搜索关键词'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .optional()
          .describe('返回条目上限（1-10）'),
      },
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/search-web', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'read_web',
    {
      description: '读取公开网页正文内容（支持静态抓取与动态 SPA 云端渲染）。',
      inputSchema: {
        url: z.string().url().describe('公开网页的 HTTPS 链接'),
      },
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/read-web', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'propose_task',
    {
      description:
        '在桌面上提出一个具体的编码修改任务提案。用户在桌面端审阅批准后才会真正执行。' +
        '包含目标、允许修改的文件范围、验证命令与修改理由。',
      inputSchema: {
        project_ref: z.string().min(1).max(500).describe('所属项目 ID、名称或根路径'),
        goal: z.string().min(1).max(2000).describe('具体编码目标'),
        scope: z
          .array(z.string())
          .min(1)
          .max(20)
          .default(['note.txt'])
          .optional()
          .describe('允许改动的文件列表'),
        verify_command: z.array(z.string()).optional().describe('受控验收命令（限 node 执行）'),
        rationale: z.string().max(1000).optional().describe('提议依据与方案说明'),
      },
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/propose-task', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_task_status',
    {
      description: '查询先前提出的编码任务的当前状态、执行结果报告、实际 diff 及验收结果。',
      inputSchema: {
        task_id: z.string().min(1).max(100).describe('任务 ID'),
      },
    },
    async (args) => {
      try {
        const result = await call('/api/mcp/get-task-status', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errMessage(err) }], isError: true };
      }
    },
  );
}
