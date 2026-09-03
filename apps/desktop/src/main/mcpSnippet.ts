import { resolve } from 'node:path';

/** MCP 配置片段生成（Codex CLI / 桌面端 / IDE 共用本机配置）。 */
export function getMcpSnippet(execPath: string): {
  serverName: string;
  command: string;
  args: string[];
  snippet: string;
} {
  // 开发模式运行源码；打包后运行 dist 产物。electron 打包后 exe 同目录的 mcp 入口。
  const isPackaged = !execPath.includes('node_modules');
  const command = isPackaged ? 'node' : 'node';
  const mcpEntry = isPackaged
    ? resolve(execPath, '..', 'resources', 'mcp', 'index.mjs')
    : resolve(process.cwd(), 'apps', 'mcp', 'dist', 'index.mjs');
  const args = [mcpEntry];
  const snippet = [
    '{',
    `  "mcpServers": {`,
    `    "ixaeon": {`,
    `      "command": "${command.replace(/\\/g, '\\\\')}",`,
    `      "args": ["${mcpEntry.replace(/\\/g, '\\\\')}"]`,
    `    }`,
    `  }`,
    '}',
  ].join('\n');
  return { serverName: 'ixaeon', command, args, snippet };
}
