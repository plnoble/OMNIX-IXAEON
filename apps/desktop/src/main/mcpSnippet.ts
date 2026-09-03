import { dirname, resolve } from 'node:path';

/**
 * MCP 配置片段生成（Codex CLI / 桌面端 / IDE 共用本机配置）。
 * 片段带 IXAEON_LOCAL_TOKEN 环境变量（localToken），复制即用。
 */
export function getMcpSnippet(
  execPath: string,
  localToken: string | null,
): {
  serverName: string;
  command: string;
  args: string[];
  snippet: string;
  localToken: string | null;
} {
  // 开发模式运行源码（out/main → 仓库根/apps/mcp/dist）；
  // 打包后 exe 同级 resources/mcp/index.mjs。
  const isPackaged = !execPath.includes('node_modules') && !execPath.includes('apps');
  const mcpEntry = isPackaged
    ? resolve(execPath, '..', 'resources', 'mcp', 'index.mjs')
    : resolve(dirname(execPath), '..', '..', '..', 'apps', 'mcp', 'dist', 'index.mjs');
  const command = 'node';
  const args = [mcpEntry];
  const tokenLine =
    localToken !== null ? `,\n      "env": { "IXAEON_LOCAL_TOKEN": "${localToken}" }` : '';
  const snippet = [
    '{',
    `  "mcpServers": {`,
    `    "ixaeon": {`,
    `      "command": "${command.replace(/\\/g, '\\\\')}",`,
    `      "args": ["${mcpEntry.replace(/\\/g, '\\\\')}"]${tokenLine}`,
    `    }`,
    `  }`,
    '}',
  ].join('\n');
  return { serverName: 'ixaeon', command, args, snippet, localToken };
}
