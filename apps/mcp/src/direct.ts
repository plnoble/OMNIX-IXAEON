import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCodes, IxaError, MCP_SERVER_INSTRUCTIONS } from '@ixaeon/contracts';
import { openDatabase, McpService } from '@ixaeon/core';
import {
  type PrepareTaskInput,
  type RecordWorkResultInput,
  type SearchContextInput,
} from '@ixaeon/contracts';
import { registerTools } from './shared.js';

/**
 * IXAEON MCP 服务·直连入口（仓库/验证场景，dist/direct.mjs）。
 * 环境变量 IXAEON_MCP_DB_PATH 指向 IXAEON 数据库文件：进程内直接打开
 * （McpService），不经桌面端 HTTP。适用于无头桥接（如专属 Hermes 的
 * mcp_servers）与隔离验证——进程边界即权限边界。
 *
 * 不打入安装包（extraResources 排除）：better-sqlite3 是原生模块，
 * 运行时从本包 node_modules 解析，仓库/开发环境以外不可用；
 * 生产链路用 index.mjs（HTTP 转发 + localToken）。
 */
async function callDirect<T>(mcp: McpService, path: string, body: unknown): Promise<T> {
  switch (path) {
    case '/api/mcp/prepare-task':
      return mcp.prepareTask(body as PrepareTaskInput) as T;
    case '/api/mcp/search-context':
      return mcp.searchContext(body as SearchContextInput) as T;
    case '/api/mcp/get-source-excerpt': {
      const args = body as { ref: string; max_chars: number };
      return mcp.getSourceExcerpt(args.ref, args.max_chars) as T;
    }
    case '/api/mcp/record-work-result':
      return mcp.recordWorkResult(body as RecordWorkResultInput) as T;
    default:
      throw new IxaError(ErrorCodes.UNKNOWN, `未知 MCP 端点：${path}`);
  }
}

async function main(): Promise<void> {
  const dbPath = process.env.IXAEON_MCP_DB_PATH?.trim();
  if (!dbPath) {
    process.stderr.write('[ixaeon-mcp] 直连入口需要 IXAEON_MCP_DB_PATH 指向 IXAEON 数据库文件。\n');
    process.exit(1);
  }

  const server = new McpServer(
    { name: 'ixaeon', version: '0.2.3' },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

  const mcp = new McpService(openDatabase(dbPath));
  registerTools(server, <T>(path: string, body: unknown) => callDirect<T>(mcp, path, body));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[ixaeon-mcp] 服务已启动（STDIO，直连数据库：${dbPath}）\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`[ixaeon-mcp] 启动失败: ${String(err)}\n`);
  process.exit(1);
});
