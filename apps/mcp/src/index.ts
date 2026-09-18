import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  HERMES_BRIDGE_MCP_TOKEN_ENV,
  HERMES_BRIDGE_SERVER,
  MCP_SERVER_INSTRUCTIONS,
} from '@ixaeon/contracts';
import {
  HERMES_BRIDGE_INSTRUCTIONS,
  callDesktop,
  callHermesBridge,
  registerHermesBridgeTools,
  registerTools,
  resolveToken,
} from './shared.js';

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
/**
 * 记忆桥模式（IXAEON_MCP_PROFILE=hermes，由 Hermes 的 mcp_servers.ixaeon 启动）。
 * 令牌只从 IXAEON_HERMES_TOKEN 取，**绝不回退**到 config.json 的 localToken——
 * 那是编码客户端的凭证（受众 coding_client），不能落到聊天引擎手里。
 * Hermes 配置里写的是 ${IXAEON_HERMES_BRIDGE_TOKEN} 占位符：记忆桥关着时 IXAEON 不传
 * 这个变量，占位符原样到这里，直接拒绝启动。
 */
async function mainHermesBridge(): Promise<void> {
  const token = (process.env[HERMES_BRIDGE_MCP_TOKEN_ENV] ?? '').trim();
  if (!token || token.includes('${')) {
    process.stderr.write(
      '[ixaeon-mcp] 记忆桥未开启（没有拿到 Hermes 专用令牌）。在 IXAEON 设置页打开「记忆桥」后重开对话。\n',
    );
    process.exit(1);
  }
  const server = new McpServer(
    { name: HERMES_BRIDGE_SERVER, version: '0.3.0' },
    { instructions: HERMES_BRIDGE_INSTRUCTIONS },
  );
  registerHermesBridgeTools(server, <T>(name: string, args: Record<string, unknown>) =>
    callHermesBridge<T>(name, args, token),
  );
  await server.connect(new StdioServerTransport());
  process.stderr.write('[ixaeon-mcp] 记忆桥已启动（STDIO，转发 127.0.0.1:43191）\n');
}

async function main(): Promise<void> {
  if (process.env.IXAEON_MCP_PROFILE === 'hermes') return mainHermesBridge();
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
