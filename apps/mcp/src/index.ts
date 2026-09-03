import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_SERVER_INSTRUCTIONS } from '@ixaeon/contracts';

/**
 * IXAEON MCP 服务（名称固定为 ixaeon）。
 * 通过 STDIO 与编码 AI（如 Codex）通信，工具实现调用本机 IXAEON HTTP 接口。
 * 工具在 M3 里程碑注册。
 */
async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'ixaeon', version: '0.1.0' },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[ixaeon-mcp] 服务已启动（STDIO）\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`[ixaeon-mcp] 启动失败: ${String(err)}\n`);
  process.exit(1);
});
