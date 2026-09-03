import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorCodes, IxaError, MCP_SERVER_INSTRUCTIONS } from '@ixaeon/contracts';

/**
 * IXAEON MCP 服务（名称固定为 ixaeon）。
 * 通过 STDIO 与编码 AI（如 Codex）通信；工具实现转发到本机桌面端
 * HTTP 接口（127.0.0.1:43191，localToken 认证）。
 *
 * 令牌来源（优先级）：
 * 1. 环境变量 IXAEON_LOCAL_TOKEN
 * 2. IXAEON_DATA_DIR/config.json 的 localToken 字段
 * 3. 桌面端默认数据目录 %LOCALAPPDATA%\OMNIX\IXAEON\config.json
 */
const DESKTOP_PORT = 43191;
const BASE_URL = `http://127.0.0.1:${DESKTOP_PORT}`;

function resolveToken(): string {
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
    // 无配置文件：回落到空（main 里给出明确错误）
  }
  return '';
}

/** 调用桌面端 MCP 端点；非 2xx 时抛 IxaError。 */
async function callDesktop<T>(path: string, body: unknown, token: string): Promise<T> {
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
    // IxaError 构造需要 ErrorCode 类型；这里从字符串安全转换
    const err = new IxaError(ErrorCodes.UNKNOWN, `${code} ${message}`);
    throw err;
  }
  return json as T;
}

function errMessage(err: unknown): string {
  if (err instanceof IxaError) return `${err.code} ${err.message}`;
  return String(err);
}

// --- 工具输入 schema（raw shape，SDK 自动转换 JSON Schema） ---

const prepareTaskShape = {
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

const searchContextShape = {
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

const getSourceExcerptShape = {
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

const recordWorkResultShape = {
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

async function main(): Promise<void> {
  const token = resolveToken();
  if (!token) {
    process.stderr.write(
      '[ixaeon-mcp] 缺少令牌：请设置 IXAEON_LOCAL_TOKEN 环境变量，' +
        '或从 IXAEON 桌面端设置页复制 MCP 配置片段。\n',
    );
    process.exit(1);
  }

  const server = new McpServer(
    { name: 'ixaeon', version: '0.1.0' },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

  const call = <T>(path: string, body: unknown) => callDesktop<T>(path, body, token);

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[ixaeon-mcp] 服务已启动（STDIO，转发 127.0.0.1:43191）\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`[ixaeon-mcp] 启动失败: ${String(err)}\n`);
  process.exit(1);
});
