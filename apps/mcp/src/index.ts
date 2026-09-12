import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_SERVER_INSTRUCTIONS } from '@ixaeon/contracts';
import { resolveToken, callDesktop, registerTools } from './shared.js';

/**
 * IXAEON MCP 服务·安装包入口（名称固定为 ixaeon）。
 * STDIO 与编码 AI（如 Codex/Hermes）通信；转发到本机桌面端 HTTP
 * （127.0.0.1:43191，localToken 认证）。
 *
 * 令牌来源（优先级）：
 * 1. 环境变量 IXAEON_LOCAL_TOKEN
 * 2. IXAEON_DATA_DIR/config.json 的 localToken 字段
 * 3. 桌面端默认数据目录 %LOCALAPPDATA%\OMNIX\IXAEON\config.json
 *
 * 不 import @ixaeon/core（原生模块打包问题，见 shared.ts 头注）。
 * 直连数据库模式在仓库场景用 dist/direct.mjs（开发/验证用）。
 */
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
    { name: 'ixaeon', version: '0.2.3' },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

  registerTools(server, <T>(path: string, body: unknown) => callDesktop<T>(path, body, token));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[ixaeon-mcp] 服务已启动（STDIO，转发 127.0.0.1:43191）\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`[ixaeon-mcp] 启动失败: ${String(err)}\n`);
  process.exit(1);
});
